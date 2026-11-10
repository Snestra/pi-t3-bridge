import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
  arr,
  bool,
  compile,
  lit,
  map,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { savedEntries } from "./branch.ts";
import {
  NO_RESET_MS,
  classifyFailure,
  reportedExhausted,
  worse,
} from "./failures.ts";
import type { Classified, FamilyOut } from "./failures.ts";
import { scheduleResume } from "./resume.ts";
import type { GoalIdentity } from "./resume.ts";
import { readState, updateState } from "./state.ts";
import { callT3Tool, insideT3 } from "./t3-http.ts";
import { t3Json } from "./t3-json.ts";
import {
  findT3Tool,
  isT3Tool,
  isTerminalStatus,
  runEnded,
} from "./t3-tasks.ts";
import { isDelegatedChild } from "./thread.ts";

// Which model families are out of usage. The marks live in one file for the
// whole machine, so every chat routes around a family as soon as any chat or
// child sees it fail. This session only remembers which of its own children
// it still has to check.

const ACCOUNT_ENTRY = "pi-t3-account";

const FAMILIES = "accounts.json";

// The commands that change the shared account state, as they appear in text:
// at the start of a line, or after a space, quote or bracket. Inside a path
// such as notes/t3-exhausted.md the slash follows a name, so it is not one.
export const ACCOUNT_COMMAND = /(?<![\w.~/-])\/t3-(?:exhausted|recovered)\b/u;

// A model's family is the first word of its ID's last part: claude, gpt, grok.
export const family = (model: string): string =>
  model.split("/").pop()?.split("-")[0] ?? model;

const MAX_READ_PAGES = 20;

// Enough of an error item's text to classify it, short enough that reading a
// child's activity never pulls its whole result into this session.
const ERROR_CHARS = 400;

// A probe that has not settled in this long is treated as lost, so a crashed
// chat cannot hold a family closed forever.
const PROBE_TIMEOUT_MS = 2 * 60 * 60_000;

const FamilyRecordSchema = union([
  obj(
    {
      reason: oneOf(["exhausted", "unhealthy"]),
      resetAt: opt(str()),
      since: str(),
      source: oneOf(["delegate", "user"]),
      state: lit("exhausted"),
    },
    { open: true }
  ),
  obj(
    { childThreadId: str(), since: str(), state: lit("probing") },
    { open: true }
  ),
]);

type FamilyRecord = Static<typeof FamilyRecordSchema>;

type Families = Readonly<Record<string, FamilyRecord>>;

const familiesFile = compile(
  obj({ families: map(FamilyRecordSchema) }, { open: true })
);

export const readFamilies = (): Families =>
  readState(FAMILIES, familiesFile)?.families ?? {};

// The change sees the family's record as it is under the lock, so a guard
// inside it cannot race another session.
const updateFamily = (
  name: string,
  change: (record: FamilyRecord | undefined) => FamilyRecord | undefined
): Promise<void> =>
  updateState(FAMILIES, familiesFile, (file) => {
    const others = Object.entries(file?.families ?? {}).filter(
      ([other]) => other !== name
    );

    const next = change(file?.families[name]);

    return {
      families: Object.fromEntries(
        next === undefined ? others : [...others, [name, next]]
      ),
    };
  });

const clear = (): undefined => undefined;

const AccountEventSchema = union([
  obj(
    { childThreadId: str(), family: str(), kind: lit("delegated") },
    { open: true }
  ),
  obj({ childThreadId: str(), kind: lit("settled") }, { open: true }),
]);

const isAccountEvent = compile(AccountEventSchema).check;

type AccountEvent = Static<typeof AccountEventSchema>;

const accountEvents = (ctx: ExtensionContext): AccountEvent[] =>
  savedEntries(ctx, ACCOUNT_ENTRY, isAccountEvent);

export const delegatedChildren = (ctx: ExtensionContext): string[] =>
  accountEvents(ctx).flatMap((event) =>
    event.kind === "delegated" ? [event.childThreadId] : []
  );

// The children whose outcome this session has not checked yet, by family.
const watching = (ctx: ExtensionContext): Map<string, string> => {
  const children = new Map<string, string>();

  for (const event of accountEvents(ctx)) {
    if (event.kind === "delegated") {
      children.set(event.childThreadId, event.family);
    } else {
      children.delete(event.childThreadId);
    }
  }

  return children;
};

type ExhaustedRecord = Extract<FamilyRecord, { state: "exhausted" }>;

// Marks written before every failure named its reset time have none.
const resetTime = (record: ExhaustedRecord): string =>
  record.resetAt ??
  new Date(Date.parse(record.since) + NO_RESET_MS).toISOString();

// A family is open when nothing marks it out: no mark, a reset time that has
// passed, or a probe that never settled. The next task then probes it.
const reopened = (record: FamilyRecord, now: number): boolean =>
  record.state === "exhausted"
    ? Date.parse(resetTime(record)) <= now
    : Date.parse(record.since) + PROBE_TIMEOUT_MS <= now;

export const familyOpen = (
  record: FamilyRecord | undefined,
  now = Date.now()
): boolean => record === undefined || reopened(record, now);

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

export const accountLines = (families: Families, now = Date.now()): string[] =>
  Object.entries(families)
    .filter(([, record]) => !familyOpen(record, now))
    .map(([name, record]) => {
      if (record.state === "probing") {
        return `${name}: its reset time has passed and its first attempt is still running, since ${shortTime(record.since)}.`;
      }

      return `${name}: ${exhaustedCause(record, name)}, since ${shortTime(record.since)}, until ${shortTime(resetTime(record))}.`;
    });

const markOut = (
  modelFamily: string,
  failure: FamilyOut,
  source: ExhaustedRecord["source"]
): Promise<void> => {
  // Taken now, when the failure was seen, not once the lock is free.
  const since = new Date().toISOString();

  return updateFamily(modelFamily, () => ({
    reason: failure.kind,
    resetAt: failure.resetAt,
    since,
    source,
    state: "exhausted",
  }));
};

const ThreadReadSchema = obj(
  {
    hasMore: bool(),
    items: arr(
      obj(
        { text: opt(nullable(str())), title: nullable(str()), type: str() },
        { open: true }
      )
    ),
    nextPosition: nullable(num()),
    recentRuns: opt(arr(obj({ status: str() }, { open: true }))),
    thread: obj({ status: str() }, { open: true }),
  },
  { open: true }
);

const threadRead = compile(ThreadReadSchema);

type ThreadRead = Static<typeof ThreadReadSchema>;

interface PageParams {
  readonly afterPosition?: number;
  readonly limit: number;
  readonly maxCharsPerItem: number;
  readonly threadId: string;
  readonly view: string;
}

type PageReader = (params: PageParams) => Promise<ThreadRead | undefined>;

const toolReader =
  (ctx: ExtensionToolContext, toolName: string): PageReader =>
  async (params) => {
    const outcome = await ctx.executeTool(toolName, params);

    return outcome.isError ? undefined : t3Json(threadRead, outcome.result);
  };

// A tool_result handler gets no ctx.executeTool, so it reads through T3 directly.
const httpReader: PageReader = async (params) => {
  const read = await callT3Tool("t3_thread_read", { ...params });

  return threadRead.check(read) ? read : undefined;
};

// The worst failure in the child's activity, or undefined while it runs.
const childFailure = async (
  read: PageReader,
  childThreadId: string
): Promise<Classified | undefined> => {
  let failure: Classified = { kind: "other" };
  let afterPosition: number | undefined;

  for (let pages = 0; pages < MAX_READ_PAGES; pages += 1) {
    const params = {
      limit: 100,
      maxCharsPerItem: ERROR_CHARS,
      threadId: childThreadId,
      view: "activity",
    };

    // Each page starts after the previous page's cursor.
    // oxlint-disable-next-line no-await-in-loop
    const page = await read(
      afterPosition === undefined ? params : { afterPosition, ...params }
    );

    if (
      page === undefined ||
      !isTerminalStatus(page.recentRuns?.[0]?.status ?? page.thread.status)
    ) {
      return undefined;
    }

    for (const item of page.items) {
      if (item.type === "error") {
        failure = worse(failure, classifyFailure({ message: item.text ?? "" }));
      }
    }

    if (!page.hasMore || page.nextPosition === null) {
      break;
    }

    afterPosition = page.nextPosition;
  }

  return failure;
};

const settleChild = async (
  pi: ExtensionAPI,
  read: PageReader,
  childThreadId: string,
  childFamily: string
): Promise<void> => {
  const failure = await childFailure(read, childThreadId);

  if (failure === undefined) {
    return;
  }

  pi.appendEntry(ACCOUNT_ENTRY, {
    childThreadId,
    kind: "settled",
  } satisfies AccountEvent);

  await (failure.kind === "other"
    ? updateFamily(childFamily, (record) =>
        record?.state === "probing" && record.childThreadId === childThreadId
          ? undefined
          : record
      )
    : markOut(childFamily, failure, "delegate"));
};

// Checks every child this session still watches, through T3's thread read
// tool, so routing sees the newest marks.
export const settleChildren = async (
  pi: ExtensionAPI,
  ctx: ExtensionToolContext
): Promise<void> => {
  const toolName = findT3Tool(ctx.tools, "t3_thread_read");

  if (toolName === undefined) {
    return;
  }

  const read = toolReader(ctx, toolName);

  await Promise.all(
    [...watching(ctx)].map(([childThreadId, childFamily]) =>
      settleChild(pi, read, childThreadId, childFamily)
    )
  );
};

const taskStatus = compile(
  obj(
    { childThreadId: str(), status: opt(str()), workState: opt(str()) },
    { open: true }
  )
);

const isDelegateInput = compile(
  obj({ target: opt(obj({ model: str() }, { open: true })) }, { open: true })
).check;

const delegateResult = compile(obj({ childThreadId: str() }, { open: true }));

// Recovery takes any family accounts.json records, such as kimi. Marking one
// out takes only a family of a model Pi knows, so a typo cannot add one.
const parseFamily = (
  word: string | undefined,
  names: readonly string[]
): string => {
  const name = (word ?? "").toLowerCase();
  const sorted = [...new Set(names)].toSorted();

  if (!sorted.includes(name)) {
    throw new Error(`Name a model family: ${sorted.join(", ")}.`);
  }

  return name;
};

const knownFamilies = (ctx: ExtensionContext): string[] =>
  ctx.modelRegistry.getAll().map((model) => family(model.id));

type LastRun =
  | { readonly family: string; readonly kind: "answered" }
  | {
      readonly family: string;
      readonly kind: "failed";
      readonly goal: GoalIdentity | undefined;
      readonly message: string;
    };

interface Accounts {
  // Records how the session's last run ended. bridge.ts runs it before the
  // goal settles, so a scheduled resume holds the goal open.
  readonly settle: (
    event: AgentSettledEvent,
    ctx: ExtensionContext
  ) => Promise<void>;
}

export const registerAccounts = (
  pi: ExtensionAPI,
  goalForRun: (ctx: ExtensionContext) => GoalIdentity | undefined
): Accounts => {
  // A finished child settles its family's mark as soon as the parent reads its
  // status: a usage limit marks the family out, and a clean finish ends a probe.
  pi.on("tool_result", async (event, ctx) => {
    if (
      !isT3Tool(event.toolName, "task_status") ||
      event.isError ||
      !insideT3()
    ) {
      return;
    }

    const status = t3Json(taskStatus, event);

    const childFamily =
      status === undefined
        ? undefined
        : watching(ctx).get(status.childThreadId);

    if (
      status === undefined ||
      childFamily === undefined ||
      !runEnded(status)
    ) {
      return;
    }

    try {
      await settleChild(pi, httpReader, status.childThreadId, childFamily);
    } catch {
      // The next task_status read, or pstack_model, settles it later.
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!isT3Tool(event.toolName, "delegate_task") || event.isError) {
      return;
    }

    const result = t3Json(delegateResult, event);
    const input = isDelegateInput(event.input) ? event.input : undefined;

    const model = input?.target?.model ?? ctx.model?.id;

    if (result === undefined || model === undefined) {
      return;
    }

    const childFamily = family(model);

    pi.appendEntry(ACCOUNT_ENTRY, {
      childThreadId: result.childThreadId,
      family: childFamily,
      kind: "delegated",
    } satisfies AccountEvent);

    await updateFamily(childFamily, (record) =>
      record !== undefined && reopened(record, Date.now())
        ? {
            childThreadId: result.childThreadId,
            since: new Date().toISOString(),
            state: "probing",
          }
        : record
    );
  });

  // This session's own model failed: a child or the orchestrator ran out, or
  // its account went unhealthy. Record it for every chat at once. The
  // orchestrator also schedules its own resume; a child's parent re-plans.
  // A model that answered proves its family's account works, so that clears
  // the family's mark for every chat. Pi can retry a failed run after
  // agent_end, so only how the last run ended, read once Pi settles, counts.
  // The family is the model that ran, since the user can switch models while
  // it streams.
  let lastRun: LastRun | undefined;

  pi.on("agent_end", (event, ctx) => {
    const last = event.messages.findLast(
      (message) => message.role === "assistant"
    );

    if (last?.role !== "assistant" || last.stopReason === "aborted") {
      lastRun = undefined;
    } else if (last.stopReason === "error") {
      lastRun = {
        family: family(last.model),
        goal: goalForRun(ctx),
        kind: "failed",
        message: last.errorMessage ?? "",
      };
    } else {
      lastRun = { family: family(last.model), kind: "answered" };
    }
  });

  pi.registerCommand("t3-exhausted", {
    description:
      "Mark a model family's account as out of usage for every chat: /t3-exhausted <family> [reset time]",
    handler: async (args, ctx) => {
      const [word, reset] = args.trim().split(/\s+/u);
      const exhausted = parseFamily(word, knownFamilies(ctx));

      if (reset !== undefined && Number.isNaN(Date.parse(reset))) {
        throw new Error(`"${reset}" is not a date and time.`);
      }

      await markOut(exhausted, reportedExhausted(reset), "user");

      if (ctx.hasUI) {
        ctx.ui.notify(`${exhausted} marked as out of usage.`, "info");
      }
    },
  });

  pi.registerCommand("t3-recovered", {
    description:
      "Mark a model family's account as usable again for every chat: /t3-recovered <family>",
    handler: async (args, ctx) => {
      const recovered = parseFamily(args.trim(), [
        ...knownFamilies(ctx),
        ...Object.keys(readFamilies()),
      ]);

      await updateFamily(recovered, clear);

      if (ctx.hasUI) {
        ctx.ui.notify(`${recovered} marked as usable again.`, "info");
      }
    },
  });

  return {
    settle: async (_event, ctx) => {
      const run = lastRun;

      lastRun = undefined;

      if (run === undefined) {
        return;
      }

      if (run.kind === "answered") {
        if (readFamilies()[run.family] !== undefined) {
          await updateFamily(run.family, clear);
        }

        return;
      }

      const failure = classifyFailure({ message: run.message });

      if (failure.kind === "other") {
        return;
      }

      await markOut(run.family, failure, "delegate");

      if (!(await isDelegatedChild())) {
        await scheduleResume(pi, ctx, run.family, failure, run.goal);
      }
    },
  };
};
