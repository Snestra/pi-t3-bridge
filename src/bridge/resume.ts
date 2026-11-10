import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { compile, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { savedEntries } from "./branch.ts";
import type { FamilyOut } from "./failures.ts";
import { callT3Tool, insideT3 } from "./t3-http.ts";

// When the orchestrator's own account runs out, nothing is left to call a
// tool, so the extension asks T3 to post a resume prompt into this thread
// after the reset, and deletes that schedule when the prompt arrives. T3
// schedules recur, so the delete is what makes it run once.

const RESUME_ENTRY = "pi-t3-resume";

// Start a little after the reset, so the account is open when the turn starts.
const AFTER_RESET_MS = 2 * 60_000;

const MARKER = /\[pi-t3-resume (?<marker>[\w-]+)\]/u;

// The saved goal run a resume continues, by ID and revision, so an old
// resume cannot restart a goal the user changed since.
const GoalIdentitySchema = obj({
  id: str({ minLength: 1 }),
  revision: int({ minimum: 1 }),
});

export type GoalIdentity = Static<typeof GoalIdentitySchema>;

const ResumeSchema = obj(
  {
    goal: opt(GoalIdentitySchema),
    marker: str(),
    scheduledTaskId: opt(str()),
    state: oneOf(["scheduled", "done"]),
  },
  { open: true }
);

type Resume = Static<typeof ResumeSchema>;

const isResume = compile(ResumeSchema).check;

const scheduled = compile(obj({ scheduledTaskId: str() }, { open: true }));

export const isResumePrompt = (text: string): boolean => MARKER.test(text);

const resumes = (ctx: ExtensionContext): Resume[] =>
  savedEntries(ctx, RESUME_ENTRY, isResume);

const pending = (ctx: ExtensionContext): Resume[] => {
  const all = resumes(ctx);

  const done = new Set(
    all.filter((entry) => entry.state === "done").map((entry) => entry.marker)
  );

  return all.filter(
    (entry) => entry.state === "scheduled" && !done.has(entry.marker)
  );
};

export const recoveryPending = (
  ctx: ExtensionContext,
  goal: GoalIdentity
): boolean =>
  pending(ctx).some(
    (entry) =>
      entry.goal?.id === goal.id && entry.goal.revision === goal.revision
  );

const pad = (value: number): string => String(value).padStart(2, "0");

export const scheduleResume = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modelFamily: string,
  failure: FamilyOut,
  goal: GoalIdentity | undefined
): Promise<void> => {
  if (!insideT3() || pending(ctx).length > 0) {
    return;
  }

  const at = new Date(
    Math.max(Date.parse(failure.resetAt), Date.now()) + AFTER_RESET_MS
  );

  const marker = Date.now().toString(36);

  const prompt = `[pi-t3-resume ${marker}] The previous turn stopped because the ${modelFamily} account ran out of usage or had no working connection. Its reset time has passed. Continue the work from where it stopped: read the task list, check what the last steps left, and go on.`;

  try {
    const result = await callT3Tool("schedule_task", {
      bindToCurrentThread: true,
      prompt,
      schedule: {
        timeOfDay: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
        type: "fixed_time",
        weekdays: [at.getDay()],
      },
      title: `pi-t3 resume after ${modelFamily} reset`,
    });

    pi.appendEntry(RESUME_ENTRY, {
      goal,
      marker,
      scheduledTaskId: scheduled.check(result)
        ? result.scheduledTaskId
        : undefined,
      state: "scheduled",
    } satisfies Resume);

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

// A resume for a goal run never reaches the model as a user prompt, even a
// late repeat of one already used: recoverGoal decides whether the goal still
// wants the work. A resume without a goal runs as the prompt it is.
export const registerResume = (
  pi: ExtensionAPI,
  recoverGoal: (ctx: ExtensionContext, goal: GoalIdentity) => void
): void => {
  const arrived = async (
    ctx: ExtensionContext,
    text: string
  ): Promise<Resume | undefined> => {
    const marker = MARKER.exec(text)?.groups?.marker;
    const entry = pending(ctx).find((candidate) => candidate.marker === marker);

    if (entry === undefined) {
      return undefined;
    }

    pi.appendEntry(RESUME_ENTRY, { marker: entry.marker, state: "done" });

    if (entry.scheduledTaskId !== undefined) {
      await callT3Tool("delete_scheduled_task", {
        scheduledTaskId: entry.scheduledTaskId,
      }).catch(() => null);
    }

    return entry;
  };

  pi.on("input", async (event, ctx) => {
    const marker = MARKER.exec(event.text)?.groups?.marker;

    const forGoal = resumes(ctx).find(
      (candidate) =>
        candidate.marker === marker && candidate.state === "scheduled"
    )?.goal;

    if (forGoal === undefined) {
      return;
    }

    if ((await arrived(ctx, event.text)) !== undefined) {
      recoverGoal(ctx, forGoal);
    }

    return { action: "handled" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType === "user") {
      await arrived(ctx, event.prompt);
    }
  });
};
