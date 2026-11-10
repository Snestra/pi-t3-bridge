import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { bool, compile, obj, opt, str } from "@earendil-works/pi-schema";

import { sincePrompt } from "./branch.ts";
import { t3Json, t3Text } from "./t3-json.ts";

// One T3 tool reaches Pi under several names: mcp__t3-code__<name> inside a
// T3 thread, mcp__t3__<name> through Pi's own MCP client, and
// mcp__t3_code__<name> as a codemode nested call.
export const isT3Tool = (toolName: string, name: string): boolean =>
  toolName === name || toolName.endsWith(`__${name}`);

export const findT3Tool = (
  tools: readonly { readonly name: string }[],
  name: string
): string | undefined => tools.find((tool) => isT3Tool(tool.name, name))?.name;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "rolled_back",
]);

interface TaskState {
  readonly hasPendingChildRuns?: boolean;
  readonly status?: string;
  readonly workState?: string;
}

export const isTerminalStatus = (status: string): boolean =>
  TERMINAL_STATUSES.has(status);

// The child's own run is over, though children it started may still run.
export const runEnded = (task: TaskState): boolean =>
  (task.status !== undefined && isTerminalStatus(task.status)) ||
  task.workState === "result_available";

// The child and every child it started are done.
const finishedTask = (task: TaskState): boolean =>
  runEnded(task) &&
  task.hasPendingChildRuns !== true &&
  task.workState !== "waiting_for_children";

// How T3 wakes the parent, for example
// "Delegated task node:… (Research pi stop lifecycle) [completed]".
const WAKE = /Delegated task (?<taskId>\S+) .*?\[(?<status>[a-z_]+)\]/gu;

export const isChildWake = (text: string): boolean =>
  !text.matchAll(WAKE).next().done;

const taskState = compile(
  obj(
    {
      hasPendingChildRuns: opt(bool()),
      status: opt(str()),
      taskId: str(),
      workState: opt(str()),
    },
    { open: true }
  )
);

const isString = compile(str()).check;

const TASK_TOOLS = ["delegate_task", "task_status", "task_cancel"] as const;

const userText = (entry: SessionEntry): string =>
  entry.type === "message" && entry.message.role === "user"
    ? t3Text({
        content: isString(entry.message.content)
          ? [{ text: entry.message.content }]
          : entry.message.content,
      })
    : "";

// T3 tells an orchestrator to end its turn while a delegated child runs, and
// wakes it with a new prompt when the child finishes. Each task's latest
// state is followed across wake-ups, since one child can wake the parent
// while another still runs. A delegate call made inside a codemode script
// shows only as a nested call with no task ID, so it counts until the prompt
// ends, unless its mode is "wait".
export const waitingOnChild = (ctx: ExtensionContext): boolean => {
  const branch = ctx.sessionManager.getBranch();
  const running = new Set<string>();

  for (const entry of branch) {
    for (const wake of userText(entry).matchAll(WAKE)) {
      if (finishedTask({ status: wake.groups?.status })) {
        running.delete(wake.groups?.taskId ?? "");
      }
    }

    if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      !entry.message.isError
    ) {
      const { toolName } = entry.message;

      if (!TASK_TOOLS.some((name) => isT3Tool(toolName, name))) {
        continue;
      }

      const task = t3Json(taskState, entry.message);

      if (task !== undefined && finishedTask(task)) {
        running.delete(task.taskId);
      } else if (task !== undefined) {
        running.add(task.taskId);
      }
    }
  }

  return (
    running.size > 0 ||
    sincePrompt(branch).some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        (entry.message.nestedCalls?.calls ?? []).some(
          (call) =>
            isT3Tool(call.name, "delegate_task") &&
            call.status === "ok" &&
            call.arguments?.mode !== "wait"
        )
    )
  );
};
