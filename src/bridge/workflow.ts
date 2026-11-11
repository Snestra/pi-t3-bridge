export type WorkflowState = "pending" | "ready" | "running" | "waiting_for_user" | "waiting_for_child" | "succeeded" | "failed" | "cancelled";
export type WorkflowOwner = { sessionId: string; branchId: string };
export type WorkflowExecutor = { kind: "local" | "delegated"; isolation: "shared" | "worktree" | "read-only" };
export type WorkflowResult = {
  summary: string;
  evidence: Record<string, string>;
  artifacts: string[];
  childLink?: string;
  checkout?: string;
  integration: "not_required" | "unintegrated" | "integrated";
};
export type WorkflowAttempt = {
  requestId: string;
  launch: "intent" | "unknown" | "started" | "not_started";
  childTaskId?: string;
  childTurnEnded?: boolean;
  childTerminal?: "succeeded" | "failed" | "cancelled";
  result?: WorkflowResult;
};
export type WorkflowStep = {
  id: string;
  purpose: string;
  dependencies: string[];
  executor: WorkflowExecutor;
  acceptance: string[];
  state: WorkflowState;
  blocked?: { kind: "dependency" | "decision"; id: string };
  attempts: WorkflowAttempt[];
};
export type Workflow = {
  version: 1;
  id: string;
  revision: number;
  goalId?: string;
  owner: WorkflowOwner;
  concurrency: number;
  maxAttempts: number;
  steps: WorkflowStep[];
};
export type WorkflowDefinition = Omit<Workflow, "version" | "revision" | "steps"> & {
  steps: Array<Omit<WorkflowStep, "state" | "blocked" | "attempts">>;
};
export type WorkflowGuard = { owner: WorkflowOwner; revision: number };

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function refresh(workflow: Workflow): void {
  for (const step of workflow.steps) {
    if (step.state !== "pending" && step.state !== "ready") continue;
    const dependency = step.dependencies.map((id) => workflow.steps.find((item) => item.id === id)!).find((item) => item.state !== "succeeded" || item.attempts.at(-1)?.result?.integration === "unintegrated");
    step.state = dependency ? "pending" : "ready";
    step.blocked = dependency ? { kind: "dependency", id: dependency.id } : undefined;
  }
}

export function createWorkflow(definition: WorkflowDefinition): Workflow {
  requireValue(definition.id && definition.owner.sessionId && definition.owner.branchId, "Workflow and owner IDs are required");
  requireValue(Number.isSafeInteger(definition.concurrency) && definition.concurrency > 0 && Number.isSafeInteger(definition.maxAttempts) && definition.maxAttempts > 0, "Explicit positive concurrency and maxAttempts are required");
  const ids = new Set<string>();
  for (const step of definition.steps) {
    requireValue(step.id && step.purpose && !ids.has(step.id), "Step IDs must be unique and nonempty, with a purpose");
    ids.add(step.id);
    requireValue(step.acceptance.every(Boolean) && new Set(step.acceptance).size === step.acceptance.length && step.acceptance.length > 0, "Acceptance IDs must be unique and nonempty");
    requireValue(new Set(step.dependencies).size === step.dependencies.length, "Duplicate dependency");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    requireValue(ids.has(id), `Missing dependency: ${id}`);
    requireValue(!visiting.has(id), `Dependency cycle: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of definition.steps.find((step) => step.id === id)!.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  const workflow: Workflow = { ...structuredClone(definition), version: 1, revision: 0, steps: definition.steps.map((step) => ({ ...structuredClone(step), state: "pending", attempts: [] })) };
  refresh(workflow);
  return workflow;
}

function change(workflow: Workflow, guard: WorkflowGuard, stepId: string, action: (step: WorkflowStep, copy: Workflow) => void): Workflow {
  requireValue(workflow.revision === guard.revision, "Workflow revision conflict");
  requireValue(workflow.owner.sessionId === guard.owner.sessionId && workflow.owner.branchId === guard.owner.branchId, "Workflow owner mismatch");
  const copy = structuredClone(workflow);
  const step = copy.steps.find((item) => item.id === stepId);
  requireValue(step, `Unknown step: ${stepId}`);
  action(step, copy);
  copy.revision++;
  refresh(copy);
  return copy;
}

export function launchWorkflowStep(workflow: Workflow, guard: WorkflowGuard, stepId: string, requestId: string): Workflow {
  return change(workflow, guard, stepId, (step, copy) => {
    requireValue(step.state === "ready", "Step is not ready");
    requireValue(requestId && !copy.steps.some((item) => item.attempts.some((attempt) => attempt.requestId === requestId)), "Request ID must be unique and nonempty");
    requireValue(step.attempts.length < copy.maxAttempts, "Attempt limit reached");
    const active = copy.steps.filter((item) => item.state === "running" || item.state === "waiting_for_child" || (item.state === "waiting_for_user" && item.attempts.at(-1)?.launch === "unknown"));
    requireValue(active.length < copy.concurrency, "Concurrency limit reached");
    requireValue(step.executor.isolation !== "shared" || !active.some((item) => item.executor.isolation === "shared"), "Shared writer already active");
    step.attempts.push({ requestId, launch: "intent" });
    step.state = "running";
  });
}

export function recordWorkflowLaunch(workflow: Workflow, guard: WorkflowGuard, stepId: string, outcome: { kind: "started"; childTaskId?: string } | { kind: "unknown" }): Workflow {
  return change(workflow, guard, stepId, (step) => {
    const attempt = step.attempts.at(-1);
    requireValue(step.state === "running" && attempt?.launch === "intent", "No launch intent");
    if (outcome.kind === "unknown") {
      attempt.launch = "unknown";
      step.state = "waiting_for_user";
      step.blocked = { kind: "decision", id: "launch_reconciliation" };
    } else {
      requireValue(step.executor.kind !== "delegated" || outcome.childTaskId, "Child task ID required");
      attempt.launch = "started";
      attempt.childTaskId = outcome.childTaskId;
      step.state = step.executor.kind === "delegated" ? "waiting_for_child" : "running";
    }
  });
}

export function reconcileWorkflowLaunch(workflow: Workflow, guard: WorkflowGuard, stepId: string, resolution: { kind: "started"; childTaskId?: string } | { kind: "not_started" }): Workflow {
  return change(workflow, guard, stepId, (step) => {
    const attempt = step.attempts.at(-1);
    requireValue(step.state === "waiting_for_user" && attempt?.launch === "unknown", "Launch is not unknown");
    if (resolution.kind === "started") {
      requireValue(step.executor.kind !== "delegated" || resolution.childTaskId, "Child task ID required");
      attempt.launch = "started";
      attempt.childTaskId = resolution.childTaskId;
      step.state = step.executor.kind === "delegated" ? "waiting_for_child" : "running";
    } else {
      attempt.launch = "not_started";
      step.state = "failed";
    }
    step.blocked = undefined;
  });
}

export function recordChildTurnEnded(workflow: Workflow, guard: WorkflowGuard, stepId: string): Workflow {
  return change(workflow, guard, stepId, (step) => {
    requireValue(step.state === "waiting_for_child", "No active child");
    step.attempts.at(-1)!.childTurnEnded = true;
  });
}

export function finishWorkflowStep(workflow: Workflow, guard: WorkflowGuard, stepId: string, outcome: "succeeded" | "failed" | "cancelled", result: Omit<WorkflowResult, "integration">): Workflow {
  return change(workflow, guard, stepId, (step) => {
    const attempt = step.attempts.at(-1);
    requireValue(attempt?.launch === "started" && (step.state === "running" || step.state === "waiting_for_child"), "No active attempt");
    if (outcome === "succeeded") requireValue(step.acceptance.every((id) => typeof result.evidence[id] === "string" && result.evidence[id].trim()), "All acceptance conditions need evidence");
    if (step.executor.kind === "delegated") attempt.childTerminal = outcome;
    attempt.result = { ...structuredClone(result), integration: step.executor.isolation === "worktree" ? "unintegrated" : "not_required" };
    step.state = outcome;
  });
}

export function integrateWorkflowStep(workflow: Workflow, guard: WorkflowGuard, stepId: string): Workflow {
  return change(workflow, guard, stepId, (step) => {
    const result = step.attempts.at(-1)?.result;
    requireValue(step.state === "succeeded" && result?.integration === "unintegrated", "No successful worktree output to integrate");
    result.integration = "integrated";
  });
}

export function retryWorkflowStep(workflow: Workflow, guard: WorkflowGuard, stepId: string): Workflow {
  return change(workflow, guard, stepId, (step, copy) => {
    requireValue((step.state === "failed" || step.state === "cancelled") && step.attempts.length < copy.maxAttempts, "Step cannot be retried");
    step.state = "pending";
  });
}

export function cancelWorkflowStep(workflow: Workflow, guard: WorkflowGuard, stepId: string): Workflow {
  return change(workflow, guard, stepId, (step) => {
    requireValue(step.state === "pending" || step.state === "ready", "Only unstarted steps can be cancelled");
    step.state = "cancelled";
    step.blocked = undefined;
  });
}
