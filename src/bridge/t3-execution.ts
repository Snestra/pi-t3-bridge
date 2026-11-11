import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { GoalIdentity } from "./resume.ts";
import { callT3Tool } from "./t3-http.ts";
import { taskDisposition, taskOutcome, trackedTasks } from "./t3-tasks.ts";
import type { GoalExecutionState, OwnedChild } from "./t3-tasks.ts";
import { attachWorkflowTask } from "./workflow-execution.ts";
import type { createWorkflowStore } from "./workflow-store.ts";
import { requestWorkflowCancellation } from "./workflow.ts";
import type { Workflow, WorkflowAttempt } from "./workflow.ts";

export interface GoalAccess {
  readonly read: (
    ctx: ExtensionContext
  ) => { id: string; revision: number; status: string } | null;
  readonly allows: (ctx: ExtensionContext, identity: GoalIdentity) => boolean;
}

type Store = ReturnType<typeof createWorkflowStore>;

type Commit = (next: Workflow) => Workflow;

const pausedGoal = (
  ctx: ExtensionContext,
  identity: GoalIdentity,
  goals: GoalAccess,
  exact: boolean
): void => {
  const goal = goals.read(ctx);

  if (
    !goal ||
    goal.id !== identity.id ||
    goal.status !== "paused" ||
    (exact && goal.revision !== identity.revision)
  ) {
    throw new Error("The same goal must remain paused");
  }
};

const snapshotChild = (
  workflow: Workflow,
  stepId: string,
  attempt: WorkflowAttempt,
  tasks: ReturnType<typeof trackedTasks>
): OwnedChild => {
  const tracked = attempt.childTaskId
    ? tasks.get(attempt.childTaskId)
    : undefined;

  const task =
    tracked?.task ??
    taskOutcome(
      "task_status",
      { content: [], structuredContent: attempt.task },
      false
    );

  return {
    cancellationPending: attempt.cancellationPending === true,
    disposition: task ? taskDisposition(task) : "unknown",
    needsStatus: tracked?.needsStatus ?? !task,
    requestId: attempt.requestId,
    stepId,
    task,
    taskId: attempt.childTaskId,
    workflowId: workflow.id,
  };
};

const hasExecutionHold = (child: OwnedChild): boolean =>
  child.disposition !== "finished" ||
  child.needsStatus ||
  child.cancellationPending;

export const createT3Execution = (
  pi: ExtensionAPI,
  store: Store,
  goals: GoalAccess
) => {
  const inspectGoal = (
    ctx: ExtensionContext,
    identity: GoalIdentity
  ): GoalExecutionState => {
    const children: OwnedChild[] = [];
    let reason: string | undefined;
    const tasks = trackedTasks(ctx.sessionManager.getBranch());

    try {
      for (const workflow of store
        .list(ctx)
        .filter((item) => item.goalId === identity.id)) {
        try {
          store.assertOwner(ctx, workflow);
        } catch {
          reason = "Workflow ownership must be reconciled";
        }

        for (const step of workflow.steps.filter(
          (item) => item.executor.kind === "delegated"
        )) {
          for (const attempt of step.attempts.filter(
            (item) => item.launch !== "not_started"
          )) {
            children.push(snapshotChild(workflow, step.id, attempt, tasks));
          }
        }
      }
    } catch {
      reason = "Workflow state could not be read";
    }

    return {
      children,
      pending: !!reason || children.some(hasExecutionHold),
      reason,
      reconciliationRequired:
        !!reason ||
        children.some(
          (child) => child.needsStatus || child.disposition === "unknown"
        ),
    };
  };

  const observe = async (
    ctx: ExtensionContext,
    identity: GoalIdentity,
    workflow: Workflow,
    commit: Commit,
    stepId: string,
    mode: "pause" | "reconcile"
  ): Promise<Workflow> => {
    pausedGoal(ctx, identity, goals, mode === "reconcile");
    store.assertOwner(ctx, workflow);

    const step = workflow.steps.find((item) => item.id === stepId);
    const attempt = step?.attempts.at(-1);

    if (!attempt?.childTaskId) {
      return workflow;
    }

    const child = snapshotChild(
      workflow,
      stepId,
      attempt,
      trackedTasks(ctx.sessionManager.getBranch())
    );

    let current = workflow;
    const guard = () => ({ owner: current.owner, revision: current.revision });

    if (
      mode === "pause" &&
      child.disposition === "finished" &&
      !child.needsStatus
    ) {
      return child.task
        ? attachWorkflowTask(current, commit, stepId, child.task)
        : current;
    }

    if (mode === "pause") {
      current = commit(requestWorkflowCancellation(current, guard(), stepId));
    }

    pausedGoal(ctx, identity, goals, mode === "reconcile");
    store.assertOwner(ctx, current);

    const toolName = mode === "pause" ? "task_cancel" : "task_status";

    const response = await callT3Tool(toolName, {
      taskId: attempt.childTaskId,
    });

    const task = taskOutcome(
      toolName,
      { content: [], structuredContent: response },
      false
    );

    if (!task || task.taskId !== attempt.childTaskId) {
      throw new Error("T3 did not confirm the owned task");
    }

    pausedGoal(ctx, identity, goals, mode === "reconcile");
    store.assertOwner(ctx, current);
    pi.appendEntry("pi-t3-task-outcome", {
      task,
      toolCallId: randomUUID(),
      toolName,
    });

    return attachWorkflowTask(current, commit, stepId, task);
  };

  const updateWorkflow = (
    ctx: ExtensionContext,
    identity: GoalIdentity,
    workflow: Workflow,
    mode: "pause" | "reconcile"
  ) =>
    store.effect(ctx, workflow.id, undefined, async (current, commit) => {
      const steps = current.steps.filter(
        (step) =>
          step.executor.kind === "delegated" &&
          step.attempts.at(-1)?.childTaskId
      );

      const visit = async (
        index: number,
        saved: Workflow
      ): Promise<Workflow> => {
        const step = steps[index];

        if (!step) {
          return saved;
        }

        const next = await observe(ctx, identity, saved, commit, step.id, mode);

        return visit(index + 1, next);
      };

      return await visit(0, current);
    });

  const updateGoal = async (
    ctx: ExtensionContext,
    identity: GoalIdentity,
    mode: "pause" | "reconcile"
  ): Promise<void> => {
    pausedGoal(ctx, identity, goals, mode === "reconcile");

    const workflows = store
      .list(ctx)
      .filter((workflow) => workflow.goalId === identity.id);

    const results = await Promise.allSettled(
      workflows.map((workflow) => updateWorkflow(ctx, identity, workflow, mode))
    );

    const failure = results.find((result) => result.status === "rejected");

    if (failure?.status === "rejected") {
      throw new Error("Owned child reconciliation failed", {
        cause: failure.reason,
      });
    }
  };

  return {
    authorize(ctx: ExtensionContext, workflow: Workflow): void {
      store.assertOwner(ctx, workflow);

      if (!workflow.goalId) {
        return;
      }

      const goal = goals.read(ctx);

      if (!goal || goal.id !== workflow.goalId || !goals.allows(ctx, goal)) {
        throw new Error("Goal does not authorize execution");
      }
    },
    inspectGoal,
    async pause(ctx: ExtensionContext, identity: GoalIdentity): Promise<void> {
      await updateGoal(ctx, identity, "pause");
    },
    async reconcile(
      ctx: ExtensionContext,
      identity: GoalIdentity
    ): Promise<{ ready: boolean; reason?: string }> {
      try {
        await updateGoal(ctx, identity, "reconcile");
        pausedGoal(ctx, identity, goals, true);

        const state = inspectGoal(ctx, identity);

        return {
          ready: !state.pending && !state.reconciliationRequired,
          reason:
            state.reason ??
            (state.pending ? "Owned child work remains pending" : undefined),
        };
      } catch (error) {
        return {
          ready: false,
          reason:
            error instanceof Error ? error.message : "Reconciliation failed",
        };
      }
    },
  };
};

export type T3Execution = ReturnType<typeof createT3Execution>;
