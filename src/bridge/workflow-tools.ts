import { randomUUID } from "node:crypto";

import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
import { findT3Tool, taskOutcome, validateTaskTarget } from "./t3-tasks.ts";
import { observeWorkflowChild } from "./workflow-execution.ts";
import { workflowTargetSchema } from "./workflow-schema.ts";
import type { createWorkflowStore } from "./workflow-store.ts";
import type {
  Workflow,
  WorkflowDefinition,
  WorkflowTarget,
  WorkflowTask,
} from "./workflow.ts";
import {
  cancelWorkflowStep,
  finishWorkflowStep,
  integrateWorkflowStep,
  launchWorkflowStep,
  recordWorkflowLaunch,
  recordWorkflowTask,
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
  hasPendingQuestion?: boolean;
  pendingApproval?: unknown;
  summary?: string | null;
  link?: string;
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

const status = compile(
  obj(
    {
      checkout: opt(nullable(str())),
      hasPendingChildRuns: bool(),
      hasPendingQuestion: opt(bool()),
      link: opt(nullable(str())),
      pendingApproval: opt(unknown()),
      status: str(),
      summary: opt(nullable(str())),
      taskId: id,
      workState: str(),
    },
    { open: true }
  )
);

const completeChild = (task: WorkflowTask | undefined): task is ChildStatus =>
  status.check(task) &&
  task.workState === "result_available" &&
  !task.hasPendingChildRuns &&
  !task.hasPendingQuestion &&
  !task.pendingApproval;

export const registerWorkflowTools = (
  pi: ExtensionAPI,
  store: ReturnType<typeof createWorkflowStore>,
  authorize: (ctx: ExtensionContext, workflow: Workflow) => void
): void => {
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
        params: Ref & { task: string; target?: WorkflowTarget },
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

        if (!current) {
          throw new Error("Unknown workflow");
        }

        store.assertOwner(ctx, current);
        authorize(ctx, current);
        await validateTaskTarget(ctx, params.target);
        const checked = store.read(ctx, params.workflowId);

        if (!checked || checked.revision !== params.revision) {
          throw new Error("Workflow revision conflict");
        }

        store.assertOwner(ctx, checked);
        authorize(ctx, checked);

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

              return taskOutcome(name, response.result, response.isError);
            },
            { isolation: step.executor.isolation, target: params.target },
            (latest) => authorize(ctx, latest)
          )
        );
      },
      label: "Launch workflow step",
      name: "launch_workflow_step",
      parameters: obj({ ...ref, target: opt(workflowTargetSchema), task: id }),
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

        return result(
          await store.effect(
            ctx,
            p.workflowId,
            p.revision,
            async (w, commit) => {
              if (p.resolution === "not_started") {
                return commit(
                  reconcileWorkflowLaunch(
                    w,
                    { owner: w.owner, revision: w.revision },
                    p.stepId,
                    { kind: "not_started" }
                  )
                );
              }

              const name = findT3Tool(ctx.tools, "task_status");

              if (!name || !p.taskId) {
                throw new Error("Saved child and T3 task_status required");
              }

              store.assertOwner(ctx, w);

              const response = await ctx.executeTool(name, {
                taskId: p.taskId,
              });

              const task = taskOutcome(name, response.result, response.isError);

              if (!task || task.taskId !== p.taskId) {
                throw new Error("Task not confirmed by T3");
              }

              const resolved = commit(
                reconcileWorkflowLaunch(
                  w,
                  { owner: w.owner, revision: w.revision },
                  p.stepId,
                  { childTaskId: task.taskId, kind: "started" }
                )
              );

              return commit(
                recordWorkflowTask(
                  resolved,
                  { owner: resolved.owner, revision: resolved.revision },
                  p.stepId,
                  task
                )
              );
            }
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

          return result(
            await store.effect(
              ctx,
              p.workflowId,
              p.revision,
              async (w, commit) => {
                authorize(ctx, w);

                const intent = commit(
                  launchWorkflowStep(
                    w,
                    { owner: w.owner, revision: w.revision },
                    p.stepId,
                    randomUUID()
                  )
                );

                return commit(
                  recordWorkflowLaunch(
                    intent,
                    { owner: intent.owner, revision: intent.revision },
                    p.stepId,
                    { kind: "started" }
                  )
                );
              }
            )
          );
        }

        let childStatus: ChildStatus | undefined;
        let { revision } = p;

        if (
          (p.action === "finish" || p.action === "cancel") &&
          step.executor.kind === "delegated" &&
          step.attempts.at(-1)?.childTaskId
        ) {
          const saved = await observeWorkflowChild(
            ctx,
            store,
            current,
            step.id,
            p.action === "cancel"
          );

          if (p.action === "cancel") {
            return result(saved);
          }

          ({ revision } = saved);

          const task = saved.steps
            .find((item) => item.id === step.id)
            ?.attempts.at(-1)?.task;

          if (!completeChild(task)) {
            return result(saved);
          }

          childStatus = task;
        }

        const childLink =
          step.executor.kind === "delegated"
            ? (childStatus?.link ?? undefined)
            : p.childLink;

        return result(
          await store.transition(ctx, p.workflowId, revision, (w) => {
            const guard = { owner: w.owner, revision: w.revision };

            if (["retry", "resume"].includes(p.action)) {
              authorize(ctx, w);
            }

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
                    childLink,
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
