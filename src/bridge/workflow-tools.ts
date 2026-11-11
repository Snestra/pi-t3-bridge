import { randomUUID } from "node:crypto";

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  arr,
  bool,
  compile,
  int,
  nullable,
  obj,
  oneOf,
  opt,
  str,
  unknown,
} from "@earendil-works/pi-schema";

import { registerUnlessTaken } from "./claim.ts";
import { t3Json } from "./t3-json.ts";
import { findT3Tool } from "./t3-tasks.ts";
import { createWorkflowStore } from "./workflow-store.ts";
import type { Workflow, WorkflowDefinition } from "./workflow.ts";
import {
  cancelWorkflowStep,
  finishWorkflowStep,
  integrateWorkflowStep,
  launchWorkflowStep,
  recordWorkflowLaunch,
  reconcileWorkflowLaunch,
  retryWorkflowStep,
  resumeWorkflowStep,
  waitWorkflowStep,
} from "./workflow.ts";

interface Ref {
  workflowId: string;
  revision: number;
  stepId: string;
}

type Action = Ref & {
  action:
    | "start"
    | "finish"
    | "retry"
    | "cancel"
    | "integrate"
    | "wait"
    | "resume";
  decision?: string;
  outcome?: "succeeded" | "failed" | "cancelled";
  summary?: string;
  evidence?: { id: string; value: string }[];
  artifacts?: string[];
  childLink?: string;
  checkout?: string;
  integrationStepId?: string;
  integrationEvidence?: string;
};

interface ChildStatus {
  taskId: string;
  status: string;
  workState: string;
  hasPendingChildRuns: boolean;
  summary?: string | null;
  link?: string | null;
  checkout?: string | null;
}

const id = str({ minLength: 1 });
const ref = { revision: int({ minimum: 0 }), stepId: id, workflowId: id };

const result = (value: Workflow) => ({
  content: [{ text: JSON.stringify(value), type: "text" as const }],
  details: value,
});

const stepSchema = obj({
  acceptance: arr(id),
  dependencies: arr(id),
  executor: obj({
    isolation: oneOf(["shared", "worktree", "read-only"]),
    kind: oneOf(["local", "delegated"]),
  }),
  id,
  integrates: opt(arr(id)),
  purpose: id,
});

const child = compile(obj({ taskId: id }, { open: true }));

const status = compile(
  obj(
    {
      checkout: opt(nullable(str())),
      hasPendingChildRuns: bool(),
      link: opt(nullable(str())),
      status: str(),
      summary: opt(nullable(str())),
      taskId: id,
      workState: str(),
    },
    { open: true }
  )
);

export const registerWorkflowTools = (pi: ExtensionAPI): void => {
  const store = createWorkflowStore(pi);
  pi.on("session_start", async (_event, ctx) => {
    await Promise.all(
      store.list(ctx).map(async (workflow) => {
        try {
          await store.recover(ctx, workflow.id);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "Workflow belongs to another session or branch"
          ) {
            throw error;
          }
        }
      })
    );
  });
  registerUnlessTaken(
    pi,
    defineTool({
      description: "Create a workflow with explicit limits and steps.",
      execute: async (
        _call,
        params: Omit<WorkflowDefinition, "owner">,
        _signal,
        _update,
        ctx
      ) => result(await store.create(ctx, params)),
      label: "Create workflow",
      name: "create_workflow",
      parameters: obj({
        concurrency: int({ minimum: 1 }),
        goalId: opt(id),
        id,
        maxAttempts: int({ minimum: 1 }),
        steps: arr(stepSchema, { minItems: 1 }),
      }),
    })
  );
  registerUnlessTaken(
    pi,
    defineTool({
      description: "Read a workflow.",
      execute: async (
        _call,
        params: { workflowId: string },
        _signal,
        _update,
        ctx
      ) => {
        const w = store.read(ctx, params.workflowId);

        if (!w) {
          throw new Error("Unknown workflow");
        }

        return result(w);
      },
      label: "Get workflow",
      name: "get_workflow",
      parameters: obj({ workflowId: id }),
    })
  );
  registerUnlessTaken(
    pi,
    defineTool({
      description: "Launch a delegated workflow step.",
      execute: async (
        _call,
        params: Ref & { task: string; target?: unknown },
        _signal,
        _update,
        ctx
      ) => {
        const current = store.read(ctx, params.workflowId);
        const step = current?.steps.find((s) => s.id === params.stepId);

        if (
          !step ||
          step.executor.kind !== "delegated" ||
          step.executor.isolation === "read-only"
        ) {
          throw new Error("A delegated shared or worktree step is required");
        }

        const name = findT3Tool(ctx.tools, "delegate_task");

        if (!name) {
          throw new Error("T3 delegate_task unavailable");
        }

        const requestId = randomUUID();

        return result(
          await store.launch(
            ctx,
            params.workflowId,
            params.revision,
            params.stepId,
            requestId,
            async () => {
              const response = await ctx.executeTool(name, {
                clientRequestId: requestId,
                isolation: step.executor.isolation,
                mode: "async",
                target: params.target,
                task: params.task,
              });

              return response.isError
                ? undefined
                : t3Json(child, response.result);
            }
          )
        );
      },
      label: "Launch workflow step",
      name: "launch_workflow_step",
      parameters: obj({ ...ref, target: opt(unknown()), task: id }),
    })
  );
  registerUnlessTaken(
    pi,
    defineTool({
      description: "Resolve an unknown launch after checking T3.",
      execute: async (
        _call,
        p: Ref & { resolution: "started" | "not_started"; taskId?: string },
        _signal,
        _update,
        ctx
      ) => {
        const current = store.read(ctx, p.workflowId);

        if (!current) {
          throw new Error("Unknown workflow");
        }

        store.assertOwner(ctx, current);

        if (current.revision !== p.revision) {
          throw new Error("Workflow revision conflict");
        }

        const attempt = current.steps
          .find((step) => step.id === p.stepId)
          ?.attempts.at(-1);

        if (attempt?.launch !== "unknown") {
          throw new Error("Launch is not unknown");
        }

        if (
          !ctx.hasUI ||
          !(await ctx.ui.confirm(
            "Resolve unknown workflow launch",
            `Attempt ${attempt.requestId}. Confirm you checked T3 and verified ${p.resolution === "started" ? `child ${p.taskId} belongs to this attempt` : "no child was launched; a later retry may spend money"}.`
          ))
        ) {
          throw new Error("Launch remains held for user review");
        }

        if (p.resolution === "started") {
          if (!p.taskId) {
            throw new Error("taskId required");
          }

          const name = findT3Tool(ctx.tools, "task_status");

          if (!name) {
            throw new Error("T3 task_status unavailable");
          }

          const response = await ctx.executeTool(name, { taskId: p.taskId });

          if (
            response.isError ||
            t3Json(child, response.result)?.taskId !== p.taskId
          ) {
            throw new Error("Task not confirmed by T3");
          }
        }

        return result(
          await store.transition(ctx, p.workflowId, p.revision, (w) =>
            reconcileWorkflowLaunch(
              w,
              { owner: w.owner, revision: w.revision },
              p.stepId,
              p.resolution === "started"
                ? { childTaskId: p.taskId, kind: "started" }
                : { kind: "not_started" }
            )
          )
        );
      },
      label: "Reconcile workflow step",
      name: "reconcile_workflow_step",
      parameters: obj({
        ...ref,
        resolution: oneOf(["started", "not_started"]),
        taskId: opt(id),
      }),
    })
  );
  registerUnlessTaken(
    pi,
    defineTool({
      description:
        "Start a local step, finish with evidence, retry, cancel, or integrate output.",
      execute: async (_call, p: Action, _signal, _update, ctx) => {
        const current = store.read(ctx, p.workflowId);
        const step = current?.steps.find((s) => s.id === p.stepId);

        if (!current || !step) {
          throw new Error("Unknown workflow or step");
        }

        store.assertOwner(ctx, current);

        if (current.revision !== p.revision) {
          throw new Error("Workflow revision conflict");
        }

        if (p.action === "start") {
          if (step.executor.kind !== "local") {
            throw new Error("Only local steps can start here");
          }

          const intent = await store.transition(
            ctx,
            p.workflowId,
            p.revision,
            (w) =>
              launchWorkflowStep(
                w,
                { owner: w.owner, revision: w.revision },
                p.stepId,
                randomUUID()
              )
          );

          return result(
            await store.transition(ctx, p.workflowId, intent.revision, (w) =>
              recordWorkflowLaunch(
                w,
                { owner: w.owner, revision: w.revision },
                p.stepId,
                { kind: "started" }
              )
            )
          );
        }

        let childStatus: ChildStatus | undefined;

        if (p.action === "finish" && step.executor.kind === "delegated") {
          const taskId = step.attempts.at(-1)?.childTaskId;
          const name = findT3Tool(ctx.tools, "task_status");

          if (!taskId || !name) {
            throw new Error("Saved child task and T3 task_status required");
          }

          const response = await ctx.executeTool(name, { taskId });

          if (response.isError) {
            throw new TypeError("T3 task_status failed");
          }

          childStatus = t3Json(status, response.result);

          if (
            !childStatus ||
            childStatus.taskId !== taskId ||
            childStatus.workState !== "result_available" ||
            childStatus.hasPendingChildRuns
          ) {
            throw new Error("Child is not terminal or has pending descendants");
          }
        }

        return result(
          await store.transition(ctx, p.workflowId, p.revision, (w) => {
            const guard = { owner: w.owner, revision: w.revision };

            switch (p.action) {
              case "wait": {
                return waitWorkflowStep(w, guard, p.stepId, p.decision ?? "");
              }

              case "resume": {
                return resumeWorkflowStep(w, guard, p.stepId);
              }

              case "retry": {
                return retryWorkflowStep(w, guard, p.stepId);
              }

              case "cancel": {
                return cancelWorkflowStep(w, guard, p.stepId);
              }

              case "integrate": {
                return integrateWorkflowStep(
                  w,
                  guard,
                  p.stepId,
                  p.integrationStepId ?? "",
                  p.integrationEvidence ?? ""
                );
              }

              case "finish": {
                if (!p.outcome) {
                  throw new Error("Outcome required");
                }

                return finishWorkflowStep(
                  w,
                  guard,
                  p.stepId,
                  p.outcome,
                  {
                    artifacts: p.artifacts ?? [],
                    checkout: childStatus?.checkout ?? p.checkout,
                    childLink: childStatus?.link ?? p.childLink,
                    evidence: Object.fromEntries(
                      (p.evidence ?? []).map((e) => [e.id, e.value])
                    ),
                    summary: childStatus?.summary ?? p.summary ?? "",
                  },
                  childStatus
                );
              }

              default: {
                throw new Error("Unsupported action");
              }
            }
          })
        );
      },
      label: "Transition workflow",
      name: "transition_workflow",
      parameters: obj({
        ...ref,
        action: oneOf([
          "start",
          "finish",
          "retry",
          "cancel",
          "integrate",
          "wait",
          "resume",
        ]),
        artifacts: opt(arr(str())),
        checkout: opt(str()),
        childLink: opt(str()),
        decision: opt(id),
        evidence: opt(arr(obj({ id, value: id }))),
        integrationEvidence: opt(id),
        integrationStepId: opt(id),
        outcome: opt(oneOf(["succeeded", "failed", "cancelled"])),
        summary: opt(str()),
      }),
    })
  );
};
