import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { savedWorkflow, workflowOwnerCheckpoint } from "./workflow-schema.ts";
import {
  createWorkflow,
  launchWorkflowStep,
  recordWorkflowLaunch,
  recordWorkflowTask,
  workflowAccepted,
} from "./workflow.ts";
import type {
  Workflow,
  WorkflowDefinition,
  WorkflowTarget,
  WorkflowTask,
} from "./workflow.ts";

const ENTRY = "t3.workflow.v1";

interface Saved {
  version: 1;
  workflow: Workflow;
}

export const listWorkflows = (ctx: ExtensionContext): Workflow[] => {
  const workflows = new Map<string, Workflow>();

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY) {
      continue;
    }

    const saved = entry.data;

    if (!savedWorkflow.check(saved)) {
      throw new Error("Unsupported workflow entry");
    }

    workflows.set(saved.workflow.id, saved.workflow);
  }

  return structuredClone([...workflows.values()]);
};

export const readWorkflow = (
  ctx: ExtensionContext,
  id: string
): Workflow | undefined =>
  listWorkflows(ctx).find((workflow) => workflow.id === id);

export const unfinishedWorkflows = (
  ctx: ExtensionContext,
  goalId?: string
): Workflow[] =>
  listWorkflows(ctx).filter(
    (workflow) =>
      (goalId === undefined || workflow.goalId === goalId) &&
      !workflowAccepted(workflow)
  );

const assertOwner = (ctx: ExtensionContext, workflow: Workflow): void => {
  const branch = ctx.sessionManager.getBranch();
  const entries = ctx.sessionManager.getEntries();
  const active = new Set(branch.map((entry) => entry.id));

  const checkpoint = entries.findLast(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "t3.workflow.owner.v1" &&
      workflowOwnerCheckpoint.check(entry.data) &&
      entry.data.branchId === workflow.owner.branchId &&
      entry.data.sessionId === workflow.owner.sessionId
  );

  const leaf =
    checkpoint?.type === "custom" &&
    workflowOwnerCheckpoint.check(checkpoint.data)
      ? checkpoint.data.leafId
      : workflow.owner.branchId;

  const latest = entries.findLast(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === ENTRY &&
      savedWorkflow.check(entry.data) &&
      entry.data.workflow.id === workflow.id
  );

  if (
    workflow.owner.sessionId !== ctx.sessionManager.getSessionId() ||
    !active.has(leaf) ||
    !latest ||
    !active.has(latest.id)
  ) {
    throw new Error("Workflow belongs to another session or branch");
  }
};

const assertSharedCheckout = (ctx: ExtensionContext, next: Workflow): void => {
  const workflows = [
    ...listWorkflows(ctx).filter((item) => item.id !== next.id),
    next,
  ];

  const writers = workflows
    .flatMap((item) => item.steps)
    .filter(
      (step) =>
        step.executor.isolation === "shared" &&
        ["running", "waiting_for_child", "waiting_for_user"].includes(
          step.state
        )
    );

  if (writers.length > 1) {
    throw new Error("Another workflow owns the shared checkout");
  }
};

export const createWorkflowStore = (pi: ExtensionAPI) => {
  let queue = Promise.resolve(null);
  let operations = 0;

  const serialize = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    operations += 1;
    const previous = queue;
    const lock = Promise.withResolvers<null>();
    queue = lock.promise;
    await previous;

    try {
      return await fn();
    } finally {
      operations -= 1;
      lock.resolve(null);
    }
  };

  const save = (workflow: Workflow) => {
    if (!savedWorkflow.check({ version: 1, workflow })) {
      throw new Error("Invalid workflow record");
    }

    pi.appendEntry(ENTRY, { version: 1, workflow } satisfies Saved);

    return structuredClone(workflow);
  };

  pi.on("session_before_fork", () =>
    operations > 0 ? { cancel: true } : undefined
  );
  pi.on("session_before_switch", () =>
    operations > 0 ? { cancel: true } : undefined
  );
  pi.on("session_before_tree", (_event, ctx) => {
    if (operations > 0) {
      return { cancel: true };
    }

    const leafId = ctx.sessionManager.getLeafId();

    if (!leafId) {
      return;
    }

    for (const workflow of listWorkflows(ctx)) {
      try {
        assertOwner(ctx, workflow);
      } catch {
        continue;
      }

      pi.appendEntry("t3.workflow.owner.v1", { ...workflow.owner, leafId });
    }
  });

  const effect = (
    ctx: ExtensionContext,
    id: string,
    revision: number,
    run: (
      current: Workflow,
      commit: (next: Workflow) => Workflow
    ) => Promise<Workflow>
  ): Promise<Workflow> =>
    serialize(async () => {
      let current = readWorkflow(ctx, id);

      if (!current) {
        throw new Error("Unknown workflow");
      }

      assertOwner(ctx, current);

      if (current.revision !== revision) {
        throw new Error("Workflow revision conflict");
      }

      const commit = (next: Workflow): Workflow => {
        if (!current) {
          throw new Error("Unknown workflow");
        }

        assertOwner(ctx, current);

        if (
          next.id !== current.id ||
          next.revision !== current.revision + 1 ||
          next.owner.sessionId !== current.owner.sessionId ||
          next.owner.branchId !== current.owner.branchId ||
          !savedWorkflow.check({ version: 1, workflow: next })
        ) {
          throw new Error("Invalid workflow transition");
        }

        assertSharedCheckout(ctx, next);
        current = save(next);

        return structuredClone(current);
      };

      await run(structuredClone(current), commit);

      return structuredClone(current);
    });

  return {
    assertOwner,
    create(
      ctx: ExtensionContext,
      definition: Omit<WorkflowDefinition, "owner">
    ) {
      return serialize(() => {
        if (readWorkflow(ctx, definition.id)) {
          throw new Error("Workflow already exists");
        }

        const leaf = ctx.sessionManager.getLeafId();

        if (!leaf) {
          throw new Error(
            "A session entry is required before creating a workflow"
          );
        }

        return save(
          createWorkflow({
            ...definition,
            owner: {
              branchId: leaf,
              sessionId: ctx.sessionManager.getSessionId(),
            },
          })
        );
      });
    },
    effect,
    launch(
      ctx: ExtensionContext,
      id: string,
      revision: number,
      stepId: string,
      requestId: string,
      execute: () => Promise<WorkflowTask | undefined>,
      requested?: { target?: WorkflowTarget; isolation: "shared" | "worktree" }
    ) {
      return serialize(async () => {
        const current = readWorkflow(ctx, id);

        if (!current) {
          throw new Error("Unknown workflow");
        }

        assertOwner(ctx, current);

        const launching = launchWorkflowStep(
          current,
          { owner: current.owner, revision },
          stepId,
          requestId,
          requested
        );

        assertSharedCheckout(ctx, launching);
        const intent = save(launching);

        let task: WorkflowTask | undefined;

        try {
          task = await execute();
        } catch {
          // A failed transport cannot establish whether T3 started the child.
        }

        assertOwner(ctx, intent);

        const launched = save(
          recordWorkflowLaunch(
            intent,
            { owner: intent.owner, revision: intent.revision },
            stepId,
            task
              ? { childTaskId: task.taskId, kind: "started" }
              : { kind: "unknown" }
          )
        );

        return task
          ? save(
              recordWorkflowTask(
                launched,
                { owner: launched.owner, revision: launched.revision },
                stepId,
                task
              )
            )
          : launched;
      });
    },
    list: listWorkflows,
    read: readWorkflow,
    recover(ctx: ExtensionContext, id: string) {
      return serialize(() => {
        let workflow = readWorkflow(ctx, id);

        if (!workflow) {
          throw new Error("Unknown workflow");
        }

        assertOwner(ctx, workflow);

        for (const step of workflow.steps) {
          if (
            step.state === "running" &&
            step.attempts.at(-1)?.launch === "intent"
          ) {
            workflow = recordWorkflowLaunch(
              workflow,
              { owner: workflow.owner, revision: workflow.revision },
              step.id,
              { kind: "unknown" }
            );
            save(workflow);
          }
        }

        return workflow;
      });
    },
    transition(
      ctx: ExtensionContext,
      id: string,
      revision: number,
      updater: (workflow: Workflow) => Workflow
    ) {
      return serialize(() => {
        const current = readWorkflow(ctx, id);

        if (!current) {
          throw new Error("Unknown workflow");
        }

        assertOwner(ctx, current);

        if (current.revision !== revision) {
          throw new Error("Workflow revision conflict");
        }

        const next = updater(structuredClone(current));

        if (
          next.id !== id ||
          next.revision !== revision + 1 ||
          next.owner.sessionId !== current.owner.sessionId ||
          next.owner.branchId !== current.owner.branchId
        ) {
          throw new Error("Invalid workflow transition");
        }

        assertSharedCheckout(ctx, next);

        return save(next);
      });
    },
    unfinished: unfinishedWorkflows,
  };
};
