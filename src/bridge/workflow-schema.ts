import {
  arr,
  bool,
  compile,
  int,
  lit,
  map,
  nullable,
  obj,
  oneOf,
  opt,
  str,
  unknown,
} from "@earendil-works/pi-schema";

const id = str({ minLength: 1 });
const outcome = oneOf(["succeeded", "failed", "cancelled"]);

const result = obj({
  artifacts: arr(str()),
  checkout: opt(str()),
  childLink: opt(str()),
  evidence: map(str()),
  integration: oneOf(["not_required", "unintegrated", "integrated"]),
  integrationEvidence: opt(obj({ evidence: str(), stepId: id })),
  summary: str(),
});

export const workflowTaskSchema = obj(
  {
    hasPendingChildRuns: opt(bool()),
    hasPendingQuestion: opt(bool()),
    link: opt(str()),
    model: opt(str()),
    options: opt(unknown()),
    pendingApproval: opt(unknown()),
    providerInstanceId: opt(str()),
    resultContextTransferId: opt(nullable(str())),
    status: opt(str()),
    summary: opt(nullable(str())),
    taskId: id,
    workState: opt(str()),
  },
  { open: true }
);

export const workflowTargetSchema = obj(
  {
    model: opt(str()),
    options: opt(unknown()),
    providerInstanceId: opt(str()),
  },
  { open: true }
);

export const workflowSchema = obj({
  concurrency: int({ minimum: 1 }),
  goalId: opt(id),
  id,
  maxAttempts: int({ minimum: 1 }),
  owner: obj({ branchId: id, sessionId: id }),
  revision: int({ minimum: 0 }),
  steps: arr(
    obj({
      acceptance: arr(id, { minItems: 1 }),
      attempts: arr(
        obj({
          cancellationPending: opt(bool()),
          childTaskId: opt(id),
          childTerminal: opt(outcome),
          childTurnEnded: opt(bool()),
          launch: oneOf(["intent", "unknown", "started", "not_started"]),
          requestId: id,
          requestedIsolation: opt(oneOf(["shared", "worktree"])),
          requestedTarget: opt(workflowTargetSchema),
          result: opt(result),
          task: opt(workflowTaskSchema),
        })
      ),
      blocked: opt(obj({ id, kind: oneOf(["dependency", "decision"]) })),
      dependencies: arr(id),
      executor: obj({
        isolation: oneOf(["shared", "worktree", "read-only"]),
        kind: oneOf(["local", "delegated"]),
      }),
      id,
      integrates: opt(arr(id)),
      purpose: id,
      state: oneOf([
        "pending",
        "ready",
        "running",
        "waiting_for_user",
        "waiting_for_child",
        "succeeded",
        "failed",
        "cancelled",
      ]),
    }),
    { minItems: 1 }
  ),
  version: lit(1),
});

export const savedWorkflow = compile(
  obj({ version: lit(1), workflow: workflowSchema })
);

export const workflowOwnerCheckpoint = compile(
  obj({ branchId: id, leafId: id, sessionId: id })
);
