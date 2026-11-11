import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createWorkflow, recordWorkflowLaunch } from "./workflow.ts";
import type { Workflow, WorkflowDefinition } from "./workflow.ts";

const ENTRY = "t3.workflow.v1";

interface Saved {
  version: 1;
  workflow: Workflow;
}

export function listWorkflows(ctx: ExtensionContext): Workflow[] {
  const workflows = new Map<string, Workflow>();

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY) {
      continue;
    }

    const saved = entry.data as Saved;

    if (saved?.version !== 1 || saved.workflow?.version !== 1) {
      throw new Error("Unsupported workflow entry");
    }

    workflows.set(saved.workflow.id, saved.workflow);
  }

  return structuredClone([...workflows.values()]);
}

export function readWorkflow(
  ctx: ExtensionContext,
  id: string
): Workflow | undefined {
  return listWorkflows(ctx).find((workflow) => workflow.id === id);
}

export function unfinishedWorkflows(
  ctx: ExtensionContext,
  goalId?: string
): Workflow[] {
  return listWorkflows(ctx).filter(
    (workflow) =>
      (goalId === undefined || workflow.goalId === goalId) &&
      workflow.steps.some(
        (step) =>
          (step.state !== "succeeded" && step.state !== "cancelled") ||
          step.attempts.at(-1)?.result?.integration === "unintegrated"
      )
  );
}

export function createWorkflowStore(pi: ExtensionAPI) {
  let queue = Promise.resolve();

  function serialize<T>(fn: () => T): Promise<T> {
    const result = queue.then(fn);
    queue = result.then(
      () => {},
      () => {}
    );

    return result;
  }

  function assertOwner(ctx: ExtensionContext, workflow: Workflow) {
    const branch = ctx.sessionManager.getBranch();
    const entries = ctx.sessionManager.getEntries();
    const active = new Set(branch.map((entry) => entry.id));

    const origin = entries.findIndex(
      (entry) => entry.id === workflow.owner.branchId
    );

    if (
      workflow.owner.sessionId !== ctx.sessionManager.getSessionId() ||
      origin === -1 ||
      !active.has(workflow.owner.branchId) ||
      entries.slice(origin).some((entry) => !active.has(entry.id))
    ) {
      throw new Error("Workflow belongs to another session or branch");
    }
  }

  function save(workflow: Workflow) {
    pi.appendEntry(ENTRY, { version: 1, workflow } satisfies Saved);

    return structuredClone(workflow);
  }

  return {
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
        return save(next);
      });
    },
    unfinished: unfinishedWorkflows,
  };
}
