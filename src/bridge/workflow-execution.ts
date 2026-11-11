import { isDeepStrictEqual } from "node:util";

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import {
  findT3Tool,
  taskDisposition,
  taskOutcome,
  trackedTasks,
} from "./t3-tasks.ts";
import type { createWorkflowStore } from "./workflow-store.ts";
import {
  finishWorkflowStep,
  recordWorkflowTask,
  requestWorkflowCancellation,
} from "./workflow.ts";
import type { Workflow, WorkflowTask } from "./workflow.ts";

export const attachWorkflowTask = (
  current: Workflow,
  commit: (next: Workflow) => Workflow,
  stepId: string,
  task: WorkflowTask
): Workflow => {
  const attempt = current.steps
    .find((step) => step.id === stepId)
    ?.attempts.at(-1);

  if (isDeepStrictEqual(attempt?.task, task) && !attempt?.cancellationPending) {
    return current;
  }

  const saved = commit(
    recordWorkflowTask(
      current,
      { owner: current.owner, revision: current.revision },
      stepId,
      task
    )
  );

  if (
    attempt?.cancellationPending &&
    task.status === "cancelled" &&
    task.workState === "result_available" &&
    task.hasPendingChildRuns === false &&
    !task.hasPendingQuestion &&
    !task.pendingApproval
  ) {
    return commit(
      finishWorkflowStep(
        saved,
        { owner: saved.owner, revision: saved.revision },
        stepId,
        "cancelled",
        {
          artifacts: [],
          childLink: task.link,
          evidence: {},
          summary: task.summary ?? "",
        },
        {
          ...task,
          hasPendingChildRuns: false,
          status: "cancelled",
          workState: "result_available",
        }
      )
    );
  }

  return saved;
};

export const observeWorkflowChild = (
  ctx: ExtensionToolContext,
  store: ReturnType<typeof createWorkflowStore>,
  workflow: Workflow,
  stepId: string,
  cancel: boolean
): Promise<Workflow> =>
  store.effect(ctx, workflow.id, workflow.revision, async (current, commit) => {
    const attempt = current.steps
      .find((step) => step.id === stepId)
      ?.attempts.at(-1);

    if (!attempt?.childTaskId) {
      throw new Error("Saved child task required");
    }

    const tracked = trackedTasks(ctx.sessionManager.getBranch()).get(
      attempt.childTaskId
    );

    const observed =
      tracked?.task ??
      taskOutcome(
        "task_status",
        { content: [], structuredContent: attempt.task },
        false
      );

    let saved = current;
    const guard = () => ({ owner: saved.owner, revision: saved.revision });

    if (
      observed &&
      !tracked?.needsStatus &&
      taskDisposition(observed) === "finished"
    ) {
      return attachWorkflowTask(saved, commit, stepId, observed);
    }

    if (!cancel && !tracked?.needsStatus) {
      return observed
        ? attachWorkflowTask(saved, commit, stepId, observed)
        : saved;
    }

    if (cancel) {
      saved = commit(requestWorkflowCancellation(saved, guard(), stepId));
    }

    const name = findT3Tool(ctx.tools, cancel ? "task_cancel" : "task_status");

    if (!name) {
      throw new Error("T3 task tool unavailable");
    }

    store.assertOwner(ctx, saved);

    const response = await ctx.executeTool(name, {
      taskId: attempt.childTaskId,
    });

    const task = taskOutcome(name, response.result, response.isError);

    if (!task || task.taskId !== attempt.childTaskId) {
      throw new Error("T3 did not confirm owned child state");
    }

    return attachWorkflowTask(saved, commit, stepId, task);
  });
