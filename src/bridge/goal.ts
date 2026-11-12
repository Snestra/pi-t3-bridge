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
  union,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { askStopped } from "./ask.ts";
import { createSnapshotRenderer, goalCard } from "./cards.ts";
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

const SUPERSEDED =
  "An earlier goal instruction was here. Follow only the latest goal instruction, if any.";

const WORDS = /^(?<word>\S+)(?:\s+(?<rest>[\s\S]*))?$/u;

const TEXT = str({ minLength: 1, pattern: "\\S" });
const REVISION = int({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 });

const PREDICATE = union([
  obj({
    command: TEXT,
    exitCode: int(),
    kind: lit("command"),
    tool: oneOf(["bash", "powershell"]),
  }),
  obj({ contains: TEXT, kind: lit("file"), path: TEXT }),
]);

const CONDITION = obj({
  id: TEXT,
  predicate: opt(nullable(PREDICATE)),
  text: TEXT,
});

const CRITERIA_ENTRY = "pi-t3-goal-criteria";

const criteriaInput = compile(
  obj({
    at: int({ minimum: 0 }),
    conditions: arr(CONDITION),
    criteriaRevision: REVISION,
    goalId: TEXT,
    goalRevision: REVISION,
    objective: TEXT,
  })
);

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
const REVIEW_ENTRY = "pi-t3-goal-review";

const reviewInput = compile(
  obj({
    at: int({ minimum: 0 }),
    conditions: arr(CONDITION),
    evidence: EVIDENCE,
    goalId: TEXT,
    goalRevision: REVISION,
    objective: TEXT,
    revision: REVISION,
  })
);

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
  tool: opt(TEXT),
});

const factInput = compile(FactSchema);

const GoalSchema = obj({
  blocker: nullable(TEXT),
  blockerCycles: opt(int({ minimum: 0 })),
  conditions: arr(CONDITION),
  criteriaRevision: opt(REVISION),
  cycleBlocker: opt(nullable(TEXT)),
  evidence: EVIDENCE,
  id: TEXT,
  nextAction: nullable(ACTION),
  noProgressCycles: int({ minimum: 0 }),
  objective: TEXT,
  progressAt: int({ minimum: 0 }),
  progressRequirements: opt(arr(TEXT)),
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

export type Goal = Static<typeof GoalSchema> & {
  blockerCycles: number;
  criteriaRevision: number;
  cycleBlocker: string | null;
  progressRequirements: string[];
};

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
    goal: nullable(
      obj({
        evidence: arr(obj({ requirement: TEXT, result: TEXT, source: TEXT })),
        id: TEXT,
        objective: TEXT,
        reason: nullable(str()),
        revision: REVISION,
        status: oneOf(["active", "paused", "blocked", "complete"]),
      })
    ),
    version: lit(1),
  })
);

const OutputSchema = obj({
  goal: nullable(GoalSchema),
  observed: arr(FactSchema),
});

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

      if (old === null) {
        return null;
      }

      return {
        ...old,
        blocker: null,
        blockerCycles: 0,
        conditions: [],
        criteriaRevision: 1,
        cycleBlocker: null,
        evidence: [],
        nextAction: {
          instruction: "Recheck the full objective and gather linked evidence.",
          tool: "get_goal",
        },
        noProgressCycles: 0,
        progressAt: 0,
        progressRequirements: [],
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

  return goal === null
    ? null
    : {
        ...goal,
        blockerCycles: goal.blockerCycles ?? 0,
        criteriaRevision: goal.criteriaRevision ?? 1,
        cycleBlocker: goal.cycleBlocker ?? null,
        progressRequirements: goal.progressRequirements ?? [],
      };
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

// The facts get_goal returns: the ones evidence can still cite (the latest
// from each producer at the current requirement revision, as
// validateEvidence requires) and the ones saved evidence already cites.
// Older facts stay in the session but can't become evidence.
const citableFacts = (
  ctx: ExtensionContext,
  goal: Goal
): Static<typeof FactSchema>[] => {
  const records = facts(ctx, goal);
  const cited = new Set(goal.evidence.map((item) => item.source));

  const latest = new Map(records.map((record) => [record.producer, record.id]));

  return records.filter(
    (record) =>
      cited.has(record.id) ||
      (record.revision === goal.requirementRevision &&
        latest.get(record.producer) === record.id)
  );
};

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
    (fact.kind !== "command" || fact.exitCode === undefined)
  ) {
    throw new Error("Not a mechanically checked command fact.");
  }

  if (item.kind === "child" && fact.kind !== "child") {
    throw new Error("Not a completed child result.");
  }

  if (item.kind === "confirmation" && fact.kind !== "confirmation") {
    throw new Error("Not a user confirmation.");
  }
};

const reviewed = (
  ctx: ExtensionContext,
  goal: Goal,
  item: Goal["evidence"][number]
): boolean =>
  ctx.sessionManager
    .getBranch()
    .some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === REVIEW_ENTRY &&
        reviewInput.check(entry.data) &&
        entry.data.goalId === goal.id &&
        entry.data.revision === goal.requirementRevision &&
        entry.data.goalRevision === goal.revision &&
        entry.data.objective === goal.objective &&
        JSON.stringify(entry.data.conditions) ===
          JSON.stringify(goal.conditions) &&
        entry.data.evidence.some(
          (approved) => JSON.stringify(approved) === JSON.stringify(item)
        )
    );

export interface GoalAcceptanceSnapshot {
  readonly approved: boolean;
  readonly criteriaRevision: number;
  readonly conditions: Goal["conditions"];
  readonly objective: string;
}

export const goalAcceptanceSnapshot = (
  ctx: ExtensionContext,
  goal: Goal
): GoalAcceptanceSnapshot => ({
  approved: ctx.sessionManager
    .getBranch()
    .some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === CRITERIA_ENTRY &&
        criteriaInput.check(entry.data) &&
        entry.data.goalId === goal.id &&
        entry.data.criteriaRevision === goal.criteriaRevision &&
        entry.data.objective === goal.objective &&
        JSON.stringify(entry.data.conditions) ===
          JSON.stringify(goal.conditions)
    ),
  conditions: goal.conditions,
  criteriaRevision: goal.criteriaRevision,
  objective: goal.objective,
});

const matchesPredicate = async (
  ctx: ExtensionContext,
  condition: Goal["conditions"][number],
  item: Goal["evidence"][number],
  fact: Static<typeof FactSchema> | undefined
): Promise<boolean> => {
  const { predicate } = condition;

  if (!predicate || !fact) {
    return false;
  }

  if (predicate.kind === "command") {
    return (
      item.kind === "command" &&
      fact.kind === "command" &&
      fact.tool === predicate.tool &&
      fact.command === predicate.command &&
      fact.exitCode === predicate.exitCode
    );
  }

  const file = path.resolve(ctx.cwd, predicate.path);
  const content = await readFile(file, "utf-8");

  return (
    ["file", "artifact"].includes(item.kind) &&
    fact.path === file &&
    item.path !== null &&
    path.resolve(ctx.cwd, item.path) === file &&
    content.includes(predicate.contains)
  );
};

const checkAcceptance = async (
  ctx: ExtensionContext,
  goal: Goal,
  evidence: Goal["evidence"],
  records: Static<typeof FactSchema>[]
): Promise<void> => {
  if (
    !goalAcceptanceSnapshot(ctx, goal).approved ||
    goal.conditions.length === 0
  ) {
    throw new Error(
      "The full objective and complete criteria mapping need one-time approval with /goal approve."
    );
  }

  await Promise.all(
    goal.conditions.map(async (condition) => {
      const candidates = evidence.filter(
        (item) => item.requirement === condition.id
      );

      const accepted = await Promise.all(
        candidates.map((item) =>
          condition.predicate
            ? matchesPredicate(
                ctx,
                condition,
                item,
                records.find((fact) => fact.id === item.source)
              )
            : Promise.resolve(reviewed(ctx, goal, item))
        )
      );

      if (!accepted.some(Boolean)) {
        throw new Error(
          `Requirement ${condition.id}${condition.predicate ? " needs fresh evidence matching its approved check." : " is a semantic claim. Stage evidence and use /goal review."}`
        );
      }
    })
  );
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
      !fact ||
      (!fact.success &&
        !(item.kind === "command" && fact.exitCode !== undefined)) ||
      latest?.id !== fact.id ||
      fact.revision !== goal.requirementRevision ||
      fact.at !== item.observedAt ||
      !fact.excerpt.includes(item.result)
    ) {
      throw new Error(
        "Evidence must link a fresh observed fact and quote its excerpt."
      );
    }

    validateClaim(ctx, fact, item);
  }

  await Promise.all(evidence.map((item) => validateArtifact(ctx, item)));

  if (complete) {
    await checkAcceptance(ctx, goal, evidence, records);
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
      goal.blockerCycles < 3)
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
    tool: event.toolName,
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

const blockerTracking = (
  goal: Goal,
  reason: string | null,
  progressed: boolean
): Pick<Goal, "blockerCycles" | "cycleBlocker"> => {
  if (reason !== goal.blocker || progressed) {
    return { blockerCycles: 0, cycleBlocker: null };
  }

  return { blockerCycles: goal.blockerCycles, cycleBlocker: goal.cycleBlocker };
};

const countBlockerCycles = (goal: Goal, progressed: boolean): number => {
  if (progressed || !goal.blocker) {
    return 0;
  }

  return goal.cycleBlocker === goal.blocker ? goal.blockerCycles + 1 : 1;
};

const instruction = (goal: Goal): string =>
  `Saved goal ${goal.id}, revision ${goal.revision} (${goal.status}).\nObjective:\n${goal.objective}\n\nAcceptance conditions (agent proposals, never a replacement for the objective):\n${JSON.stringify(goal.conditions)}\nNext action: ${JSON.stringify(goal.nextAction)}\nPropose the complete mapping from the original objective to stable condition IDs and optional exact command or file predicates. The user approves this mapping once with /goal approve; edits invalidate approval. Matching fresh evidence then completes mechanical checks automatically. Conditions without predicates need semantic review. This is user-approved coverage, not a mechanical proof that the criteria capture the prose. Evidence uses condition IDs. Read get_goal for observed fact IDs, timestamps and excerpts. User acceptance review uses /goal review after staging evidence. A successful tool only verifies its observed facts, not the acceptance claim. Use requirementRevision for evidence revision.\n\nWork on the full objective. Make concrete progress, not repeated status reports. Read get_goal before reporting a result. Audit every requirement against current files, command output, or external state. Only call update_goal with complete when all requirements have current evidence. Report an ordinary blocker with update_goal only after the same blocker prevents progress in three consecutive cycles. A runtime error or waiting for user approval or an answer stops work immediately. Never bypass permissions, approval, or delegated-task wait instructions. Do not poll children. Only the user can edit, pause, resume, or clear a goal. A paused, blocked, complete, or cleared goal does not authorize more work.`;

const goalResult = (
  goal: Goal | null,
  observed: Static<typeof FactSchema>[] = []
) => ({
  content: [
    { text: JSON.stringify({ goal, observed }), type: "text" as const },
  ],
  details: { goal, observed },
  structuredContent: { goal, observed },
});

type GoalCommand =
  | { readonly kind: "create" | "edit"; readonly objective: string }
  | {
      readonly kind:
        | "status"
        | "pause"
        | "resume"
        | "clear"
        | "review"
        | "approve";
    };

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

  if (
    word === "pause" ||
    word === "resume" ||
    word === "clear" ||
    word === "review" ||
    word === "approve"
  ) {
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
  const renderSnapshot = createSnapshotRenderer(pi);

  let ownedRun: GoalIdentity | undefined;
  let failure: string | undefined;
  let stopping: Promise<void> | undefined;
  let cycleProgress = 0;

  const producingRevisions = new Map<
    string,
    { goalId: string; revision: number }
  >();

  const workspaceState = async (
    ctx: ExtensionContext
  ): Promise<Goal["workspace"]> => {
    const result = await pi.exec(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: ctx.cwd }
    );

    // Goals track the workspace through git, so a folder outside a
    // repository has no file list to check evidence against.
    if (result.stderr.includes("not a git repository")) {
      throw new Error(
        `Goals need a git repository, and ${ctx.cwd} is not in one. Run git init there first.`
      );
    }

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
    if (goal.status === "complete") {
      return goal;
    }

    const workspace = await workspaceState(ctx);
    const current = readGoal(ctx);

    if (current?.id !== goal.id || current.revision !== goal.revision) {
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
          await renderSnapshot(
            ctx,
            goalCard({
              ...goal,
              acceptance: goalAcceptanceSnapshot(ctx, goal),
              execution: execution.inspectGoal(ctx, identityOf(goal)),
            }),
            goal.id
          );
        }

        return goalResult(goal, goal ? citableFacts(ctx, goal) : []);
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

        const progressed = params.evidence.some(
          (item) => !goal.progressRequirements.includes(item.requirement)
        );

        const next = change(goal, {
          blocker: params.status === "active" ? params.reason : goal.blocker,
          ...blockerTracking(goal, params.reason, progressed),
          conditions,
          criteriaRevision: goal.criteriaRevision + (changed ? 1 : 0),
          evidence: changed ? [] : params.evidence,
          nextAction:
            params.nextAction === undefined
              ? goal.nextAction
              : params.nextAction,
          noProgressCycles: progressed ? 0 : goal.noProgressCycles,
          progressAt: progressed ? Date.now() : goal.progressAt,
          progressRequirements: [
            ...new Set([
              ...goal.progressRequirements,
              ...params.evidence.map((item) => item.requirement),
            ]),
          ],
          reason: params.reason,
          requirementRevision: goal.requirementRevision + (changed ? 1 : 0),
          status: params.status,
        });

        await renderSnapshot(
          ctx,
          goalCard({
            ...next,
            acceptance: goalAcceptanceSnapshot(ctx, next),
            execution: execution.inspectGoal(ctx, identityOf(next)),
          }),
          next.id
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

  const approveCriteria = async (
    ctx: ExtensionCommandContext,
    goal: Goal
  ): Promise<void> => {
    if (!ctx.hasUI || goal.conditions.length === 0) {
      throw new Error(
        "Propose the complete acceptance criteria before asking for approval in an interactive session."
      );
    }

    const approved = await ctx.ui.confirm(
      "Approve criteria for automatic completion",
      `Review whether these criteria cover the entire original objective. The bridge checks exact predicates, not whether they fully capture the prose. Criteria without predicates require semantic review. Changed criteria require approval again.\n\n${JSON.stringify({ conditions: goal.conditions, criteriaRevision: goal.criteriaRevision, goalId: goal.id, goalRevision: goal.revision, objective: goal.objective }, null, 2)}`
    );

    const current = readGoal(ctx);

    if (
      !approved ||
      current?.id !== goal.id ||
      current.revision !== goal.revision
    ) {
      throw new Error(
        "Criteria approval was declined, dismissed, or became stale."
      );
    }

    pi.appendEntry(CRITERIA_ENTRY, {
      at: Date.now(),
      conditions: goal.conditions,
      criteriaRevision: goal.criteriaRevision,
      goalId: goal.id,
      goalRevision: goal.revision,
      objective: goal.objective,
    });
    describe(ctx, current);
  };

  const reviewGoal = async (
    ctx: ExtensionCommandContext,
    goal: Goal
  ): Promise<void> => {
    if (!ctx.hasUI || goal.evidence.length === 0) {
      throw new Error(
        "Stage linked evidence before requesting user review in an interactive session."
      );
    }

    const current = await refreshWorkspace(ctx, goal);

    if (current.revision !== goal.revision) {
      throw new Error("Evidence changed. Gather fresh evidence before review.");
    }

    await validateEvidence(ctx, goal, goal.evidence, false);

    const approved = await ctx.ui.confirm(
      "Approve acceptance claims",
      JSON.stringify(
        {
          conditions: goal.conditions,
          evidence: goal.evidence,
          objective: goal.objective,
        },
        null,
        2
      )
    );

    const fresh = await refreshWorkspace(ctx, goal);

    if (!approved || fresh.revision !== goal.revision) {
      throw new Error(
        "Acceptance review was not approved or the goal changed."
      );
    }

    await validateEvidence(ctx, fresh, goal.evidence, false);
    const final = readGoal(ctx);

    if (final?.id !== goal.id || final.revision !== goal.revision) {
      throw new Error("Goal changed during acceptance review.");
    }

    pi.appendEntry(REVIEW_ENTRY, {
      at: Date.now(),
      conditions: goal.conditions,
      evidence: goal.evidence,
      goalId: goal.id,
      goalRevision: goal.revision,
      objective: goal.objective,
      revision: goal.requirementRevision,
    });
    describe(ctx, fresh);
  };

  const reviewActions: Partial<
    Record<
      GoalCommand["kind"],
      (ctx: ExtensionCommandContext, goal: Goal) => Promise<void>
    >
  > = {
    approve: approveCriteria,
    review: reviewGoal,
  };

  const applyCommand = async (
    command: GoalCommand,
    ctx: ExtensionCommandContext
  ): Promise<void> => {
    if (!["pause", "clear"].includes(command.kind)) {
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
        blockerCycles: 0,
        conditions: [],
        criteriaRevision: 1,
        cycleBlocker: null,
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
        progressRequirements: [],
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

    if (goal.status === "complete" && command.kind !== "clear") {
      describe(ctx, goal);

      return;
    }

    const reviewAction = reviewActions[command.kind];

    if (reviewAction) {
      await reviewAction(ctx, goal);

      return;
    }

    if (["pause", "clear"].includes(command.kind)) {
      await pauseGoal(ctx, goal, command.kind === "clear");

      return;
    }

    if (command.kind === "edit") {
      describe(
        ctx,
        change(goal, {
          blocker: null,
          blockerCycles: 0,
          conditions: [],
          criteriaRevision: goal.criteriaRevision + 1,
          cycleBlocker: null,
          evidence: [],
          noProgressCycles: 0,
          objective: command.objective,
          progressRequirements: [],
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
        if (args.trim() || !ctx.hasUI) {
          await applyCommand(parseCommand(args.trim()), ctx);

          // Print and JSON modes exit once the command handler returns, so
          // the goal run it started would never reach the model.
          if (!ctx.hasUI) {
            await ctx.waitForIdle();
          }

          return;
        }

        const goal = readGoal(ctx);
        describe(ctx, goal);

        if (goal === null) {
          return;
        }

        const choices =
          goal.status === "complete"
            ? ["clear"]
            : [
                "approve",
                "review",
                "edit",
                goal.status === "active" ? "pause" : "resume",
                "clear",
              ];

        const choice = await ctx.ui.select(
          `${goal.objective}\n${goal.status} · Revision ${goal.revision}`,
          choices
        );

        if (choice === undefined || !choices.includes(choice)) {
          return;
        }

        const objective =
          choice === "edit"
            ? await ctx.ui.editor("Goal", goal.objective)
            : undefined;

        if (choice === "edit" && !objective?.trim()) {
          return;
        }

        const current = readGoal(ctx);

        if (current?.id !== goal.id || current.revision !== goal.revision) {
          throw new Error(
            "Goal changed while the dialog was open. Use /goal again."
          );
        }

        await applyCommand(
          parseCommand(choice === "edit" ? `edit ${objective}` : choice),
          ctx
        );
      } catch (error) {
        show(ctx, error instanceof Error ? error.message : String(error));
      }
    },
  });

  const restore = (ctx: ExtensionContext): void => {
    ownedRun = undefined;
    producingRevisions.clear();
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

    if (!goal || goal.status === "complete") {
      return;
    }

    if (isT3Tool(event.toolName, "delegate_task")) {
      if (goal.status !== "active" || needsUser(ctx, goal)) {
        return { block: true, reason: "Goal launches are suspended." };
      }

      const requestId =
        "clientRequestId" in event.input
          ? event.input.clientRequestId
          : undefined;

      const owned =
        event.parentToolCallId &&
        execution
          .inspectGoal(ctx, identityOf(goal))
          .children.some(
            (child) =>
              child.requestId === requestId &&
              !child.taskId &&
              !child.cancellationPending
          );

      if (!owned) {
        return {
          block: true,
          reason: "Use launch_workflow_step so the goal owns every child.",
        };
      }
    }

    const producing = ["edit", "write"].includes(event.toolName)
      ? change(goal, {
          evidence: [],
          requirementRevision: goal.requirementRevision + 1,
        })
      : goal;

    producingRevisions.set(event.toolCallId, {
      goalId: producing.id,
      revision: producing.requirementRevision,
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    let current = readGoal(ctx);

    if (current?.status === "complete") {
      return;
    }

    const producing = producingRevisions.get(event.toolCallId);
    producingRevisions.delete(event.toolCallId);

    if (
      current &&
      producing?.goalId === current.id &&
      producing.revision === current.requirementRevision &&
      ["edit", "write", "bash", "powershell"].includes(event.toolName)
    ) {
      current = await refreshWorkspace(ctx, current);
      producing.revision = current.requirementRevision;
    }

    if (
      current &&
      !["get_goal", "update_goal"].includes(event.toolName) &&
      !isT3Tool(event.toolName, "html_render")
    ) {
      const fact = await observedFact(ctx, current, event);

      if (producing?.goalId === current.id) {
        fact.revision = producing.revision;
      }

      pi.appendEntry(FACT_ENTRY, fact);
    }

    if (askStopped(event)) {
      const goal = readGoal(ctx);

      if (goal !== null && ownedRun?.id === goal.id) {
        pi.appendEntry(HOLD_ENTRY, { goalId: goal.id, waiting: true });
      }
    }
  });
  pi.on("tool_execution_end", (event) => {
    producingRevisions.delete(event.toolCallId);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const goal = readGoal(ctx);

    ownedRun = goal?.status === "active" ? identityOf(goal) : undefined;

    failure = undefined;
    cycleProgress = goal?.progressRequirements.length ?? 0;
  });
  pi.on("context", (event, ctx) => {
    const goal = readGoal(ctx);

    // Each start and continuation saves an instruction in the session. The
    // model sees only the current one, appended below. Saved copies keep their
    // place as a short note, so the message order stays the same.
    const saved = (
      message: (typeof event.messages)[number]
    ): message is Extract<typeof message, { role: "custom" }> =>
      message.role === "custom" &&
      message.customType === INSTRUCTION &&
      message.content !== SUPERSEDED;

    const owned = goal !== null && goal.id === ownedRun?.id;

    if (!owned && !event.messages.some(saved)) {
      return;
    }

    const messages = event.messages.map((message) =>
      saved(message) ? { ...message, content: SUPERSEDED } : message
    );

    if (!owned) {
      return { messages };
    }

    return {
      messages: [
        ...messages,
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

    const progressed = goal.progressRequirements.length > cycleProgress;
    const cycles = progressed ? 0 : goal.noProgressCycles + 1;
    cycleProgress = goal.progressRequirements.length;
    const blockerCycles = countBlockerCycles(goal, progressed);

    const next = change(goal, {
      blockerCycles,
      cycleBlocker: goal.blocker,
      noProgressCycles: cycles,
    });

    if (cycles >= 3) {
      change(next, {
        reason:
          blockerCycles >= 3
            ? goal.blocker
            : "Three cycles made no concrete progress. Review the next action before resuming.",
        status: blockerCycles >= 3 ? "blocked" : "paused",
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
