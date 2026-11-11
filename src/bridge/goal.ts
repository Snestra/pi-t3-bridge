import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  arr,
  compile,
  int,
  lit,
  nullable,
  obj,
  opt,
  oneOf,
  str,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { askStopped } from "./ask.ts";
import { goalCard, renderInlineCard } from "./cards.ts";
import { registerUnlessTaken } from "./claim.ts";
import { planBlocked } from "./plan.ts";
import { isResumePrompt, recoveryPending } from "./resume.ts";
import type { GoalIdentity } from "./resume.ts";
import {
  taskDisposition,
  taskOutcome,
  isChildWake,
  isT3Tool,
  waitingOnChild,
} from "./t3-tasks.ts";
import type { GoalExecutionState, TaskState } from "./t3-tasks.ts";
import { unfinishedWorkflows } from "./workflow-store.ts";

const GOAL_ENTRY = "pi-t3-goal";
const HOLD_ENTRY = "pi-t3-goal-question";
const INSTRUCTION = "pi-t3-goal-instruction";
const WORDS = /^(?<word>\S+)(?:\s+(?<rest>[\s\S]*))?$/u;

const TEXT = str({ minLength: 1, pattern: "\\S" });
const REVISION = int({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 });
const CONDITION = obj({ id: TEXT, text: TEXT });
const ACTION = obj({ instruction: TEXT, tool: TEXT });

const EVIDENCE = arr(
  obj({
    kind: oneOf([
      "command",
      "file",
      "artifact",
      "child",
      "judgment",
      "external",
      "confirmation",
    ]),
    modifiedAt: nullable(int({ minimum: 0 })),
    observedAt: int({ minimum: 0 }),
    path: nullable(TEXT),
    requirement: TEXT,
    result: str({ maxLength: 1000, minLength: 1 }),
    review: nullable(TEXT),
    revision: REVISION,
    source: TEXT,
  })
);

const FACT_ENTRY = "pi-t3-goal-fact";

const FactSchema = obj({
  at: int({ minimum: 0 }),
  command: opt(TEXT),
  excerpt: str(),
  exitCode: opt(int()),
  goalId: TEXT,
  id: TEXT,
  kind: oneOf(["command", "child", "confirmation", "tool"]),
  modifiedAt: opt(int({ minimum: 0 })),
  path: opt(TEXT),
  producer: TEXT,
  revision: REVISION,
  success: oneOf([true, false]),
});

const factInput = compile(FactSchema);

const GoalSchema = obj({
  blocker: nullable(TEXT),
  conditions: arr(CONDITION),
  evidence: EVIDENCE,
  id: TEXT,
  nextAction: nullable(ACTION),
  noProgressCycles: int({ minimum: 0 }),
  objective: TEXT,
  progressAt: int({ minimum: 0 }),
  reason: nullable(str()),
  requirementRevision: REVISION,
  revision: REVISION,
  status: oneOf(["active", "paused", "blocked", "complete"]),
  workspace: arr(
    obj({
      modifiedAt: int({ minimum: 0 }),
      path: TEXT,
      size: int({ minimum: 0 }),
    })
  ),
});

export type Goal = Static<typeof GoalSchema>;

export type { GoalIdentity } from "./resume.ts";

export interface GoalExecution {
  readonly inspectGoal: (
    ctx: ExtensionContext,
    identity: GoalIdentity
  ) => GoalExecutionState;
  readonly pause: (
    ctx: ExtensionCommandContext,
    identity: GoalIdentity
  ) => Promise<void>;
  readonly reconcile: (
    ctx: ExtensionCommandContext,
    identity: GoalIdentity
  ) => Promise<{ ready: boolean; reason?: string }>;
}

const uiHolds = new Set<string>();

const SnapshotSchema = obj({ goal: nullable(GoalSchema), version: lit(2) });
const snapshot = compile(SnapshotSchema);

const legacySnapshot = compile(
  obj({
    goal: obj({
      evidence: arr(obj({ requirement: TEXT, result: TEXT, source: TEXT })),
      id: TEXT,
      objective: TEXT,
      reason: nullable(str()),
      revision: REVISION,
      status: oneOf(["active", "paused", "blocked", "complete"]),
    }),
    version: lit(1),
  })
);

const OutputSchema = obj({ goal: nullable(GoalSchema) });
const GetSchema = obj({});
const getInput = compile(GetSchema);

const UpdateSchema = obj({
  conditions: opt(arr(CONDITION)),
  evidence: EVIDENCE,
  goalId: TEXT,
  nextAction: opt(nullable(ACTION)),
  reason: nullable(str()),
  revision: REVISION,
  status: oneOf(["active", "complete", "blocked"]),
});

const updateInput = compile(UpdateSchema);

const questionHold = compile(
  obj({ goalId: TEXT, waiting: oneOf([true, false]) })
);

const INVALID_STATE = "Goal state is invalid. Use /goal clear.";
const UNAVAILABLE = "Goal tools are unavailable or owned by another extension.";

const REJECTED_UPDATE =
  "Goal update rejected. Read get_goal and use its current identity and revision.";

export const readGoal = (ctx: ExtensionContext): Goal | null => {
  const entry = ctx.sessionManager
    .getBranch()
    .findLast(
      (item) => item.type === "custom" && item.customType === GOAL_ENTRY
    );

  if (entry?.type !== "custom") {
    return null;
  }

  if (!snapshot.check(entry.data)) {
    if (legacySnapshot.check(entry.data)) {
      const old = entry.data.goal;

      return {
        ...old,
        blocker: null,
        conditions: [],
        evidence: [],
        nextAction: {
          instruction: "Recheck the full objective and gather linked evidence.",
          tool: "get_goal",
        },
        noProgressCycles: 0,
        progressAt: 0,
        reason: "Saved goal needs fresh linked evidence. Use /goal resume.",
        requirementRevision: 1,
        status: "paused",
        workspace: [],
      };
    }

    throw new Error(INVALID_STATE);
  }

  const { goal } = entry.data;

  if (
    goal !== null &&
    ((goal.status === "complete" && goal.evidence.length === 0) ||
      (goal.status === "blocked" && !goal.reason?.trim()))
  ) {
    throw new Error(INVALID_STATE);
  }

  return goal;
};

const goalNeedsUser = (ctx: ExtensionContext, goal: Goal): boolean => {
  const last = ctx.sessionManager
    .getBranch()
    .findLast(
      (entry) => entry.type === "custom" && entry.customType === HOLD_ENTRY
    );

  return (
    uiHolds.has(ctx.sessionManager.getSessionId()) ||
    planBlocked(ctx) ||
    (last?.type === "custom" &&
      questionHold.check(last.data) &&
      last.data.goalId === goal.id &&
      last.data.waiting)
  );
};

export const goalAllowsExecution = (
  ctx: ExtensionContext,
  identity: GoalIdentity
): boolean => {
  try {
    const goal = readGoal(ctx);

    return (
      goal !== null &&
      goal.status === "active" &&
      goal.id === identity.id &&
      goal.revision === identity.revision &&
      !ctx.signal?.aborted &&
      !goalNeedsUser(ctx, goal)
    );
  } catch {
    return false;
  }
};

const facts = (
  ctx: ExtensionContext,
  goal: Goal
): Static<typeof FactSchema>[] =>
  ctx.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" &&
      entry.customType === FACT_ENTRY &&
      factInput.check(entry.data) &&
      entry.data.goalId === goal.id
        ? [entry.data]
        : []
    );

const validateArtifact = async (
  ctx: ExtensionContext,
  item: Goal["evidence"][number]
): Promise<void> => {
  if (item.kind !== "file" && item.kind !== "artifact") {
    return;
  }

  if (!item.path || item.modifiedAt === null) {
    throw new Error("File evidence needs its path and modification time.");
  }

  const target = path.resolve(ctx.cwd, item.path);

  const [info, content] = await Promise.all([
    stat(target),
    readFile(target, "utf-8"),
  ]);

  if (
    Math.floor(info.mtimeMs) !== item.modifiedAt ||
    !content.includes(item.result)
  ) {
    throw new Error(
      "Artifact changed or its excerpt is missing. Read it again."
    );
  }
};

const validateClaim = (
  ctx: ExtensionContext,
  fact: Static<typeof FactSchema>,
  records: Static<typeof FactSchema>[],
  item: Goal["evidence"][number]
): void => {
  if (
    (item.kind === "file" || item.kind === "artifact") &&
    (fact.path !== path.resolve(ctx.cwd, item.path ?? "") ||
      fact.modifiedAt !== item.modifiedAt)
  ) {
    throw new Error(
      "Artifact evidence must link its observed file and modification time."
    );
  }

  if (
    item.kind === "command" &&
    (fact.kind !== "command" || fact.exitCode !== 0)
  ) {
    throw new Error("Not a mechanically checked command fact.");
  }

  if (item.kind === "child" && fact.kind !== "child") {
    throw new Error("Not a completed child result.");
  }

  if (item.kind === "confirmation" && fact.kind !== "confirmation") {
    throw new Error("Not a user confirmation.");
  }

  if (
    ["judgment", "external"].includes(item.kind) &&
    !records.some(
      (record) =>
        record.id === item.review &&
        record.kind === "confirmation" &&
        record.at >= fact.at &&
        record.revision === item.revision &&
        record.excerpt.includes(item.requirement)
    )
  ) {
    throw new Error("Judgment and external claims need linked user review.");
  }
};

const validateEvidence = async (
  ctx: ExtensionContext,
  goal: Goal,
  evidence: Goal["evidence"],
  complete = true
): Promise<void> => {
  const records = facts(ctx, goal);

  const requirements = new Set([
    "objective",
    ...goal.conditions.map((condition) => condition.id),
  ]);

  for (const item of evidence) {
    const fact = records.find((record) => record.id === item.source);

    const latest = records.findLast(
      (record) => record.producer === fact?.producer
    );

    if (
      !requirements.has(item.requirement) ||
      item.revision !== goal.requirementRevision ||
      !fact?.success ||
      latest?.id !== fact.id ||
      fact.revision !== goal.requirementRevision ||
      fact.at !== item.observedAt ||
      !fact.excerpt.includes(item.result)
    ) {
      throw new Error(
        "Evidence must link a fresh observed fact and quote its excerpt."
      );
    }

    validateClaim(ctx, fact, records, item);
  }

  await Promise.all(evidence.map((item) => validateArtifact(ctx, item)));

  if (
    complete &&
    [...requirements].some(
      (id) => !evidence.some((item) => item.requirement === id)
    )
  ) {
    throw new Error(
      "Every requirement, including the full objective, needs current evidence."
    );
  }
};

interface ProposedConditions {
  readonly conditions: Goal["conditions"];
  readonly changed: boolean;
}

const validateUpdate = (
  goal: Goal | null,
  params: Static<typeof UpdateSchema>,
  aborted: boolean
): Goal => {
  if (
    aborted ||
    !goal ||
    goal.status !== "active" ||
    goal.id !== params.goalId ||
    goal.revision !== params.revision
  ) {
    throw new Error(REJECTED_UPDATE);
  }

  if (params.status === "complete" && params.evidence.length === 0) {
    throw new Error("Completion needs evidence.");
  }

  if (
    params.status === "blocked" &&
    (!params.reason?.trim() ||
      goal.blocker !== params.reason ||
      goal.noProgressCycles < 3)
  ) {
    throw new Error(
      "The same blocker must prevent progress in three consecutive cycles."
    );
  }

  return goal;
};

const proposedConditions = (
  goal: Goal,
  params: Static<typeof UpdateSchema>
): ProposedConditions => {
  const conditions = params.conditions ?? goal.conditions;

  if (
    new Set(conditions.map((condition) => condition.id)).size !==
      conditions.length ||
    conditions.some((condition) => condition.id === "objective") ||
    goal.conditions.some(
      (condition) =>
        !conditions.some(
          (next) => next.id === condition.id && next.text === condition.text
        )
    )
  ) {
    throw new Error(
      "Agent conditions may only be added. Only the user can narrow requirements."
    );
  }

  const changed =
    JSON.stringify(conditions) !== JSON.stringify(goal.conditions);

  if (changed && params.status !== "active") {
    throw new Error("Save proposed conditions before reporting completion.");
  }

  return { changed, conditions };
};

const factKind = (
  toolName: string,
  task: TaskState | undefined
): Static<typeof FactSchema>["kind"] => {
  if (task && taskDisposition(task) === "finished") {
    return "child";
  }

  if (["bash", "powershell"].includes(toolName)) {
    return "command";
  }

  return "tool";
};

const inputText = compile(TEXT).check;
const commandOutcome = compile(obj({ exit_code: int() }, { open: true }));

const observedFact = async (
  ctx: ExtensionContext,
  goal: Goal,
  event: ToolResultEvent
): Promise<Static<typeof FactSchema>> => {
  const task = taskOutcome(event.toolName, event, event.isError);

  const command = inputText(event.input.command)
    ? event.input.command
    : undefined;

  const producer = task
    ? `child:${task.taskId}`
    : `${event.toolName}:${command ?? JSON.stringify(Object.fromEntries(Object.entries(event.input).toSorted(([left], [right]) => left.localeCompare(right))))}`;

  const fact: Static<typeof FactSchema> = {
    at: Date.now(),
    excerpt: event.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .slice(0, 1000),
    goalId: goal.id,
    id: event.toolCallId,
    kind: factKind(event.toolName, task),
    producer,
    revision: goal.requirementRevision,
    success: !event.isError,
  };

  if (
    command &&
    fact.kind === "command" &&
    commandOutcome.check(event.structuredContent)
  ) {
    fact.command = command;
    fact.exitCode = event.structuredContent.exit_code;
  }

  if (
    !event.isError &&
    event.toolName === "read" &&
    inputText(event.input.path)
  ) {
    const file = path.resolve(ctx.cwd, event.input.path);
    const info = await stat(file);
    fact.path = file;
    fact.modifiedAt = Math.floor(info.mtimeMs);
  }

  return fact;
};

const identityOf = (goal: Goal): GoalIdentity => ({
  id: goal.id,
  revision: goal.revision,
});

const instruction = (goal: Goal): string =>
  `Saved goal ${goal.id}, revision ${goal.revision} (${goal.status}).\nObjective:\n${goal.objective}\n\nAcceptance conditions (agent proposals, never a replacement for the objective):\n${JSON.stringify(goal.conditions)}\nNext action: ${JSON.stringify(goal.nextAction)}\nEvidence uses requirement ID objective for the full objective and stable condition IDs. Read get_goal for observed fact IDs, timestamps and excerpts. User review must say confirm followed by the requirement ID and confirmation text. Use requirementRevision for evidence revision.\n\nWork on the full objective. Make concrete progress, not repeated status reports. Read get_goal before reporting a result. Audit every requirement against current files, command output, or external state. Only call update_goal with complete when all requirements have current evidence. Report an ordinary blocker with update_goal only after the same blocker prevents progress in three consecutive cycles. A runtime error or waiting for user approval or an answer stops work immediately. Never bypass permissions, approval, or delegated-task wait instructions. Do not poll children. Only the user can edit, pause, resume, or clear a goal. A paused, blocked, complete, or cleared goal does not authorize more work.`;

const goalResult = (
  goal: Goal | null,
  observed: Static<typeof FactSchema>[] = []
) => ({
  content: [
    { text: JSON.stringify({ goal, observed }), type: "text" as const },
  ],
  details: { goal },
  structuredContent: { goal },
});

type GoalCommand =
  | { readonly kind: "create" | "edit"; readonly objective: string }
  | { readonly kind: "status" | "pause" | "resume" | "clear" };

const parseCommand = (args: string): GoalCommand => {
  const text = args;
  const { word, rest = "" } = WORDS.exec(text)?.groups ?? {};

  if (!word) {
    return { kind: "status" };
  }

  if (word === "edit" || word === "--") {
    if (!rest.trim()) {
      throw new Error("Invalid /goal arguments.");
    }

    return {
      kind: word === "edit" ? "edit" : "create",
      objective: rest,
    };
  }

  if (word === "pause" || word === "resume" || word === "clear") {
    if (rest) {
      throw new Error("Invalid /goal arguments.");
    }

    return { kind: word };
  }

  return { kind: "create", objective: args };
};

interface GoalRuntime {
  readonly identity: (ctx: ExtensionContext) => GoalIdentity | undefined;
  readonly recover: (ctx: ExtensionContext, identity: GoalIdentity) => void;
  readonly settle: (event: AgentSettledEvent, ctx: ExtensionContext) => void;
}

export const registerGoal = (
  pi: ExtensionAPI,
  execution: GoalExecution
): GoalRuntime => {
  let ownedRun: GoalIdentity | undefined;
  let failure: string | undefined;
  let stopping: Promise<void> | undefined;
  let cycleStarted = Date.now();

  const workspaceState = async (
    ctx: ExtensionContext
  ): Promise<Goal["workspace"]> => {
    const result = await pi.exec(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: ctx.cwd }
    );

    if (result.code !== 0) {
      throw new Error("Cannot recheck workspace files. Goal remains stopped.");
    }

    return Promise.all(
      [...new Set(result.stdout.split("\0").filter(Boolean))]
        .toSorted()
        .map(async (file) => {
          try {
            const info = await stat(path.resolve(ctx.cwd, file));

            return {
              modifiedAt: Math.floor(info.mtimeMs),
              path: file,
              size: info.size,
            };
          } catch {
            return { modifiedAt: 0, path: file, size: 0 };
          }
        })
    );
  };

  const show = (ctx: ExtensionContext, content: string): void => {
    if (ctx.mode === "rpc") {
      ctx.ui.notify(content, "info");
    }

    pi.sendMessage(
      { content, customType: "pi-t3-goal-status", display: true },
      { triggerTurn: false }
    );
  };

  const save = (goal: Goal | null): void => {
    if (!snapshot.check({ goal, version: 2 })) {
      throw new Error(INVALID_STATE);
    }

    pi.appendEntry(GOAL_ENTRY, { goal, version: 2 } satisfies Static<
      typeof SnapshotSchema
    >);
  };

  const change = (
    goal: Goal,
    changes: Partial<Omit<Goal, "id" | "revision">>
  ): Goal => {
    const next = { ...goal, ...changes, revision: goal.revision + 1 };

    save(next);

    if (ownedRun?.id === next.id && next.status === "active") {
      ownedRun = identityOf(next);
    }

    return next;
  };

  const refreshWorkspace = async (
    ctx: ExtensionContext,
    goal: Goal
  ): Promise<Goal> => {
    const workspace = await workspaceState(ctx);
    const current = readGoal(ctx);

    if (current?.id !== goal.id) {
      throw new Error(REJECTED_UPDATE);
    }

    if (JSON.stringify(workspace) === JSON.stringify(current.workspace)) {
      return current;
    }

    return change(current, {
      evidence: [],
      requirementRevision: current.requirementRevision + 1,
      workspace,
    });
  };

  const toolsOwned = (): boolean => {
    const source = pi.getCommands().find((command) => command.name === "goal")
      ?.sourceInfo.path;

    return (
      source !== undefined &&
      ["get_goal", "update_goal"].every(
        (name) =>
          pi
            .getAllTools()
            .some(
              (tool) => tool.name === name && tool.sourceInfo.path === source
            ) && pi.getActiveTools().includes(name)
      )
    );
  };

  const needsUser = goalNeedsUser;

  const held = (ctx: ExtensionContext, goal: Goal): boolean => {
    const state = execution.inspectGoal(ctx, identityOf(goal));

    return (
      needsUser(ctx, goal) ||
      waitingOnChild(ctx) ||
      state.pending ||
      state.reconciliationRequired
    );
  };

  const start = (ctx: ExtensionContext, goal: Goal): void => {
    if (
      goal.status !== "active" ||
      !toolsOwned() ||
      !goal.nextAction ||
      !pi.getActiveTools().includes(goal.nextAction.tool) ||
      held(ctx, goal)
    ) {
      return;
    }

    ownedRun = identityOf(goal);

    if (ctx.isIdle()) {
      pi.sendMessage(
        { content: instruction(goal), customType: INSTRUCTION, display: false },
        { triggerTurn: true }
      );
    }
  };

  const stop = async (
    ctx: ExtensionCommandContext,
    id: string | undefined
  ): Promise<void> => {
    if (id !== undefined && ownedRun?.id === id && !ctx.isIdle()) {
      ctx.abort();
      stopping ??= ctx.waitForIdle();

      try {
        await stopping;
      } finally {
        stopping = undefined;
      }
    }
  };

  const checkCompletion = async (
    ctx: ExtensionContext,
    goal: Goal,
    evidence: Goal["evidence"],
    signal: AbortSignal | undefined
  ): Promise<void> => {
    if (held(ctx, goal) || unfinishedWorkflows(ctx, goal.id).length > 0) {
      throw new Error(
        "Completion is held by a question, approval, workflow task or child."
      );
    }

    const checked = await refreshWorkspace(ctx, goal);

    if (checked.revision !== goal.revision) {
      throw new Error(
        "Workspace changed. Read get_goal and gather fresh evidence."
      );
    }

    await validateEvidence(ctx, goal, evidence);
    await refreshWorkspace(ctx, goal);

    if (
      signal?.aborted ||
      held(ctx, goal) ||
      unfinishedWorkflows(ctx, goal.id).length > 0 ||
      readGoal(ctx)?.revision !== goal.revision
    ) {
      throw new Error(REJECTED_UPDATE);
    }
  };

  registerUnlessTaken(
    pi,
    defineTool({
      annotations: { readOnlyHint: true },
      description:
        "Read the saved goal, including its current identity, revision, status, and evidence.",
      execute: async (_id, params, _signal, _update, ctx) => {
        if (!getInput.check(params)) {
          throw new Error(REJECTED_UPDATE);
        }

        const saved = readGoal(ctx);
        const goal = saved ? await refreshWorkspace(ctx, saved) : null;

        if (goal) {
          await renderInlineCard(
            ctx,
            goalCard({
              ...goal,
              execution: execution.inspectGoal(ctx, identityOf(goal)),
            })
          );
        }

        return goalResult(goal, goal ? facts(ctx, goal) : []);
      },
      label: "Get goal",
      name: "get_goal",
      outputSchema: OutputSchema,
      parameters: GetSchema,
      prepareArguments: (args) => {
        if (!getInput.check(args)) {
          throw new Error(REJECTED_UPDATE);
        }

        return args;
      },
    })
  );
  registerUnlessTaken(
    pi,
    defineTool({
      description:
        "Report completion with current evidence for every requirement, or report the same blocker after three consecutive cycles. Cannot create, edit, pause, or resume goals. Read get_goal first.",
      execute: async (_id, params, signal, _update, ctx) => {
        if (!toolsOwned() || !updateInput.check(params)) {
          throw new Error(REJECTED_UPDATE);
        }

        const goal = validateUpdate(
          readGoal(ctx),
          params,
          signal?.aborted === true
        );

        if (params.status === "complete") {
          await checkCompletion(ctx, goal, params.evidence, signal);
        }

        const { conditions, changed } = proposedConditions(goal, params);

        if (params.status === "active" && params.evidence.length > 0) {
          if (changed) {
            throw new Error("Gather evidence after saving condition changes.");
          }

          await validateEvidence(ctx, goal, params.evidence, false);

          if (readGoal(ctx)?.revision !== goal.revision) {
            throw new Error(REJECTED_UPDATE);
          }
        }

        if (
          params.nextAction &&
          !pi.getActiveTools().includes(params.nextAction.tool)
        ) {
          throw new Error("The next action tool is not permitted or active.");
        }

        const next = change(goal, {
          blocker: params.status === "active" ? params.reason : goal.blocker,
          conditions,
          evidence: changed ? [] : params.evidence,
          nextAction: params.nextAction ?? goal.nextAction,
          noProgressCycles:
            params.reason === goal.blocker ? goal.noProgressCycles : 0,
          reason: params.reason,
          requirementRevision: goal.requirementRevision + (changed ? 1 : 0),
          status: params.status,
        });

        await renderInlineCard(
          ctx,
          goalCard({
            ...next,
            execution: execution.inspectGoal(ctx, identityOf(next)),
          })
        );

        return goalResult(next);
      },
      executionMode: "sequential",
      label: "Update goal",
      name: "update_goal",
      outputSchema: OutputSchema,
      parameters: UpdateSchema,
      prepareArguments: (args) => {
        if (!updateInput.check(args)) {
          throw new Error(REJECTED_UPDATE);
        }

        return args;
      },
    })
  );

  const describe = (ctx: ExtensionContext, goal: Goal | null): void => {
    show(
      ctx,
      goal === null
        ? "No goal saved."
        : `${goal.status}\n${goal.objective}${goal.reason ? `\n${goal.reason}` : ""}`
    );
  };

  const activate = (ctx: ExtensionContext, goal: Goal): void => {
    if (!toolsOwned()) {
      throw new Error(UNAVAILABLE);
    }

    save(goal);
    describe(ctx, goal);
    start(ctx, goal);
  };

  const pauseGoal = async (
    ctx: ExtensionCommandContext,
    goal: Goal,
    clear: boolean
  ): Promise<void> => {
    const identity = identityOf(goal);
    const paused = change(goal, { reason: "User stop.", status: "paused" });

    try {
      await execution.pause(ctx, identity);
      const current = readGoal(ctx);

      if (current?.id !== paused.id || current.revision !== paused.revision) {
        throw new Error(REJECTED_UPDATE);
      }

      const state = execution.inspectGoal(ctx, identityOf(current));

      if (clear) {
        if (state.pending || state.reconciliationRequired) {
          throw new Error(
            "Cancellation is unresolved. The paused goal is retained."
          );
        }

        save(null);
      }
    } finally {
      await stop(ctx, goal.id);
      describe(ctx, readGoal(ctx));
    }
  };

  const applyCommand = async (
    command: GoalCommand,
    ctx: ExtensionCommandContext
  ): Promise<void> => {
    if (command.kind !== "pause" && command.kind !== "clear") {
      await stopping;
    }

    const goal = readGoal(ctx);

    if (command.kind === "status") {
      describe(ctx, goal);

      return;
    }

    if (command.kind === "create") {
      if (goal !== null && goal.status !== "complete") {
        throw new Error(
          "Use /goal edit or /goal clear before replacing an unfinished goal."
        );
      }

      activate(ctx, {
        blocker: null,
        conditions: [],
        evidence: [],
        id: randomUUID(),
        nextAction: {
          instruction:
            "Read the full objective and identify the first concrete action.",
          tool: "get_goal",
        },
        noProgressCycles: 0,
        objective: command.objective,
        progressAt: 0,
        reason: null,
        requirementRevision: 1,
        revision: 1,
        status: "active",
        workspace: await workspaceState(ctx),
      });

      return;
    }

    if (goal === null) {
      throw new Error("No goal saved.");
    }

    if (command.kind === "pause" || command.kind === "clear") {
      await pauseGoal(ctx, goal, command.kind === "clear");

      return;
    }

    if (goal.status === "complete") {
      throw new Error("A completed goal cannot be edited or resumed.");
    }

    if (command.kind === "edit") {
      describe(
        ctx,
        change(goal, {
          blocker: null,
          conditions: [],
          evidence: [],
          noProgressCycles: 0,
          objective: command.objective,
          requirementRevision: goal.requirementRevision + 1,
        })
      );

      return;
    }

    if (goal.status === "active") {
      describe(ctx, goal);
    } else {
      if (goal.status !== "paused") {
        change(goal, {
          reason: "Reconciliation required before resuming.",
          status: "paused",
        });
        await applyCommand({ kind: "resume" }, ctx);

        return;
      }

      const result = await execution.reconcile(ctx, identityOf(goal));
      const current = readGoal(ctx);

      if (
        !result.ready ||
        current?.id !== goal.id ||
        current.revision !== goal.revision ||
        held(ctx, current)
      ) {
        throw new Error(
          result.reason ??
            "Goal reconciliation or a user hold prevents resuming."
        );
      }

      activate(ctx, {
        ...goal,
        evidence: [],
        reason: null,
        requirementRevision: goal.requirementRevision + 1,
        revision: goal.revision + 1,
        status: "active",
      });
    }
  };

  pi.registerCommand("goal", {
    description:
      "Save, inspect, edit, pause, resume, or clear this session’s goal.",
    handler: async (args, ctx) => {
      try {
        await applyCommand(parseCommand(args), ctx);
      } catch (error) {
        show(ctx, error instanceof Error ? error.message : String(error));
      }
    },
  });

  const restore = (ctx: ExtensionContext): void => {
    ownedRun = undefined;
    uiHolds.delete(ctx.sessionManager.getSessionId());
    failure = undefined;

    try {
      const goal = readGoal(ctx);

      if (goal?.status === "active") {
        change(goal, {
          reason: "Restored session. Use /goal resume.",
          status: "paused",
        });
        show(
          ctx,
          `paused\n${goal.objective}\nRestored session. Use /goal resume.`
        );
      }
    } catch {
      show(ctx, INVALID_STATE);
    }
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("ui_prompt_start", (_event, ctx) => {
    uiHolds.add(ctx.sessionManager.getSessionId());
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    uiHolds.delete(ctx.sessionManager.getSessionId());
  });
  pi.on("input", (event, ctx) => {
    const goal = readGoal(ctx);

    if (
      goal &&
      event.source !== "extension" &&
      event.text.startsWith("confirm ")
    ) {
      pi.appendEntry(FACT_ENTRY, {
        at: Date.now(),
        excerpt: event.text.slice(0, 1000),
        goalId: goal.id,
        id: randomUUID(),
        kind: "confirmation",
        producer: "user",
        revision: goal.requirementRevision,
        success: true,
      });
    }

    if (
      goal !== null &&
      isChildWake(event.text) &&
      (goal.status !== "active" || needsUser(ctx, goal))
    ) {
      return { action: "handled" };
    }

    if (
      goal !== null &&
      event.source !== "extension" &&
      !isResumePrompt(event.text) &&
      !isChildWake(event.text)
    ) {
      pi.appendEntry(HOLD_ENTRY, { goalId: goal.id, waiting: false });
    }
  });
  pi.on("tool_call", (event, ctx) => {
    const goal = readGoal(ctx);

    if (!goal) {
      return;
    }

    if (
      isT3Tool(event.toolName, "delegate_task") &&
      (goal.status !== "active" || held(ctx, goal))
    ) {
      return { block: true, reason: "Goal launches are suspended." };
    }

    if (["edit", "write", "bash", "powershell"].includes(event.toolName)) {
      change(goal, {
        evidence: [],
        requirementRevision: goal.requirementRevision + 1,
      });
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const current = readGoal(ctx);

    if (
      current &&
      !["get_goal", "update_goal"].includes(event.toolName) &&
      !isT3Tool(event.toolName, "html_render")
    ) {
      const fact = await observedFact(ctx, current, event);

      const previous = facts(ctx, current).findLast(
        (record) => record.producer === fact.producer
      );

      pi.appendEntry(FACT_ENTRY, fact);

      if (
        fact.success &&
        previous?.excerpt !== fact.excerpt &&
        !["tasks", "task_status"].some((name) => isT3Tool(event.toolName, name))
      ) {
        const latest = readGoal(ctx);

        if (latest?.id === current.id) {
          change(latest, { noProgressCycles: 0, progressAt: Date.now() });
        }
      }
    }

    if (askStopped(event)) {
      const goal = readGoal(ctx);

      if (goal !== null && ownedRun?.id === goal.id) {
        pi.appendEntry(HOLD_ENTRY, { goalId: goal.id, waiting: true });
      }
    }
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const goal = readGoal(ctx);

    ownedRun = goal?.status === "active" ? identityOf(goal) : undefined;

    failure = undefined;
    cycleStarted = Date.now();
  });
  pi.on("context", (event, ctx) => {
    const goal = readGoal(ctx);

    if (goal === null || goal.id !== ownedRun?.id) {
      return;
    }

    return {
      messages: [
        ...event.messages,
        {
          content: instruction(goal),
          customType: INSTRUCTION,
          display: false,
          role: "custom",
          timestamp: Date.now(),
        },
      ],
    };
  });
  pi.on("agent_before_settle", (event, ctx) => {
    if (ownedRun === undefined) {
      return;
    }

    const goal = readGoal(ctx);

    if (
      event.outcome !== "completed" ||
      goal?.status !== "active" ||
      goal.id !== ownedRun.id ||
      !toolsOwned() ||
      !goal.nextAction ||
      !pi.getActiveTools().includes(goal.nextAction.tool) ||
      goal.revision !== ownedRun.revision ||
      failure !== undefined ||
      held(ctx, goal)
    ) {
      return { continue: false };
    }

    if (
      event.continue ||
      event.context.pendingMessages.length > 0 ||
      ctx.hasPendingMessages()
    ) {
      return;
    }

    const progressed = goal.progressAt > cycleStarted;
    const cycles = progressed ? 0 : goal.noProgressCycles + 1;
    cycleStarted = Date.now();
    const next = change(goal, { noProgressCycles: cycles });

    if (cycles >= 3) {
      change(next, {
        reason:
          goal.blocker ?? "Three consecutive cycles made no concrete progress.",
        status: "blocked",
      });

      return { continue: false };
    }

    return {
      continue: true,
      entries: [
        ...event.entries,
        {
          content: instruction(goal),
          customType: INSTRUCTION,
          display: false,
          type: "custom_message" as const,
        },
      ],
    };
  });
  pi.on("agent_end", (event) => {
    const last = event.messages.findLast(
      (message) => message.role === "assistant"
    );

    failure =
      last?.role === "assistant" && last.stopReason === "error"
        ? last.errorMessage?.trim() || "Runtime error."
        : undefined;
  });

  const settle = (event: AgentSettledEvent, ctx: ExtensionContext): void => {
    const id = ownedRun?.id;
    ownedRun = undefined;
    const goal = readGoal(ctx);

    if (goal?.status !== "active" || goal.id !== id) {
      return;
    }

    if (event.aborted) {
      change(goal, { reason: "User stop.", status: "paused" });
    } else if (failure !== undefined && !recoveryPending(ctx, goal)) {
      change(goal, { reason: failure, status: "blocked" });
    }
  };

  return {
    identity: (ctx) => {
      const goal = readGoal(ctx);

      return goal?.status === "active" && goal.id === ownedRun?.id
        ? identityOf(goal)
        : ownedRun;
    },
    // Invalid goal state must not turn an old recovery into a user prompt.
    recover: (ctx, identity) => {
      let goal: Goal | null;

      try {
        goal = readGoal(ctx);
      } catch {
        return;
      }

      if (
        goal?.status !== "active" ||
        goal.id !== identity.id ||
        goal.revision !== identity.revision ||
        !goal.nextAction ||
        !pi.getActiveTools().includes(goal.nextAction.tool) ||
        !toolsOwned() ||
        held(ctx, goal)
      ) {
        return;
      }

      pi.sendMessage(
        {
          content: `Account recovery for saved goal ${goal.id}, revision ${goal.revision}. Read get_goal and continue only if this goal is still active.\n${goal.objective}`,
          customType: "pi-t3-goal-recovery",
          display: true,
        },
        { triggerTurn: true }
      );
    },
    settle,
  };
};
