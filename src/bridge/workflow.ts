import type { Static } from "@earendil-works/pi-schema";

import type {
  workflowTaskSchema,
  workflowTargetSchema,
} from "./workflow-schema.ts";

export type WorkflowTask = Static<typeof workflowTaskSchema>;

export type WorkflowTarget = Static<typeof workflowTargetSchema>;

export type WorkflowState =
  | "pending"
  | "ready"
  | "running"
  | "waiting_for_user"
  | "waiting_for_child"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface WorkflowOwner {
  sessionId: string;
  branchId: string;
}

export interface WorkflowExecutor {
  kind: "local" | "delegated";
  isolation: "shared" | "worktree" | "read-only";
}

export interface WorkflowResult {
  summary: string;
  evidence: Record<string, string>;
  artifacts: string[];
  childLink?: string;
  checkout?: string;
  integration: "not_required" | "unintegrated" | "integrated";
  integrationEvidence?: { stepId: string; evidence: string };
}

export interface WorkflowAttempt {
  requestId: string;
  requestedTarget?: WorkflowTarget;
  requestedIsolation?: "shared" | "worktree";
  task?: WorkflowTask;
  cancellationPending?: boolean;
  launch: "intent" | "unknown" | "started" | "not_started";
  childTaskId?: string;
  childTurnEnded?: boolean;
  childTerminal?: "succeeded" | "failed" | "cancelled";
  result?: WorkflowResult;
}

export interface WorkflowStep {
  id: string;
  purpose: string;
  dependencies: string[];
  executor: WorkflowExecutor;
  acceptance: string[];
  integrates?: string[];
  state: WorkflowState;
  blocked?: { kind: "dependency" | "decision"; id: string };
  attempts: WorkflowAttempt[];
}

export interface Workflow {
  version: 1;
  id: string;
  revision: number;
  goalId?: string;
  owner: WorkflowOwner;
  concurrency: number;
  maxAttempts: number;
  steps: WorkflowStep[];
}

export type WorkflowDefinition = Omit<
  Workflow,
  "version" | "revision" | "steps"
> & {
  steps: Omit<WorkflowStep, "state" | "blocked" | "attempts">[];
};

export interface WorkflowGuard {
  owner: WorkflowOwner;
  revision: number;
}

const requireValue: <T>(condition: T, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) {
    throw new Error(message);
  }
};

const stepAccepted = (
  step: WorkflowStep,
  allowUnintegrated = false
): boolean => {
  const attempt = step.attempts.at(-1);

  if (
    step.state !== "succeeded" ||
    !attempt?.result ||
    attempt.cancellationPending ||
    (attempt.result.integration === "unintegrated" && !allowUnintegrated)
  ) {
    return false;
  }

  if (!step.acceptance.every((id) => attempt.result?.evidence[id]?.trim())) {
    return false;
  }

  return (
    step.executor.kind === "local" ||
    (attempt.childTerminal === "succeeded" &&
      attempt.task?.status === "completed" &&
      attempt.task.hasPendingChildRuns === false &&
      attempt.task.workState === "result_available" &&
      !attempt.task.hasPendingQuestion &&
      !attempt.task.pendingApproval)
  );
};

const refresh = (workflow: Workflow): void => {
  for (const step of workflow.steps) {
    if (step.state !== "pending" && step.state !== "ready") {
      continue;
    }

    const dependency = step.dependencies
      .flatMap((id) => workflow.steps.filter((item) => item.id === id))
      .find((item) => !stepAccepted(item, step.integrates?.includes(item.id)));

    step.state = dependency ? "pending" : "ready";
    step.blocked = dependency
      ? { id: dependency.id, kind: "dependency" }
      : undefined;
  }
};

const executable = (executor: WorkflowExecutor): boolean =>
  executor.isolation === "shared" ||
  (executor.kind === "delegated" && executor.isolation === "worktree");

export const createWorkflow = (definition: WorkflowDefinition): Workflow => {
  requireValue(
    definition.id && definition.owner.sessionId && definition.owner.branchId,
    "Workflow and owner IDs are required"
  );
  requireValue(
    Number.isSafeInteger(definition.concurrency) &&
      definition.concurrency > 0 &&
      Number.isSafeInteger(definition.maxAttempts) &&
      definition.maxAttempts > 0,
    "Explicit positive concurrency and maxAttempts are required"
  );
  const ids = new Set<string>();

  for (const step of definition.steps) {
    requireValue(
      step.id && step.purpose && !ids.has(step.id),
      "Step IDs must be unique and nonempty, with a purpose"
    );
    ids.add(step.id);
    requireValue(
      executable(step.executor),
      "Local steps use the shared checkout; delegated steps use shared or worktree isolation"
    );
    requireValue(
      (step.integrates ?? []).every((id) => step.dependencies.includes(id)) &&
        (!step.integrates?.length || step.executor.isolation === "shared"),
      "Integration targets must be dependencies of a shared step"
    );
    requireValue(
      step.acceptance.every(Boolean) &&
        new Set(step.acceptance).size === step.acceptance.length &&
        step.acceptance.length > 0,
      "Acceptance IDs must be unique and nonempty"
    );
    requireValue(
      new Set(step.dependencies).size === step.dependencies.length,
      "Duplicate dependency"
    );
  }

  for (const step of definition.steps) {
    requireValue(
      new Set(step.integrates).size === (step.integrates ?? []).length &&
        (step.integrates ?? []).every((id) =>
          definition.steps.some(
            (producer) =>
              producer.id === id && producer.executor.isolation === "worktree"
          )
        ),
      "Integration targets must be distinct worktree producers"
    );
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    requireValue(ids.has(id), `Missing dependency: ${id}`);
    requireValue(!visiting.has(id), `Dependency cycle: ${id}`);

    if (visited.has(id)) {
      return;
    }

    visiting.add(id);

    for (const dependency of definition.steps.find((step) => step.id === id)
      ?.dependencies ?? []) {
      visit(dependency);
    }

    visiting.delete(id);
    visited.add(id);
  };

  for (const id of ids) {
    visit(id);
  }

  const workflow: Workflow = {
    ...structuredClone(definition),
    revision: 0,
    steps: definition.steps.map((step) => ({
      ...structuredClone(step),
      attempts: [],
      state: "pending",
    })),
    version: 1,
  };

  refresh(workflow);

  return workflow;
};

const change = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string,
  action: (step: WorkflowStep, copy: Workflow) => void
): Workflow => {
  requireValue(
    workflow.revision === guard.revision,
    "Workflow revision conflict"
  );
  requireValue(
    workflow.owner.sessionId === guard.owner.sessionId &&
      workflow.owner.branchId === guard.owner.branchId,
    "Workflow owner mismatch"
  );
  const copy = structuredClone(workflow);
  const step = copy.steps.find((item) => item.id === stepId);
  requireValue(step, `Unknown step: ${stepId}`);
  action(step, copy);
  copy.revision += 1;
  refresh(copy);

  return copy;
};

export const launchWorkflowStep = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string,
  requestId: string,
  requested?: { target?: WorkflowTarget; isolation: "shared" | "worktree" }
): Workflow =>
  change(workflow, guard, stepId, (step, copy) => {
    requireValue(step.state === "ready", "Step is not ready");
    requireValue(
      requestId &&
        !copy.steps.some((item) =>
          item.attempts.some((attempt) => attempt.requestId === requestId)
        ),
      "Request ID must be unique and nonempty"
    );
    requireValue(
      step.attempts.length < copy.maxAttempts,
      "Attempt limit reached"
    );

    const active = copy.steps.filter(
      (item) =>
        item.state === "running" ||
        item.state === "waiting_for_child" ||
        item.state === "waiting_for_user"
    );

    requireValue(active.length < copy.concurrency, "Concurrency limit reached");
    requireValue(
      step.executor.isolation !== "shared" ||
        !active.some((item) => item.executor.isolation === "shared"),
      "Shared writer already active"
    );

    if (requested) {
      requireValue(
        requested.isolation === step.executor.isolation,
        "Requested isolation must match the step"
      );
    }

    step.attempts.push({
      launch: "intent",
      requestId,
      requestedIsolation: requested?.isolation,
      requestedTarget: requested?.target,
    });
    step.state = "running";
  });

export const recordWorkflowLaunch = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string,
  outcome: { kind: "started"; childTaskId?: string } | { kind: "unknown" }
): Workflow =>
  change(workflow, guard, stepId, (step) => {
    const attempt = step.attempts.at(-1);
    requireValue(
      step.state === "running" && attempt?.launch === "intent",
      "No launch intent"
    );

    if (outcome.kind === "unknown") {
      attempt.launch = "unknown";
      step.state = "waiting_for_user";
      step.blocked = { id: "launch_reconciliation", kind: "decision" };
    } else {
      requireValue(
        step.executor.kind !== "delegated" || outcome.childTaskId,
        "Child task ID required"
      );
      attempt.launch = "started";
      attempt.childTaskId = outcome.childTaskId;
      step.state =
        step.executor.kind === "delegated" ? "waiting_for_child" : "running";
    }
  });

export const reconcileWorkflowLaunch = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string,
  resolution:
    | { kind: "started"; childTaskId?: string }
    | { kind: "not_started" }
): Workflow =>
  change(workflow, guard, stepId, (step) => {
    const attempt = step.attempts.at(-1);
    requireValue(
      step.state === "waiting_for_user" && attempt?.launch === "unknown",
      "Launch is not unknown"
    );

    if (resolution.kind === "started") {
      requireValue(
        step.executor.kind !== "delegated" || resolution.childTaskId,
        "Child task ID required"
      );
      attempt.launch = "started";
      attempt.childTaskId = resolution.childTaskId;
      step.state =
        step.executor.kind === "delegated" ? "waiting_for_child" : "running";
    } else {
      attempt.launch = "not_started";
      step.state = "failed";
    }

    step.blocked = undefined;
  });

export const recordChildTurnEnded = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string
): Workflow =>
  change(workflow, guard, stepId, (step) => {
    requireValue(step.state === "waiting_for_child", "No active child");
    const attempt = step.attempts.at(-1);
    requireValue(attempt, "Missing child attempt");
    attempt.childTurnEnded = true;
  });

export const finishWorkflowStep = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string,
  outcome: "succeeded" | "failed" | "cancelled",
  result: Omit<WorkflowResult, "integration" | "integrationEvidence">,
  childStatus?: {
    taskId: string;
    status: string;
    workState: string;
    hasPendingChildRuns: boolean;
    hasPendingQuestion?: boolean;
    pendingApproval?: unknown;
  }
): Workflow =>
  change(workflow, guard, stepId, (step) => {
    const attempt = step.attempts.at(-1);
    requireValue(
      attempt?.launch === "started" &&
        (step.state === "running" || step.state === "waiting_for_child"),
      "No active attempt"
    );

    if (outcome === "succeeded") {
      requireValue(
        step.acceptance.every((id) => result.evidence[id]?.trim()),
        "All acceptance conditions need evidence"
      );
    }

    if (step.executor.kind === "delegated") {
      requireValue(
        childStatus !== undefined &&
          childStatus.taskId === attempt.childTaskId &&
          childStatus.hasPendingChildRuns === false &&
          childStatus.workState === "result_available" &&
          !childStatus.hasPendingQuestion &&
          !childStatus.pendingApproval &&
          (childStatus.status ===
            (outcome === "succeeded" ? "completed" : outcome) ||
            (outcome === "cancelled" && childStatus.status === "interrupted")),
        "Authoritative terminal child status with no live child work required"
      );
      attempt.childTerminal = outcome;
      attempt.task = {
        ...attempt.task,
        ...childStatus,
        hasPendingQuestion: childStatus.hasPendingQuestion,
        pendingApproval: childStatus.pendingApproval,
      };
      attempt.cancellationPending = false;
    }

    attempt.result = {
      ...structuredClone(result),
      integration:
        step.executor.isolation === "worktree"
          ? "unintegrated"
          : "not_required",
    };
    step.state = outcome;
  });

export const integrateWorkflowStep = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string,
  integrationStepId: string,
  evidence: string
): Workflow =>
  change(workflow, guard, stepId, (step) => {
    const result = step.attempts.at(-1)?.result;
    requireValue(
      step.state === "succeeded" && result?.integration === "unintegrated",
      "No successful worktree output to integrate"
    );

    const integrationStep = workflow.steps.find(
      (item) => item.id === integrationStepId
    );

    requireValue(
      integrationStepId !== stepId &&
        integrationStep?.state === "succeeded" &&
        integrationStep.executor.isolation === "shared" &&
        integrationStep.integrates?.includes(stepId) &&
        evidence.trim(),
      "A separate successful shared integration step and evidence are required"
    );
    result.integration = "integrated";
    result.integrationEvidence = { evidence, stepId: integrationStepId };
  });

export const workflowAccepted = (workflow: Workflow): boolean =>
  workflow.steps.length > 0 &&
  workflow.steps.every((step) => stepAccepted(step));

export const recordWorkflowTask = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string,
  task: WorkflowTask
): Workflow =>
  change(workflow, guard, stepId, (step) => {
    const attempt = step.attempts.at(-1);
    requireValue(
      attempt?.childTaskId === task.taskId,
      "Task must belong to this attempt"
    );
    requireValue(attempt, "Missing attempt");
    attempt.task = structuredClone(task);

    if (
      [
        "completed",
        "failed",
        "cancelled",
        "interrupted",
        "rolled_back",
      ].includes(task.status ?? "") &&
      task.hasPendingChildRuns === false &&
      task.workState === "result_available"
    ) {
      attempt.cancellationPending = false;
    }
  });

export const requestWorkflowCancellation = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string
): Workflow =>
  change(workflow, guard, stepId, (step) => {
    const attempt = step.attempts.at(-1);
    requireValue(
      attempt?.childTaskId && attempt.launch === "started",
      "Only a known child can be cancelled"
    );
    requireValue(
      !["succeeded", "failed", "cancelled"].includes(step.state),
      "Do not cancel a completed step"
    );
    attempt.cancellationPending = true;
  });

export const retryWorkflowStep = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string
): Workflow =>
  change(workflow, guard, stepId, (step, copy) => {
    requireValue(
      (step.state === "failed" || step.state === "cancelled") &&
        step.attempts.length < copy.maxAttempts,
      "Step cannot be retried"
    );
    step.state = "pending";
  });

export const waitWorkflowStep = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string,
  decision: string
): Workflow =>
  change(workflow, guard, stepId, (step) => {
    requireValue(
      step.state === "running" &&
        step.executor.kind === "local" &&
        step.attempts.at(-1)?.launch === "started",
      "Only an active local step can wait for a decision"
    );
    requireValue(decision.trim(), "Name the decision holding the step");
    step.state = "waiting_for_user";
    step.blocked = { id: decision, kind: "decision" };
  });

export const resumeWorkflowStep = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string
): Workflow =>
  change(workflow, guard, stepId, (step) => {
    requireValue(
      step.state === "waiting_for_user" &&
        step.executor.kind === "local" &&
        step.attempts.at(-1)?.launch === "started",
      "Only a local decision wait can resume"
    );
    step.state = "running";
    step.blocked = undefined;
  });

export const cancelWorkflowStep = (
  workflow: Workflow,
  guard: WorkflowGuard,
  stepId: string
): Workflow =>
  change(workflow, guard, stepId, (step) => {
    requireValue(
      step.state === "pending" || step.state === "ready",
      "Only unstarted steps can be cancelled"
    );
    step.state = "cancelled";
    step.blocked = undefined;
  });
