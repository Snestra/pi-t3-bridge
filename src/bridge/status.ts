import type {
  AgentSettledEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  SessionTreeEvent,
  ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";

import { familyOpen, readFamilies } from "./accounts.ts";
import { readGoal } from "./goal.ts";
import { listWorkflows } from "./workflow-store.ts";
import { workflowAccepted } from "./workflow.ts";

// Status lines next to the composer: T3 shows them as "Pi · a · b" above the
// chat box, and the Pi terminal shows them in its footer. Each line is gone
// when it has nothing to say, so an idle chat shows none.

const KEYS = {
  families: "pi-t3-families",
  goal: "pi-t3-goal",
  workflows: "pi-t3-workflows",
} as const;

const OBJECTIVE_CHARS = 60;

const short = (text: string): string => {
  const line = text.replaceAll(/\s+/gu, " ").trim();

  return line.length > OBJECTIVE_CHARS
    ? `${line.slice(0, OBJECTIVE_CHARS - 1)}…`
    : line;
};

const goalLine = (ctx: ExtensionContext): string | undefined => {
  try {
    const goal = readGoal(ctx);

    return goal === null || goal.status === "complete"
      ? undefined
      : `Goal ${goal.status}: ${short(goal.objective)}`;
  } catch {
    return "Goal state is invalid";
  }
};

const workflowLine = (ctx: ExtensionContext): string | undefined => {
  try {
    const open = listWorkflows(ctx).filter(
      (workflow) => !workflowAccepted(workflow)
    );

    return open.length === 0
      ? undefined
      : open
          .map((workflow) => {
            const done = workflow.steps.filter(
              (step) => step.state === "succeeded"
            ).length;

            return `Workflow ${workflow.id} ${done}/${workflow.steps.length}`;
          })
          .join(", ");
  } catch {
    return undefined;
  }
};

const clock = (iso: string): string => iso.slice(11, 16);

const familiesLine = (): string | undefined => {
  const now = Date.now();

  const out = Object.entries(readFamilies()).flatMap(([name, record]) => {
    if (familyOpen(record, now)) {
      return [];
    }

    return record.state === "exhausted" && record.resetAt !== undefined
      ? [`${name} out until ${clock(record.resetAt)} UTC`]
      : [`${name} out`];
  });

  return out.length === 0 ? undefined : out.join(", ");
};

// The text each line shows now, so an event that changes nothing sends
// nothing to T3.
const shown = new Map<string, string | undefined>();

const show = (
  ctx: ExtensionContext,
  key: string,
  text: string | undefined
): void => {
  if (shown.has(key) && shown.get(key) === text) {
    return;
  }

  shown.set(key, text);
  ctx.ui.setStatus(key, text);
};

export const refreshStatus = (ctx: ExtensionContext): void => {
  if (!ctx.hasUI) {
    return;
  }

  show(ctx, KEYS.goal, goalLine(ctx));
  show(ctx, KEYS.workflows, workflowLine(ctx));
  show(ctx, KEYS.families, familiesLine());
};

// Events after which the goal, a workflow, or a family can have changed.
type ChangeEvent =
  | AgentSettledEvent
  | AgentStartEvent
  | SessionStartEvent
  | SessionTreeEvent
  | ToolExecutionEndEvent;

const onEvent = (_event: ChangeEvent, ctx: ExtensionContext): void => {
  refreshStatus(ctx);
};

export const registerStatus = (pi: ExtensionAPI): void => {
  pi.on("session_start", onEvent);
  pi.on("session_tree", onEvent);
  pi.on("agent_start", onEvent);
  pi.on("agent_settled", onEvent);
  pi.on("tool_execution_end", onEvent);
};
