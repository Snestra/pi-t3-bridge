import { randomUUID } from "node:crypto";

import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  arr,
  compile,
  int,
  lit,
  nullable,
  obj,
  oneOf,
  str,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { askStopped } from "./ask.ts";
import { registerUnlessTaken } from "./claim.ts";
import { planBlocked } from "./plan.ts";
import { isResumePrompt, recoveryPending } from "./resume.ts";
import type { GoalIdentity } from "./resume.ts";
import { isChildWake, waitingOnChild } from "./t3-tasks.ts";

const GOAL_ENTRY = "pi-t3-goal";
const HOLD_ENTRY = "pi-t3-goal-question";
const INSTRUCTION = "pi-t3-goal-instruction";
const WORDS = /^(?<word>\S+)(?:\s+(?<rest>[\s\S]*))?$/u;

const TEXT = str({ minLength: 1, pattern: "\\S" });
const REVISION = int({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 });
const EVIDENCE = arr(obj({ requirement: TEXT, result: TEXT, source: TEXT }));

const GoalSchema = obj({
  evidence: EVIDENCE,
  id: TEXT,
  objective: TEXT,
  reason: nullable(str()),
  revision: REVISION,
  status: oneOf(["active", "paused", "blocked", "complete"]),
});

type Goal = Static<typeof GoalSchema>;

const SnapshotSchema = obj({ goal: nullable(GoalSchema), version: lit(1) });
const snapshot = compile(SnapshotSchema);
const OutputSchema = obj({ goal: nullable(GoalSchema) });
const GetSchema = obj({});
const getInput = compile(GetSchema);

const UpdateSchema = obj({
  evidence: EVIDENCE,
  goalId: TEXT,
  reason: nullable(str()),
  revision: REVISION,
  status: oneOf(["complete", "blocked"]),
});

const updateInput = compile(UpdateSchema);

const questionHold = compile(
  obj({ goalId: TEXT, waiting: oneOf([true, false]) })
);

const INVALID_STATE = "Goal state is invalid. Use /goal clear.";
const UNAVAILABLE = "Goal tools are unavailable or owned by another extension.";

const REJECTED_UPDATE =
  "Goal update rejected. Read get_goal and use its current identity and revision.";

const readGoal = (ctx: ExtensionContext): Goal | null => {
  const entry = ctx.sessionManager
    .getBranch()
    .findLast(
      (item) => item.type === "custom" && item.customType === GOAL_ENTRY
    );

  if (entry?.type !== "custom") {
    return null;
  }

  if (!snapshot.check(entry.data)) {
    throw new Error(INVALID_STATE);
  }

  const { goal } = entry.data;

  if (
    goal !== null &&
    (goal.objective !== goal.objective.trim() ||
      (goal.status === "complete" && goal.evidence.length === 0) ||
      (goal.status === "blocked" && !goal.reason?.trim()))
  ) {
    throw new Error(INVALID_STATE);
  }

  return goal;
};

const identityOf = (goal: Goal): GoalIdentity => ({
  id: goal.id,
  revision: goal.revision,
});

const instruction = (goal: Goal): string =>
  `Saved goal ${goal.id}, revision ${goal.revision} (${goal.status}).\nObjective:\n${goal.objective}\n\nWork on the full objective. Make concrete progress, not repeated status reports. Read get_goal before reporting a result. Audit every requirement against current files, command output, or external state. Only call update_goal with complete when all requirements have current evidence. Report an ordinary blocker with update_goal only after the same blocker prevents progress in three consecutive cycles. A runtime error or waiting for user approval or an answer stops work immediately. Never bypass permissions, approval, or delegated-task wait instructions. Do not poll children. Only the user can edit, pause, resume, or clear a goal. A paused, blocked, complete, or cleared goal does not authorize more work.`;

const goalResult = (goal: Goal | null) => ({
  content: [{ text: JSON.stringify({ goal }), type: "text" as const }],
  details: { goal },
  structuredContent: { goal },
});

type GoalCommand =
  | { readonly kind: "create" | "edit"; readonly objective: string }
  | { readonly kind: "status" | "pause" | "resume" | "clear" };

const parseCommand = (args: string): GoalCommand => {
  const text = args.trim();
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
      objective: rest.trim(),
    };
  }

  if (word === "pause" || word === "resume" || word === "clear") {
    if (rest) {
      throw new Error("Invalid /goal arguments.");
    }

    return { kind: word };
  }

  return { kind: "create", objective: text };
};

interface GoalRuntime {
  readonly identity: (ctx: ExtensionContext) => GoalIdentity | undefined;
  readonly recover: (ctx: ExtensionContext, identity: GoalIdentity) => void;
  readonly settle: (event: AgentSettledEvent, ctx: ExtensionContext) => void;
}

export const registerGoal = (pi: ExtensionAPI): GoalRuntime => {
  let ownedRun: GoalIdentity | undefined;
  let waitingForUI = false;
  let failure: string | undefined;
  let stopping: Promise<void> | undefined;

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
    if (!snapshot.check({ goal, version: 1 })) {
      throw new Error(INVALID_STATE);
    }

    pi.appendEntry(GOAL_ENTRY, { goal, version: 1 } satisfies Static<
      typeof SnapshotSchema
    >);
  };

  const change = (
    goal: Goal,
    changes: Partial<Omit<Goal, "id" | "revision">>
  ): Goal => {
    const next = { ...goal, ...changes, revision: goal.revision + 1 };

    save(next);

    return next;
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

  const needsUser = (ctx: ExtensionContext, goal: Goal): boolean => {
    const last = ctx.sessionManager
      .getBranch()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === HOLD_ENTRY
      );

    return (
      waitingForUI ||
      planBlocked(ctx) ||
      (last?.type === "custom" &&
        questionHold.check(last.data) &&
        last.data.goalId === goal.id &&
        last.data.waiting)
    );
  };

  const held = (ctx: ExtensionContext, goal: Goal): boolean =>
    needsUser(ctx, goal) || waitingOnChild(ctx);

  const start = (ctx: ExtensionContext, goal: Goal): void => {
    if (ctx.isIdle() && held(ctx, goal)) {
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

  registerUnlessTaken(
    pi,
    defineTool({
      annotations: { readOnlyHint: true },
      description:
        "Read the saved goal, including its current identity, revision, status, and evidence.",
      execute: (_id, params, _signal, _update, ctx) => {
        if (!getInput.check(params)) {
          throw new Error(REJECTED_UPDATE);
        }

        return Promise.resolve(goalResult(readGoal(ctx)));
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
      execute: (_id, params, signal, _update, ctx) => {
        const goal = readGoal(ctx);

        if (
          signal?.aborted ||
          !toolsOwned() ||
          !updateInput.check(params) ||
          goal?.status !== "active" ||
          goal.id !== params.goalId ||
          goal.revision !== params.revision ||
          (params.status === "complete" && params.evidence.length === 0) ||
          (params.status === "blocked" && !params.reason?.trim())
        ) {
          throw new Error(REJECTED_UPDATE);
        }

        return Promise.resolve(
          goalResult(
            change(goal, {
              evidence: params.evidence,
              reason: params.reason,
              status: params.status,
            })
          )
        );
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

  const applyCommand = async (
    command: GoalCommand,
    ctx: ExtensionCommandContext
  ): Promise<void> => {
    if (command.kind === "clear") {
      const id = ownedRun?.id;
      save(null);
      describe(ctx, null);
      await stop(ctx, id);

      return;
    }

    if (command.kind !== "pause") {
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
        evidence: [],
        id: randomUUID(),
        objective: command.objective,
        reason: null,
        revision: 1,
        status: "active",
      });

      return;
    }

    if (goal === null) {
      throw new Error("No goal saved.");
    }

    if (command.kind === "pause") {
      describe(
        ctx,
        goal.status === "paused" || goal.status === "complete"
          ? goal
          : change(goal, { reason: "User stop.", status: "paused" })
      );
      await stop(ctx, goal.id);

      return;
    }

    if (goal.status === "complete") {
      throw new Error("A completed goal cannot be edited or resumed.");
    }

    if (command.kind === "edit") {
      describe(
        ctx,
        change(goal, { evidence: [], objective: command.objective })
      );

      return;
    }

    if (goal.status === "active") {
      describe(ctx, goal);
    } else {
      activate(ctx, {
        ...goal,
        reason: null,
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
    waitingForUI = false;
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
  pi.on("ui_prompt_start", () => {
    waitingForUI = true;
  });
  pi.on("ui_prompt_end", () => {
    waitingForUI = false;
  });
  pi.on("input", (event, ctx) => {
    const goal = readGoal(ctx);

    if (
      goal?.status === "active" &&
      isChildWake(event.text) &&
      needsUser(ctx, goal)
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
  pi.on("tool_result", (event, ctx) => {
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
