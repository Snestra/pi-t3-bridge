import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent,
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { bool, compile, obj, opt, str } from "@earendil-works/pi-schema";

import { TERMINAL_STATUSES } from "./accounts.ts";
import { readConfig } from "./config.ts";
import { appendSteerLog } from "./state.ts";
import {
  judgeMast,
  judgeStop,
  mastEvery,
  mastModes,
  stopThresholds,
} from "./steer-judge.ts";
import type { MastMode, StopVerdict } from "./steer-judge.ts";
import {
  MAST_NOTE,
  STEER_NOTE,
  handoffRule,
  isUser,
  mastExcerpt,
  stopInput,
} from "./steer-transcript.ts";
import { t3Json, t3Text } from "./t3-json.ts";
import { isDelegatedChild } from "./thread.ts";

// When a run is about to stop, ask Jev how it ended. A run that quit early
// gets a note and one more turn. During a run, five MAST checks add notes
// every few turns. The idea, the classifier call, and the MAST cadence,
// arming, and prompt scope come from pi-mast-steer (MIT,
// github.com/dbreunig/pi-mast-steer), which only adds notes and never
// continues a stopped run.

// Per user prompt, so a model that keeps quitting cannot loop. A model that
// stops again after a stop nudge has already reconsidered, and every second
// stop nudge in the user's sessions was wrong. A reply cut off at the output
// limit can need more than one continuation.
const NUDGE_LIMITS = { length: 2, stop: 1 } as const;

type NudgeGroup = keyof typeof NUDGE_LIMITS;

const UNAWARE_OF_TERMINATION = "1.5";

// A judge that takes longer must not hold up the end of a run.
const JUDGE_TIMEOUT_MS = 5000;

type NudgeKind = "early" | "handoff" | "length";

const noteText = (kind: NudgeKind, probability = 0): string => {
  const p = probability.toFixed(2);

  if (kind === "length") {
    return "Steer · Cut off: Your last message hit the output limit. Continue exactly where it stopped.";
  }

  return kind === "handoff"
    ? `Steer · No handoff (p=${p}): Your last message has no "What I need from you" section. Reply with only that section: numbered concrete asks, or "Nothing needed from you right now". Don't redo any work.`
    : `Steer · Stopped early (p=${p}): You stopped before the task was done. Do the next step yourself. Stop only when the task is finished or you need something only the user can give, and then end with the "What I need from you" section.`;
};

// Pi replaces the whole entry list with what a handler returns, so the
// entries other handlers proposed are kept.
const nudge = (
  event: AgentBeforeSettleEvent,
  kind: NudgeKind,
  probability?: number
): BoundaryResult => ({
  continue: true,
  entries: [
    ...event.entries,
    {
      content: noteText(kind, probability),
      customType: STEER_NOTE,
      details: { kind, probability },
      display: true,
      type: "custom_message",
    },
  ],
});

const noteDetails = compile(obj({ kind: opt(str()) }, { open: true }));

const groupOf = (entry: SessionEntry): NudgeGroup | undefined => {
  if (entry.type !== "custom_message" || entry.customType !== STEER_NOTE) {
    return undefined;
  }

  return noteDetails.check(entry.details) && entry.details.kind === "length"
    ? "length"
    : "stop";
};

// Counted from the branch, so the limit holds across a reload. A nudge is a
// custom message, not a user message, so it does not reset the count.
const atLimit = (ctx: ExtensionContext, group: NudgeGroup): boolean => {
  const branch = ctx.sessionManager.getBranch();

  return (
    branch
      .slice(branch.findLastIndex(isUser) + 1)
      .filter((entry) => groupOf(entry) === group).length >= NUDGE_LIMITS[group]
  );
};

// The newest note this feature added in the prompt, of either kind. MAST 1.5
// ("you may be continuing past the end") would contradict a stop nudge sent
// just before it, so it stays quiet then.
const lastNoteIsStopNudge = (ctx: ExtensionContext): boolean => {
  const branch = ctx.sessionManager.getBranch();

  const last = branch
    .slice(branch.findLastIndex(isUser) + 1)
    .findLast(
      (entry) =>
        entry.type === "custom_message" &&
        (entry.customType === STEER_NOTE || entry.customType === MAST_NOTE)
    );

  return last?.type === "custom_message" && last.customType === STEER_NOTE;
};

const DELEGATE_TOOL = /(?:^|__)delegate_task$/u;

// Results that report one delegated task's state.
const TASK_TOOL = /(?:^|__)(?:delegate_task|task_status|task_cancel)$/u;

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

// How T3 wakes the parent, for example
// "Delegated task node:… (Research pi stop lifecycle) [completed]".
const WAKE = /Delegated task (?<taskId>\S+) .*?\[(?<status>[a-z_]+)\]/gu;

// A child whose own turn finished while its children still run is not done.
const finishedTask = (task: {
  readonly hasPendingChildRuns?: boolean;
  readonly status?: string;
  readonly workState?: string;
}): boolean =>
  task.hasPendingChildRuns !== true &&
  task.workState !== "waiting_for_children" &&
  ((task.status !== undefined && TERMINAL_STATUSES.has(task.status)) ||
    task.workState === "result_available");

const userText = (entry: SessionEntry): string =>
  entry.type === "message" && entry.message.role === "user"
    ? t3Text({
        content: isString(entry.message.content)
          ? [{ text: entry.message.content }]
          : entry.message.content,
      })
    : "";

// T3 tells an orchestrator to end its turn while a delegated child runs, and
// wakes it with a new prompt when the child finishes. A "keep going" nudge
// then would make it poll, which T3 forbids. Each task's latest state is
// followed across wake-ups, since one child can wake the parent while another
// still runs. A delegate call made inside a codemode script shows only as a
// nested call with no task ID, so it counts until the prompt ends, unless its
// mode is "wait".
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
      TASK_TOOL.test(entry.message.toolName) &&
      !entry.message.isError
    ) {
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
    branch
      .slice(branch.findLastIndex(isUser) + 1)
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          (entry.message.nestedCalls?.calls ?? []).some(
            (call) =>
              DELEGATE_TOOL.test(call.name) &&
              call.status === "ok" &&
              call.arguments?.mode !== "wait"
          )
      )
  );
};

// On unless the config says otherwise. Shadow judges and logs but never
// changes the session.
const steerMode = () => readConfig().steer ?? "on";

// T3 hands a delegated child's last message to its parent as the result, so
// a turn that writes only the section would replace the child's answer.

const mastNote = (mode: MastMode, probability: number) => ({
  content: `MAST · ${mode.label} (p=${probability.toFixed(2)}): ${mode.note}`,
  customType: MAST_NOTE,
  details: { code: mode.code, probability },
  display: true,
  type: "custom_message" as const,
});

// "Keep going" comes first, because writing the section is pointless while
// the work is unfinished.
const chooseNudge = (
  ctx: ExtensionContext,
  verdict: Exclude<StopVerdict, { readonly error: string }>
): { kind: "early" | "handoff"; probability: number } | undefined => {
  const { handoff, unfinished } = stopThresholds();

  if (
    (verdict.kind === "gave_up_midway" ||
      verdict.kind === "asked_permission") &&
    verdict.unfinished >= unfinished &&
    !waitingOnChild(ctx)
  ) {
    return { kind: "early", probability: verdict.unfinished };
  }

  // A child is not asked the handoff question, so it never gets this nudge.
  return verdict.handoffMissing !== undefined &&
    verdict.handoffMissing >= handoff
    ? { kind: "handoff", probability: verdict.handoffMissing }
    : undefined;
};

const finalAssistant = (
  branch: readonly SessionEntry[]
): AssistantMessage | undefined => {
  const final = branch.findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant"
  );

  return final?.type === "message" && final.message.role === "assistant"
    ? final.message
    : undefined;
};

const tell = (
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning"
): void => {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
};

// Cancelling the run cancels the judge too.
const judgeSignal = (ctx: ExtensionContext): AbortSignal =>
  AbortSignal.any([
    AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    ...(ctx.signal ? [ctx.signal] : []),
  ]);

export const registerSteer = (
  pi: ExtensionAPI,
  goalOwnsRun: () => boolean = () => false
): void => {
  let rule: string | undefined;
  let warned = false;

  // Whether this session is a delegated child, found once per session.
  let delegated: boolean | undefined;

  const reportsToParent = async (): Promise<boolean> => {
    delegated ??= await isDelegatedChild();

    return delegated;
  };

  const warnOnce = (ctx: ExtensionContext, error: string): void => {
    if (!warned) {
      warned = true;
      tell(ctx, `steer unavailable: ${error}`, "warning");
    }
  };

  // MAST state, per prompt.
  let armed = new Set<string>();
  let turn = 0;
  let scopeFrom: number | undefined;
  let awaitingPrompt = false;
  let lastTurnHadTools = false;

  const arm = (): void => {
    armed = new Set(mastModes().map((mode) => mode.code));
  };

  // Each mode fires once per prompt. It fires again only after a check puts
  // it back under its threshold.
  const decide = (probabilities: Readonly<Record<string, number>>) =>
    mastModes().filter((mode) => {
      if ((probabilities[mode.code] ?? 0) < mode.threshold) {
        armed.add(mode.code);

        return false;
      }

      return armed.delete(mode.code);
    });

  pi.on("session_start", () => {
    delegated = undefined;
    warned = false;
    arm();
    turn = 0;
    scopeFrom = undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    rule = handoffRule(event.systemPromptOptions.contextFiles);
    arm();
    turn = 0;
    scopeFrom = ctx.sessionManager.getBranch().length;
    awaitingPrompt = true;
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") {
      return;
    }

    if (awaitingPrompt) {
      awaitingPrompt = false;

      return;
    }

    // Pi delivers follow-ups only once the agent would stop, after a turn
    // without tool calls. A user message between tool turns steers the same
    // prompt.
    if (!lastTurnHadTools) {
      arm();
      turn = 0;
      scopeFrom = ctx.sessionManager.getBranch().length;
    }
  });

  pi.on("turn_end", async (event, ctx): Promise<BoundaryResult | undefined> => {
    awaitingPrompt = false;
    lastTurnHadTools = event.toolResults.length > 0;

    // Failed and aborted turns, including retries, would look like repeated
    // empty steps.
    if (event.outcome !== "completed") {
      return;
    }

    turn += 1;

    const mode = steerMode();
    const every = mastEvery();

    if (mode === "off" || turn < every || turn % every !== 0) {
      return;
    }

    const excerpt = mastExcerpt(ctx.sessionManager.getBranch(), scopeFrom);

    if (excerpt === undefined) {
      return;
    }

    const verdict = await judgeMast(ctx, excerpt, judgeSignal(ctx));

    // The user cancelled while the judge ran: drop the check quietly.
    if ("error" in verdict && ctx.signal?.aborted) {
      return;
    }

    const base = {
      kind: "mast",
      mode,
      model: event.message.role === "assistant" ? event.message.model : "",
      session: ctx.sessionManager.getSessionId(),
      turn,
    };

    if ("error" in verdict) {
      appendSteerLog({ ...base, error: verdict.error, nudged: false });
      warnOnce(ctx, verdict.error);

      return;
    }

    const fired = decide(verdict.probabilities).filter(
      (fire) =>
        fire.code !== UNAWARE_OF_TERMINATION || !lastNoteIsStopNudge(ctx)
    );

    const noted = mode === "on" && fired.length > 0;

    appendSteerLog({
      ...base,
      fired: fired.map((fire) => fire.code),
      nudged: noted,
      probabilities: verdict.probabilities,
    });

    return noted
      ? {
          entries: [
            ...event.entries,
            ...fired.map((fire) =>
              mastNote(fire, verdict.probabilities[fire.code] ?? 0)
            ),
          ],
        }
      : undefined;
  });

  const beforeSettle = async (
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext
  ): Promise<BoundaryResult | undefined> => {
    const mode = steerMode();

    // An error outcome is left to accounts.ts, which schedules the resume.
    if (mode === "off" || event.outcome !== "completed") {
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const last = finalAssistant(branch);

    if (last === undefined) {
      return;
    }

    const base = {
      mode,
      model: last.model,
      session: ctx.sessionManager.getSessionId(),
    };

    // Shadow mode only judges and logs, so it never continues a run. A nudge
    // the limit holds back is logged as capped and not shown.
    if (last.stopReason === "length") {
      const capped = mode === "on" && atLimit(ctx, "length");
      const nudged = mode === "on" && !capped;

      appendSteerLog({ ...base, capped, kind: "length", nudged });

      return nudged ? nudge(event, "length") : undefined;
    }

    const input =
      last.stopReason === "stop"
        ? stopInput(branch, (await reportsToParent()) ? undefined : rule)
        : undefined;

    if (input === undefined) {
      return;
    }

    const verdict = await judgeStop(ctx, input, judgeSignal(ctx));

    // The user cancelled while the judge ran: drop the check quietly.
    if ("error" in verdict) {
      if (!ctx.signal?.aborted) {
        appendSteerLog({
          ...base,
          error: verdict.error,
          kind: "stop",
          nudged: false,
        });

        warnOnce(ctx, verdict.error);
      }

      return;
    }

    if (goalOwnsRun()) {
      return;
    }

    const chosen = chooseNudge(ctx, verdict);

    const capped =
      mode === "on" && chosen !== undefined && atLimit(ctx, "stop");

    const nudged = mode === "on" && chosen !== undefined && !capped;

    appendSteerLog({ ...base, capped, kind: "stop", nudged, verdict });

    return nudged ? nudge(event, chosen.kind, chosen.probability) : undefined;
  };

  pi.on("agent_before_settle", (event, ctx) =>
    goalOwnsRun() ? undefined : beforeSettle(event, ctx)
  );
};
