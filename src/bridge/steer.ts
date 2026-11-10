import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent,
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";

import { readConfig } from "./config.ts";
import { appendLog } from "./state.ts";
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
  sincePrompt,
  mastExcerpt,
  stopInput,
} from "./steer-transcript.ts";
import { waitingOnChild } from "./t3-tasks.ts";
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

// A judge that takes longer must not hold up the end of a run. Without Jev the
// judge is a chat model reading a 50 KiB prompt, and those calls took 1.7-5.9 s:
// a 5 s ceiling cut off most of them, so 15 s leaves room for the slow ones.
const JUDGE_TIMEOUT_MS = 15_000;

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
    sincePrompt(branch).filter((entry) => groupOf(entry) === group).length >=
    NUDGE_LIMITS[group]
  );
};

// Whether the newest note this feature added in the prompt, of either kind,
// is a stop nudge.
const lastNoteIsStopNudge = (ctx: ExtensionContext): boolean => {
  const branch = ctx.sessionManager.getBranch();

  const last = sincePrompt(branch).findLast(
    (entry) =>
      entry.type === "custom_message" &&
      (entry.customType === STEER_NOTE || entry.customType === MAST_NOTE)
  );

  return last?.type === "custom_message" && last.customType === STEER_NOTE;
};

interface SteerLogLine {
  readonly capped?: boolean;
  readonly error?: string;
  readonly fired?: readonly string[];
  readonly kind: string;
  readonly mode: string;
  readonly model: string;
  readonly nudged: boolean;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly session: string;
  readonly skipped?: "deadline";
  readonly turn?: number;
  readonly verdict?: {
    readonly handoffMissing?: number | undefined;
    readonly kind: string;
    readonly unfinished: number;
  };
}

// One line per check, beside the ledger. It holds the verdict and never
// transcript text. A log that cannot be written must not break a session.
const appendSteerLog = (line: SteerLogLine): void => {
  try {
    appendLog("steer.jsonl", { time: new Date().toISOString(), ...line });
  } catch {
    // The check already ran.
  }
};

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
  goalOwnsRun: () => boolean
): void => {
  let rule: string | undefined;
  let warned = false;

  const warnOnce = (ctx: ExtensionContext, error: string): void => {
    if (!warned) {
      warned = true;
      tell(ctx, `steer unavailable: ${error}`, "warning");
    }
  };

  // A judge the user cancelled drops the check quietly. One the deadline cut
  // off is skipped and logged, because the classifier is not down. Any other
  // error is logged and warned about once.
  const judgeFailed = (
    ctx: ExtensionContext,
    signal: AbortSignal,
    line: SteerLogLine,
    error: string
  ): void => {
    if (!signal.aborted) {
      appendSteerLog({ ...line, error });
      warnOnce(ctx, error);
    } else if (!ctx.signal?.aborted) {
      appendSteerLog({ ...line, skipped: "deadline" });
    }
  };

  // MAST state, per prompt.
  let armed = new Set<string>();
  let turn = 0;
  let scopeFrom: number | undefined;
  let awaitingPrompt = false;
  let lastTurnHadTools = false;

  // A prompt starts with every mode armed, its turns counted from zero, and
  // the MAST judge reading from where the branch stands.
  const startPrompt = (from?: number): void => {
    armed = new Set(mastModes().map((mode) => mode.code));
    turn = 0;
    scopeFrom = from;
  };

  // Each mode fires once per prompt. It fires again only after a check puts
  // it back under its threshold.
  // A held mode stays armed, so it can still fire later in the prompt.
  const decide = (
    probabilities: Readonly<Record<string, number>>,
    held: (mode: MastMode) => boolean
  ) =>
    mastModes().filter((mode) => {
      if (held(mode)) {
        return false;
      }

      if ((probabilities[mode.code] ?? 0) < mode.threshold) {
        armed.add(mode.code);

        return false;
      }

      return armed.delete(mode.code);
    });

  pi.on("session_start", () => {
    warned = false;
    startPrompt();
  });

  pi.on("before_agent_start", (event, ctx) => {
    rule = handoffRule(event.systemPromptOptions.contextFiles);
    startPrompt(ctx.sessionManager.getBranch().length);
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
      startPrompt(ctx.sessionManager.getBranch().length);
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

    const mode = readConfig().steer;
    const every = mastEvery();

    if (mode === "off" || turn % every !== 0) {
      return;
    }

    const excerpt = mastExcerpt(ctx.sessionManager.getBranch(), scopeFrom);

    if (excerpt === undefined) {
      return;
    }

    const base = {
      kind: "mast",
      mode,
      model: event.message.role === "assistant" ? event.message.model : "",
      session: ctx.sessionManager.getSessionId(),
      turn,
    };

    const signal = judgeSignal(ctx);

    const verdict = await judgeMast(ctx, excerpt, signal);

    if ("error" in verdict) {
      judgeFailed(ctx, signal, { ...base, nudged: false }, verdict.error);

      return;
    }

    const stopNudged = lastNoteIsStopNudge(ctx);

    const fired = decide(
      verdict.probabilities,
      (fire) => fire.quietAfterStopNudge === true && stopNudged
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
    const mode = readConfig().steer;

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
        ? stopInput(branch, (await isDelegatedChild()) ? undefined : rule)
        : undefined;

    if (input === undefined) {
      return;
    }

    const signal = judgeSignal(ctx);

    const verdict = await judgeStop(ctx, input, signal);

    if ("error" in verdict) {
      judgeFailed(
        ctx,
        signal,
        { ...base, kind: "stop", nudged: false },
        verdict.error
      );

      return;
    }

    // A goal can take the run over while the judge thinks.
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
