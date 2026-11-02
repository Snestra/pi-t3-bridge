import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { classifyFailure } from "./failures.ts";
import type { Classified } from "./failures.ts";
import { scheduleResume } from "./resume.ts";
import { readFamilies, updateFamily } from "./state.ts";
import type { FamilyRecord } from "./state.ts";
import { callT3Tool, insideT3 } from "./t3-http.ts";
import { t3Json } from "./t3-json.ts";
import { isDelegatedChild } from "./thread.ts";

// Which model families are out of usage. The state lives in one file for the
// whole machine (state.ts), so every chat routes around a family as soon as
// any chat or child sees it fail. This session only remembers which of its own
// children it still has to check.

const ACCOUNT_ENTRY = "pi-t3-account";

// A model's family is the first word of its ID's last part: claude, gpt, grok.
export const family = (model: string): string =>
  model.split("/").pop()?.split("-")[0] ?? model;

const THREAD_READ_TOOLS = [
  "mcp__t3-code__t3_thread_read",
  "mcp__t3__t3_thread_read",
] as const;

const DELEGATE_TOOLS: ReadonlySet<string> = new Set([
  "mcp__t3-code__delegate_task",
  "mcp__t3__delegate_task",
]);

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "rolled_back",
]);

const MAX_READ_PAGES = 20;

// Enough of an error item's text to classify it, short enough that reading a
// child's activity never pulls its whole result into this session.
const ERROR_CHARS = 400;

// A probe that has not settled in this long is treated as lost, so a crashed
// chat cannot hold a family closed forever.
const PROBE_TIMEOUT_MS = 2 * 60 * 60_000;

// A usage limit that names no reset time, or one the user reported without
// one, holds the family out this long. The next task then probes the family,
// and another limit marks it out again, so no mark waits on a person.
const NO_RESET_MS = 60 * 60_000;

const USAGE_LIMIT_TITLE = "Usage limit reached";

const AccountEventSchema = Type.Union([
  Type.Object({
    childThreadId: Type.String(),
    family: Type.String(),
    kind: Type.Literal("delegated"),
  }),
  Type.Object({ childThreadId: Type.String(), kind: Type.Literal("settled") }),
]);

type AccountEvent = Static<typeof AccountEventSchema>;

export interface Accounts {
  readonly delegated: readonly string[];
  readonly families: Readonly<Record<string, FamilyRecord>>;
  readonly watching: ReadonlyMap<string, string>;
}

type ExhaustedRecord = Extract<FamilyRecord, { state: "exhausted" }>;

const resetTime = (record: ExhaustedRecord): string =>
  record.resetAt ??
  new Date(Date.parse(record.since) + NO_RESET_MS).toISOString();

const resetPassed = (record: FamilyRecord | undefined, now: number): boolean =>
  record?.state === "exhausted" && Date.parse(resetTime(record)) <= now;

const probeLost = (record: FamilyRecord | undefined, now: number): boolean =>
  record?.state === "probing" &&
  Date.parse(record.since) + PROBE_TIMEOUT_MS <= now;

export const readAccounts = (ctx: ExtensionContext): Accounts => {
  const delegated: string[] = [];
  const watching = new Map<string, string>();

  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === ACCOUNT_ENTRY &&
      Value.Check(AccountEventSchema, entry.data)
    ) {
      const event: AccountEvent = entry.data;

      if (event.kind === "delegated") {
        delegated.push(event.childThreadId);
        watching.set(event.childThreadId, event.family);
      } else {
        watching.delete(event.childThreadId);
      }
    }
  }

  return { delegated, families: readFamilies(), watching };
};

export const familyAvailable = (
  accounts: Accounts,
  modelFamily: string,
  now = Date.now()
): boolean => {
  const record = accounts.families[modelFamily];

  return (
    record === undefined || resetPassed(record, now) || probeLost(record, now)
  );
};

const exhaustedCause = (
  record: ExhaustedRecord,
  modelFamily: string
): string => {
  if (record.source === "user") {
    return `The user reported the ${modelFamily} account exhausted`;
  }

  if (record.reason === "unhealthy") {
    return `${modelFamily} had no working account (overload or a dropped connection)`;
  }

  return `A ${modelFamily} model hit a usage limit`;
};

const shortTime = (iso: string): string =>
  `${iso.slice(0, 16).replace("T", " ")} UTC`;

// One line per family that is out, for the user rather than the model.
export const accountLines = (
  families: Readonly<Record<string, FamilyRecord>>,
  now = Date.now()
): string[] =>
  Object.entries(families)
    .filter(
      ([, record]) => !resetPassed(record, now) && !probeLost(record, now)
    )
    .map(([name, record]) => {
      if (record.state === "probing") {
        return `${name}: its reset time has passed and its first attempt is still running, since ${shortTime(record.since)}.`;
      }

      return `${name}: ${exhaustedCause(record, name)}, since ${shortTime(record.since)}, until ${shortTime(resetTime(record))}.`;
    });

export const recordFailure = (
  modelFamily: string,
  classified: Classified,
  source: "delegate" | "user"
): void => {
  if (classified.kind === "other") {
    return;
  }

  const record: ExhaustedRecord = {
    reason: classified.kind,
    since: new Date().toISOString(),
    source,
    state: "exhausted",
  };

  if (classified.resetAt !== undefined) {
    record.resetAt = classified.resetAt;
  }

  updateFamily(modelFamily, record);
};

const ThreadReadSchema = Type.Object({
  hasMore: Type.Boolean(),
  items: Type.Array(
    Type.Object({
      text: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      title: Type.Union([Type.String(), Type.Null()]),
      type: Type.String(),
    })
  ),
  nextPosition: Type.Union([Type.Number(), Type.Null()]),
  recentRuns: Type.Optional(Type.Array(Type.Object({ status: Type.String() }))),
  thread: Type.Object({ status: Type.String() }),
});

type ThreadRead = Static<typeof ThreadReadSchema>;

interface PageParams {
  readonly afterPosition?: number;
  readonly limit: number;
  readonly maxCharsPerItem: number;
  readonly threadId: string;
  readonly view: string;
}

type PageReader = (params: PageParams) => Promise<ThreadRead | undefined>;

const bridgeReader =
  (ctx: ExtensionToolContext, toolName: string): PageReader =>
  async (params) => {
    const outcome = await ctx.executeTool(toolName, params);

    return outcome.isError
      ? undefined
      : t3Json(ThreadReadSchema, outcome.result);
  };

// A tool_result handler gets no ctx.executeTool, so it reads through T3 directly.
export const httpReader: PageReader = async (params) => {
  const read = await callT3Tool("t3_thread_read", { ...params });

  return Value.Check(ThreadReadSchema, read) ? read : undefined;
};

type ChildOutcome =
  | { readonly kind: "running" }
  | { readonly failure: Classified; readonly kind: "settled" };

const NO_FAILURE: Classified = { kind: "other" };

const worse = (left: Classified, right: Classified): Classified => {
  const rank = { exhausted: 2, other: 0, unhealthy: 1 };

  return rank[right.kind] > rank[left.kind] ? right : left;
};

// Pages depend on the previous page's cursor, so they are read one after another.
const childOutcome = async (
  read: PageReader,
  childThreadId: string,
  cursor: { afterPosition?: number; failure: Classified; page: number }
): Promise<ChildOutcome> => {
  const params = {
    limit: 100,
    maxCharsPerItem: ERROR_CHARS,
    threadId: childThreadId,
    view: "activity",
  };

  const page = await read(
    cursor.afterPosition === undefined
      ? params
      : { afterPosition: cursor.afterPosition, ...params }
  );

  if (page === undefined) {
    return { kind: "running" };
  }

  const status = page.recentRuns?.[0]?.status ?? page.thread.status;

  if (!TERMINAL_STATUSES.has(status)) {
    return { kind: "running" };
  }

  let { failure } = cursor;

  for (const item of page.items) {
    if (item.type === "error") {
      failure = worse(
        failure,
        classifyFailure({
          class: item.title === USAGE_LIMIT_TITLE ? "usage_limit" : null,
          message: item.text ?? "",
        })
      );
    }
  }

  const lastPage =
    !page.hasMore ||
    page.nextPosition === null ||
    cursor.page + 1 >= MAX_READ_PAGES;

  if (lastPage) {
    return { failure, kind: "settled" };
  }

  return childOutcome(read, childThreadId, {
    afterPosition: page.nextPosition ?? undefined,
    failure,
    page: cursor.page + 1,
  });
};

export const settleChild = async (
  pi: ExtensionAPI,
  read: PageReader,
  childThreadId: string,
  childFamily: string
): Promise<void> => {
  const outcome = await childOutcome(read, childThreadId, {
    failure: NO_FAILURE,
    page: 0,
  });

  if (outcome.kind !== "settled") {
    return;
  }

  pi.appendEntry(ACCOUNT_ENTRY, {
    childThreadId,
    kind: "settled",
  } satisfies AccountEvent);

  const record = readFamilies()[childFamily];

  if (outcome.failure.kind !== "other") {
    recordFailure(childFamily, outcome.failure, "delegate");
  } else if (
    record?.state === "probing" &&
    record.childThreadId === childThreadId
  ) {
    updateFamily(childFamily);
  }
};

export const settleChildren = async (
  pi: ExtensionAPI,
  ctx: ExtensionToolContext
): Promise<void> => {
  const toolName = THREAD_READ_TOOLS.find((name) =>
    ctx.tools.some((tool) => tool.name === name)
  );

  if (toolName === undefined) {
    return;
  }

  const read = bridgeReader(ctx, toolName);

  await Promise.all(
    [...readAccounts(ctx).watching].map(([childThreadId, childFamily]) =>
      settleChild(pi, read, childThreadId, childFamily)
    )
  );
};

const STATUS_TOOLS: ReadonlySet<string> = new Set([
  "mcp__t3-code__task_status",
  "mcp__t3__task_status",
]);

const StatusSchema = Type.Object({
  childThreadId: Type.String(),
  status: Type.Optional(Type.String()),
  workState: Type.Optional(Type.String()),
});

const DelegateInputSchema = Type.Object({
  target: Type.Optional(Type.Object({ model: Type.String() })),
});

const DelegateResultSchema = Type.Object({ childThreadId: Type.String() });

const sessionFamily = (ctx: ExtensionContext): string | undefined =>
  ctx.model === undefined ? undefined : family(ctx.model.id);

const AssistantErrorSchema = Type.Object({
  errorMessage: Type.Optional(Type.String()),
  model: Type.String(),
  role: Type.Literal("assistant"),
  stopReason: Type.String(),
});

// Recovery takes any family accounts.json records, such as kimi. Marking one
// out takes only a family of a model Pi knows, so a typo cannot add one.
const parseFamily = (
  word: string | undefined,
  ctx: ExtensionContext,
  { recorded }: { readonly recorded: boolean }
): string => {
  const name = (word ?? "").toLowerCase();

  const known = ctx.modelRegistry.getAll().map((model) => family(model.id));

  const names = [
    ...new Set(recorded ? [...known, ...Object.keys(readFamilies())] : known),
  ].toSorted();

  if (!names.includes(name)) {
    throw new Error(`Name a model family: ${names.join(", ")}.`);
  }

  return name;
};

export const registerAccounts = (pi: ExtensionAPI): void => {
  // A finished child settles its family's mark as soon as the parent reads its
  // status: a usage limit marks the family out, and a clean finish ends a probe.
  pi.on("tool_result", async (event, ctx) => {
    if (!STATUS_TOOLS.has(event.toolName) || event.isError || !insideT3()) {
      return;
    }

    const status = t3Json(StatusSchema, event);

    const childFamily =
      status === undefined
        ? undefined
        : readAccounts(ctx).watching.get(status.childThreadId);

    const finished =
      (status?.status !== undefined && TERMINAL_STATUSES.has(status.status)) ||
      status?.workState === "result_available";

    if (status === undefined || childFamily === undefined || !finished) {
      return;
    }

    try {
      await settleChild(pi, httpReader, status.childThreadId, childFamily);
    } catch {
      // The next task_status read, or pstack_model, settles it later.
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (!DELEGATE_TOOLS.has(event.toolName) || event.isError) {
      return;
    }

    const result = t3Json(DelegateResultSchema, event);

    const input = Value.Check(DelegateInputSchema, event.input)
      ? event.input
      : undefined;

    const childFamily =
      input?.target === undefined
        ? sessionFamily(ctx)
        : family(input.target.model);

    if (result === undefined || childFamily === undefined) {
      return;
    }

    pi.appendEntry(ACCOUNT_ENTRY, {
      childThreadId: result.childThreadId,
      family: childFamily,
      kind: "delegated",
    } satisfies AccountEvent);

    const record = readFamilies()[childFamily];
    const now = Date.now();

    if (resetPassed(record, now) || probeLost(record, now)) {
      updateFamily(childFamily, {
        childThreadId: result.childThreadId,
        since: new Date(now).toISOString(),
        state: "probing",
      });
    }
  });

  // This session's own model failed: a child or the orchestrator ran out, or
  // its account went unhealthy. Record it for every chat at once. The
  // orchestrator also schedules its own resume; a child's parent re-plans.
  // A model that answered proves its family's account works, so that clears
  // the family's mark for every chat. Pi can retry a failed run after
  // agent_end, so only how the last run ended, read once Pi settles, counts.
  // The family is the model that ran, since the user can switch models while
  // it streams.
  let lastRun:
    | { readonly family: string; readonly kind: "answered" }
    | {
        readonly family: string;
        readonly kind: "failed";
        readonly message: string;
      }
    | undefined;

  pi.on("agent_end", (event) => {
    // SAFETY: only reads `role`, which every agent message carries.
    const last = event.messages.findLast(
      (message) => (message as { role?: string }).role === "assistant"
    );

    if (!Value.Check(AssistantErrorSchema, last)) {
      lastRun = undefined;
    } else if (last.stopReason === "error") {
      lastRun = {
        family: family(last.model),
        kind: "failed",
        message: last.errorMessage ?? "",
      };
    } else {
      lastRun =
        last.stopReason === "aborted"
          ? undefined
          : { family: family(last.model), kind: "answered" };
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const run = lastRun;

    lastRun = undefined;

    if (run === undefined) {
      return;
    }

    if (run.kind === "answered") {
      if (readFamilies()[run.family] !== undefined) {
        updateFamily(run.family);
      }

      return;
    }

    const classified = classifyFailure({ message: run.message });

    recordFailure(run.family, classified, "delegate");

    if (classified.kind !== "other" && !(await isDelegatedChild())) {
      await scheduleResume(pi, ctx, run.family, classified);
    }
  });

  pi.registerCommand("t3-exhausted", {
    description:
      "Mark a model family's account as out of usage for every chat: /t3-exhausted <family> [reset time]",
    handler: async (args, ctx) => {
      const [word, reset] = args.trim().split(/\s+/u);
      const exhaustedFamily = parseFamily(word, ctx, { recorded: false });

      if (reset !== undefined && Number.isNaN(Date.parse(reset))) {
        throw new Error(`"${reset}" is not a date and time.`);
      }

      recordFailure(
        exhaustedFamily,
        reset === undefined
          ? { kind: "exhausted" }
          : { kind: "exhausted", resetAt: new Date(reset).toISOString() },
        "user"
      );

      if (ctx.hasUI) {
        ctx.ui.notify(`${exhaustedFamily} marked as out of usage.`, "info");
      }
    },
  });

  pi.registerCommand("t3-recovered", {
    description:
      "Mark a model family's account as usable again for every chat: /t3-recovered <family>",
    handler: async (args, ctx) => {
      const recovered = parseFamily(args.trim(), ctx, { recorded: true });

      updateFamily(recovered);

      if (ctx.hasUI) {
        ctx.ui.notify(`${recovered} marked as usable again.`, "info");
      }
    },
  });
};
