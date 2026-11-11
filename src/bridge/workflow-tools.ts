import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowDefinition } from "./workflow.ts";
import { arr, bool, compile, int, obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import { registerUnlessTaken } from "./claim.ts";
import { t3Json } from "./t3-json.ts";
import { findT3Tool } from "./t3-tasks.ts";
import { createWorkflowStore } from "./workflow-store.ts";
import { cancelWorkflowStep, finishWorkflowStep, integrateWorkflowStep, launchWorkflowStep, recordWorkflowLaunch, reconcileWorkflowLaunch, retryWorkflowStep } from "./workflow.ts";

type Ref = { workflowId: string; revision: number; stepId: string };
type Action = Ref & { action: "start" | "finish" | "retry" | "cancel" | "integrate"; outcome?: "succeeded" | "failed" | "cancelled"; summary?: string; evidence?: { id: string; value: string }[]; artifacts?: string[]; childLink?: string; checkout?: string; integrationStepId?: string; integrationEvidence?: string };
type ChildStatus = { taskId: string; status: string; workState: string; hasPendingChildRuns: boolean; summary?: string; link?: string; checkout?: string };
const id = str({ minLength: 1 });
const ref = { workflowId: id, revision: int({ minimum: 0 }), stepId: id };
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
const stepSchema = obj({ id, purpose: id, dependencies: arr(id), acceptance: arr(id), integrates: opt(arr(id)), executor: obj({ kind: oneOf(["local", "delegated"]), isolation: oneOf(["shared", "worktree", "read-only"]) }) });
const child = compile(obj({ taskId: id }, { open: true }));
const status = compile(obj({ taskId: id, status: str(), workState: str(), hasPendingChildRuns: bool(), summary: opt(str()), link: opt(str()), checkout: opt(str()) }, { open: true }));

export function registerWorkflowTools(pi: ExtensionAPI): void {
  const store = createWorkflowStore(pi);
  pi.on("session_start", async (_event, ctx) => {
    for (const workflow of store.list(ctx)) {
      try { await store.recover(ctx, workflow.id); } catch (error) {
        if (!(error instanceof Error) || error.message !== "Workflow belongs to another session or branch") throw error;
      }
    }
  });
  registerUnlessTaken(pi, defineTool({ name: "create_workflow", label: "Create workflow", description: "Create a workflow with explicit limits and steps.", parameters: obj({ id, goalId: opt(id), concurrency: int({ minimum: 1 }), maxAttempts: int({ minimum: 1 }), steps: arr(stepSchema, { minItems: 1 }) }), execute: async (_call, params: Omit<WorkflowDefinition, "owner">, _signal, _update, ctx) => result(await store.create(ctx, params)) }));
  registerUnlessTaken(pi, defineTool({ name: "get_workflow", label: "Get workflow", description: "Read a workflow.", parameters: obj({ workflowId: id }), execute: async (_call, params: { workflowId: string }, _signal, _update, ctx) => { const w = store.read(ctx, params.workflowId); if (!w) throw new Error("Unknown workflow"); return result(w); } }));
  registerUnlessTaken(pi, defineTool({ name: "launch_workflow_step", label: "Launch workflow step", description: "Launch a delegated workflow step.", parameters: obj({ ...ref, task: id, target: opt(unknown()) }), execute: async (_call, params: Ref & { task: string; target?: unknown }, _signal, _update, ctx) => {
    const current = store.read(ctx, params.workflowId); const step = current?.steps.find(s => s.id === params.stepId);
    if (!step || step.executor.kind !== "delegated" || step.executor.isolation === "read-only") throw new Error("A delegated shared or worktree step is required");
    const name = findT3Tool(ctx.tools, "delegate_task"); if (!name) throw new Error("T3 delegate_task unavailable");
    const requestId = randomUUID();
    const intent = await store.transition(ctx, params.workflowId, params.revision, w => launchWorkflowStep(w, { owner: w.owner, revision: w.revision }, params.stepId, requestId));
    let taskId: string | undefined;
    try { const response = await ctx.executeTool(name, { task: params.task, target: params.target, isolation: step.executor.isolation, clientRequestId: requestId }); if (!response.isError) taskId = t3Json(child, response.result)?.taskId; } catch { /* launch outcome is unknown */ }
    return result(await store.transition(ctx, params.workflowId, intent.revision, w => recordWorkflowLaunch(w, { owner: w.owner, revision: w.revision }, params.stepId, taskId ? { kind: "started", childTaskId: taskId } : { kind: "unknown" })));
  } }));
  registerUnlessTaken(pi, defineTool({ name: "reconcile_workflow_step", label: "Reconcile workflow step", description: "Resolve an unknown launch after checking T3.", parameters: obj({ ...ref, resolution: oneOf(["started", "not_started"]), taskId: opt(id) }), execute: async (_call, p: Ref & { resolution: "started" | "not_started"; taskId?: string }, _signal, _update, ctx) => {
    if (p.resolution === "started") { if (!p.taskId) throw new Error("taskId required"); const name = findT3Tool(ctx.tools, "task_status"); if (!name) throw new Error("T3 task_status unavailable"); const response = await ctx.executeTool(name, { taskId: p.taskId }); if (response.isError || t3Json(child, response.result)?.taskId !== p.taskId) throw new Error("Task not confirmed by T3"); }
    return result(await store.transition(ctx, p.workflowId, p.revision, w => reconcileWorkflowLaunch(w, { owner: w.owner, revision: w.revision }, p.stepId, p.resolution === "started" ? { kind: "started", childTaskId: p.taskId } : { kind: "not_started" })));
  } }));
  registerUnlessTaken(pi, defineTool({ name: "transition_workflow", label: "Transition workflow", description: "Start a local step, finish with evidence, retry, cancel, or integrate output.", parameters: obj({ ...ref, action: oneOf(["start", "finish", "retry", "cancel", "integrate"]), outcome: opt(oneOf(["succeeded", "failed", "cancelled"])), summary: opt(str()), evidence: opt(arr(obj({ id, value: id }))), artifacts: opt(arr(str())), childLink: opt(str()), checkout: opt(str()), integrationStepId: opt(id), integrationEvidence: opt(id) }), execute: async (_call, p: Action, _signal, _update, ctx) => {
    const current = store.read(ctx, p.workflowId); const step = current?.steps.find(s => s.id === p.stepId); if (!current || !step) throw new Error("Unknown workflow or step");
    if (current.revision !== p.revision) throw new Error("Workflow revision conflict");
    if (p.action === "start") { if (step.executor.kind !== "local") throw new Error("Only local steps can start here"); const intent = await store.transition(ctx, p.workflowId, p.revision, w => launchWorkflowStep(w, { owner: w.owner, revision: w.revision }, p.stepId, randomUUID())); return result(await store.transition(ctx, p.workflowId, intent.revision, w => recordWorkflowLaunch(w, { owner: w.owner, revision: w.revision }, p.stepId, { kind: "started" }))); }
    let childStatus: ChildStatus | undefined;
    if (p.action === "finish" && step.executor.kind === "delegated") { const taskId = step.attempts.at(-1)?.childTaskId; const name = findT3Tool(ctx.tools, "task_status"); if (!taskId || !name) throw new Error("Saved child task and T3 task_status required"); const response = await ctx.executeTool(name, { taskId }); if (response.isError) throw new Error("T3 task_status failed"); childStatus = t3Json(status, response.result); if (!childStatus || childStatus.taskId !== taskId || childStatus.workState !== "result_available" || childStatus.hasPendingChildRuns) throw new Error("Child is not terminal or has pending descendants"); }
    return result(await store.transition(ctx, p.workflowId, p.revision, w => { const guard = { owner: w.owner, revision: w.revision }; switch (p.action) { case "retry": return retryWorkflowStep(w, guard, p.stepId); case "cancel": return cancelWorkflowStep(w, guard, p.stepId); case "integrate": return integrateWorkflowStep(w, guard, p.stepId, p.integrationStepId ?? "", p.integrationEvidence ?? ""); case "finish": if (!p.outcome) throw new Error("Outcome required"); return finishWorkflowStep(w, guard, p.stepId, p.outcome, { summary: childStatus?.summary ?? p.summary ?? "", evidence: Object.fromEntries((p.evidence ?? []).map(e => [e.id, e.value])), artifacts: p.artifacts ?? [], childLink: childStatus?.link ?? p.childLink, checkout: childStatus?.checkout ?? p.checkout }, childStatus); default: throw new Error("Unsupported action"); } }));
  } }));
}
