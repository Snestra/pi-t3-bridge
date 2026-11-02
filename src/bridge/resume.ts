import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { Classified } from "./failures.ts";
import { callT3Tool, insideT3 } from "./t3-http.ts";

// When the orchestrator's own account runs out, nothing is left to call a
// tool, so the extension asks T3 to post a resume prompt into this thread
// after the reset, and deletes that schedule when the prompt arrives. T3
// schedules recur, so the delete is what makes it run once.

const RESUME_ENTRY = "pi-t3-resume";

// With no reset time in the error, try again after this long.
const UNKNOWN_RESET_MS = 60 * 60_000;

// Start a little after the reset, so the account is open when the turn starts.
const AFTER_RESET_MS = 2 * 60_000;

const MARKER = /\[pi-t3-resume (?<marker>[\w-]+)\]/u;

const ResumeSchema = Type.Object({
  marker: Type.String(),
  scheduledTaskId: Type.Optional(Type.String()),
  state: Type.Union([Type.Literal("scheduled"), Type.Literal("done")]),
});

const ScheduledSchema = Type.Object({ scheduledTaskId: Type.String() });

const resumes = (ctx: ExtensionContext) =>
  ctx.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" &&
      entry.customType === RESUME_ENTRY &&
      Value.Check(ResumeSchema, entry.data)
        ? [entry.data]
        : []
    );

const pending = (ctx: ExtensionContext) => {
  const all = resumes(ctx);

  const done = new Set(
    all.filter((entry) => entry.state === "done").map((entry) => entry.marker)
  );

  return all.filter(
    (entry) => entry.state === "scheduled" && !done.has(entry.marker)
  );
};

const twoDigits = (value: number): string => String(value).padStart(2, "0");

export const scheduleResume = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modelFamily: string,
  failure: Classified
): Promise<void> => {
  if (!insideT3() || pending(ctx).length > 0) {
    return;
  }

  const resetAt =
    failure.resetAt === undefined
      ? Date.now() + UNKNOWN_RESET_MS
      : Date.parse(failure.resetAt);

  const at = new Date(Math.max(resetAt, Date.now()) + AFTER_RESET_MS);
  const marker = `${Date.now().toString(36)}`;

  const prompt = `[pi-t3-resume ${marker}] The previous turn stopped because the ${modelFamily} account ran out of usage or had no working connection. Its reset time has passed. Continue the work from where it stopped: read the task list, check what the last steps left, and go on.`;

  try {
    const result = await callT3Tool("schedule_task", {
      bindToCurrentThread: true,
      prompt,
      schedule: {
        timeOfDay: `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`,
        type: "fixed_time",
        weekdays: [at.getDay()],
      },
      title: `pi-t3 resume after ${modelFamily} reset`,
    });

    const scheduled: Static<typeof ResumeSchema> = {
      marker,
      state: "scheduled",
    };

    if (Value.Check(ScheduledSchema, result)) {
      scheduled.scheduledTaskId = result.scheduledTaskId;
    }

    pi.appendEntry(RESUME_ENTRY, scheduled);

    if (ctx.hasUI) {
      ctx.ui.notify(
        `${modelFamily} is out. This chat resumes at ${at.toLocaleString()}.`,
        "warning"
      );
    }
  } catch (error) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `${modelFamily} is out, and scheduling a resume failed: ${String(error)}`,
        "error"
      );
    }
  }
};

export const registerResume = (pi: ExtensionAPI): void => {
  pi.on("before_agent_start", async (event, ctx) => {
    const marker = MARKER.exec(
      event.messageType === "user" ? event.prompt : ""
    )?.[1];

    if (marker === undefined) {
      return;
    }

    const entry = pending(ctx).find((candidate) => candidate.marker === marker);

    if (entry === undefined) {
      return;
    }

    pi.appendEntry(RESUME_ENTRY, { marker, state: "done" });

    if (entry.scheduledTaskId !== undefined) {
      await callT3Tool("delete_scheduled_task", {
        scheduledTaskId: entry.scheduledTaskId,
      }).catch(() => null);
    }
  });
};
