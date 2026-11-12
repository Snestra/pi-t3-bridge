import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  arr,
  bool,
  compile,
  nullable,
  obj,
  opt,
  str,
  unknown,
} from "@earendil-works/pi-schema";

import { sincePrompt } from "./branch.ts";
import { t3Json, t3Text } from "./t3-json.ts";

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

export interface TaskState {
  readonly taskId: string;
  readonly status?: string;
  readonly workState?: string;
  readonly hasPendingChildRuns?: boolean;
  readonly hasPendingQuestion?: boolean;
  readonly pendingApproval?: unknown;
  readonly link?: string;
  readonly summary?: string | null;
  readonly resultContextTransferId?: string | null;
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly options?: unknown;
}

export interface OwnedChild {
  readonly workflowId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly taskId?: string;
  readonly task?: TaskState;
  readonly disposition:
    | "approval"
    | "question"
    | "running"
    | "finished"
    | "unknown";
  readonly needsStatus: boolean;
  readonly cancellationPending: boolean;
}

export interface GoalExecutionState {
  readonly children: readonly OwnedChild[];
  readonly pending: boolean;
  readonly reconciliationRequired: boolean;
  readonly reason?: string;
}

interface ChildWake {
  readonly taskId: string;
  readonly status: string;
}

interface TrackedTask {
  readonly task: TaskState;
  readonly needsStatus: boolean;
}

export const isTerminalStatus = (status: string): boolean =>
  TERMINAL_STATUSES.has(status);

export const runEnded = (
  task: Pick<TaskState, "status" | "workState">
): boolean =>
  (task.status !== undefined && isTerminalStatus(task.status)) ||
  task.workState === "result_available";

export const taskDisposition = (
  task: TaskState
): "approval" | "question" | "running" | "finished" => {
  if (
    task.pendingApproval !== undefined &&
    task.pendingApproval !== null &&
    task.pendingApproval !== false
  ) {
    return "approval";
  }

  if (task.hasPendingQuestion === true) {
    return "question";
  }

  if (
    task.status !== undefined &&
    isTerminalStatus(task.status) &&
    task.hasPendingChildRuns === false &&
    task.workState === "result_available"
  ) {
    return "finished";
  }

  return "running";
};

const WAKE = /Delegated task (?<taskId>\S+) .*?\[(?<status>[a-z_]+)\]/gu;

const childWakes = (text: string): ChildWake[] =>
  Array.from(text.matchAll(WAKE), (match) => ({
    status: match.groups?.status ?? "",
    taskId: match.groups?.taskId ?? "",
  }));

export const isChildWake = (text: string): boolean =>
  childWakes(text).length > 0;

const taskSchema = obj(
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
    taskId: str(),
    workState: opt(str()),
  },
  { open: true }
);

const taskState = compile(taskSchema);

const capabilitySchema = compile(
  obj(
    {
      inheritedProviderInstanceId: opt(str()),
      providers: arr(
        obj(
          {
            canRunChildTask: bool(),
            models: arr(obj({ id: str() }, { open: true })),
            providerInstanceId: str(),
          },
          { open: true }
        )
      ),
    },
    { open: true }
  )
);

const targetSchema = compile(
  obj({ model: opt(str()), providerInstanceId: opt(str()) }, { open: true })
);

export const validateTaskTarget = async <T>(
  ctx: Pick<ExtensionToolContext, "tools" | "executeTool">,
  target: T
): Promise<void> => {
  if (target !== undefined && !targetSchema.check(target)) {
    throw new Error("Invalid target");
  }

  const requested = targetSchema.check(target) ? target : undefined;
  const name = findT3Tool(ctx.tools, "orchestrator_capabilities");

  if (!name) {
    throw new Error("T3 orchestrator_capabilities unavailable");
  }

  const response = await ctx.executeTool(name, {
    search: requested?.model ?? "",
  });

  const catalog = response.isError
    ? undefined
    : t3Json(capabilitySchema, response.result);

  if (!catalog) {
    throw new Error(
      "T3 orchestrator_capabilities failed or returned invalid data"
    );
  }

  const providerId =
    requested?.providerInstanceId ?? catalog.inheritedProviderInstanceId;

  const provider = catalog.providers.find(
    (item) => item.providerInstanceId === providerId
  );

  if (!provider?.canRunChildTask) {
    throw new Error(
      `Provider cannot run child tasks: ${providerId ?? "unknown"}`
    );
  }

  if (
    requested?.model &&
    !provider.models.some((model) => model.id === requested.model)
  ) {
    throw new Error(
      `Requested model was not confirmed by T3: ${requested.model}`
    );
  }
};

const isString = compile(str()).check;
const TASK_TOOLS = ["delegate_task", "task_status", "task_cancel"] as const;
const TASK_ENTRY = "pi-t3-task-outcome";

const savedOutcome = compile(
  obj(
    {
      args: opt(obj({ clientRequestId: opt(str()) }, { open: true })),
      task: taskSchema,
      toolCallId: str(),
      toolName: str(),
    },
    { open: true }
  )
);

// Pi emits the complete nested result in tool_execution_end, but its persisted
// nestedCalls record contains only arguments, status and errors, not results.
export const taskOutcome = (
  toolName: string,
  result: {
    readonly content: readonly unknown[];
    readonly structuredContent?: unknown;
  },
  isError: boolean
): TaskState | undefined =>
  !isError && TASK_TOOLS.some((name) => isT3Tool(toolName, name))
    ? t3Json(taskState, result)
    : undefined;

// Merge partial responses without losing a known descendant wait or returned link.
const recordTaskOutcome = (
  tasks: Map<string, TrackedTask>,
  task: TaskState,
  toolName: string
): void => {
  const previous = tasks.get(task.taskId);
  tasks.set(task.taskId, {
    needsStatus: isT3Tool(toolName, "task_status")
      ? false
      : (previous?.needsStatus ?? false),
    task: { ...previous?.task, ...task },
  });
};

const recordChildWake = (
  tasks: Map<string, TrackedTask>,
  wake: ChildWake
): void => {
  const previous = tasks.get(wake.taskId);
  tasks.set(wake.taskId, {
    needsStatus: true,
    task: { ...previous?.task, taskId: wake.taskId },
  });
};

const userText = (entry: SessionEntry): string =>
  entry.type === "message" && entry.message.role === "user"
    ? t3Text({
        content: isString(entry.message.content)
          ? [{ text: entry.message.content }]
          : entry.message.content,
      })
    : "";

export const trackedTasks = (
  branch: readonly SessionEntry[]
): Map<string, TrackedTask> => {
  const tasks = new Map<string, TrackedTask>();

  const recordedCalls = new Set(
    branch.flatMap((entry) =>
      entry.type === "custom" &&
      entry.customType === TASK_ENTRY &&
      savedOutcome.check(entry.data)
        ? [entry.data.toolCallId]
        : []
    )
  );

  for (const entry of branch) {
    for (const wake of childWakes(userText(entry))) {
      recordChildWake(tasks, wake);
    }

    if (entry.type === "custom" && entry.customType === TASK_ENTRY) {
      if (savedOutcome.check(entry.data)) {
        recordTaskOutcome(tasks, entry.data.task, entry.data.toolName);
      }

      continue;
    }

    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      recordedCalls.has(entry.message.toolCallId)
    ) {
      continue;
    }

    const task = taskOutcome(
      entry.message.toolName,
      entry.message,
      entry.message.isError
    );

    if (task) {
      recordTaskOutcome(tasks, task, entry.message.toolName);
    }
  }

  return tasks;
};

export const registerTaskOutcomes = (pi: ExtensionAPI): void => {
  const argumentsByCall = new Map<string, unknown>();
  pi.on("tool_execution_start", (event) => {
    if (TASK_TOOLS.some((name) => isT3Tool(event.toolName, name))) {
      argumentsByCall.set(event.toolCallId, event.args);
    }
  });
  pi.on("tool_execution_end", (event) => {
    const args = argumentsByCall.get(event.toolCallId);
    argumentsByCall.delete(event.toolCallId);

    const task = taskOutcome(event.toolName, event.result, event.isError);

    if (task) {
      pi.appendEntry(TASK_ENTRY, {
        args,
        parentToolCallId: event.parentToolCallId,
        task,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    }
  });
};

export const waitingOnChild = (ctx: ExtensionContext): boolean => {
  const branch = ctx.sessionManager.getBranch();
  const tasks = trackedTasks(branch);

  const recordedCalls = new Set(
    branch.flatMap((entry) =>
      entry.type === "custom" &&
      entry.customType === TASK_ENTRY &&
      savedOutcome.check(entry.data)
        ? [entry.data.toolCallId]
        : []
    )
  );

  return (
    [...tasks.values()].some(
      ({ task, needsStatus }) =>
        needsStatus || taskDisposition(task) !== "finished"
    ) ||
    sincePrompt(branch).some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        (entry.message.nestedCalls?.calls ?? []).some(
          (call) =>
            isT3Tool(call.name, "delegate_task") &&
            call.status === "ok" &&
            !recordedCalls.has(call.id) &&
            call.arguments?.mode !== "wait"
        )
    )
  );
};
