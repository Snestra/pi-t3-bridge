import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { accountLines, readAccounts } from "./accounts.ts";
import { appendLedger, readLedger } from "./state.ts";
import type { LedgerLine } from "./state.ts";
import { isDelegated, ownThreadId } from "./thread.ts";

// What this thread and its children cost, from what Pi already records on
// each assistant message and what each child wrote to the ledger. It reads
// only local files, so asking costs no tokens and no T3 calls. A child can
// write several lines, such as its cost and a report, and later values win.

interface Usage {
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  input: number;
  replies: number;
  tokens: number;
}

const NO_USAGE: Readonly<Usage> = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  input: 0,
  replies: 0,
  tokens: 0,
};

const assistantMessages = (ctx: ExtensionContext): AssistantMessage[] =>
  ctx.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "assistant"
        ? [entry.message]
        : []
    );

// Sessions written by older Pi versions can lack usage fields.
const sumUsage = (messages: readonly AssistantMessage[]): Usage => {
  const sum = { ...NO_USAGE };

  for (const message of messages) {
    sum.cacheRead += message.usage?.cacheRead ?? 0;
    sum.cacheWrite += message.usage?.cacheWrite ?? 0;
    sum.cost += message.usage?.cost?.total ?? 0;
    sum.input += message.usage?.input ?? 0;
    sum.replies += 1;
    sum.tokens += message.usage?.totalTokens ?? 0;
  }

  return sum;
};

const hitRate = (input: number, cacheRead: number, cacheWrite: number) => {
  const prompt = input + cacheRead + cacheWrite;

  return prompt === 0 ? "n/a" : `${Math.round((cacheRead / prompt) * 100)}%`;
};

const count = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`;
  }

  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
};

const dollars = (cost: number): string => `$${cost.toFixed(2)}`;

// T3 child thread IDs share a long prefix and differ at the end.
const shortId = (threadId: string): string =>
  threadId.length > 12 ? `…${threadId.slice(-11)}` : threadId;

const childLine = (threadId: string, line: LedgerLine | undefined): string => {
  const id = shortId(threadId).padEnd(12);

  if (line === undefined) {
    return `  ${id}  no ledger line yet`;
  }

  const { cacheRead, cacheWrite, input } = line;

  const cache =
    cacheRead === undefined || cacheWrite === undefined || input === undefined
      ? "n/a"
      : hitRate(input, cacheRead, cacheWrite);

  return [
    `  ${id}`,
    (line.status ?? "?").padEnd(7),
    (line.job ?? "?").padEnd(10),
    (line.model ?? "?").padEnd(18),
    line.minutes === undefined ? "? min" : `${line.minutes.toFixed(1)} min`,
    line.tokens === undefined ? "? tokens" : `${count(line.tokens)} tokens`,
    line.cost === undefined ? "$?" : dollars(line.cost),
    `cache ${cache}`,
  ].join("  ");
};

const mergedChildLine = (
  ledger: readonly LedgerLine[],
  threadId: string
): LedgerLine | undefined => {
  const lines = ledger.filter((entry) => entry.threadId === threadId);

  return lines.length === 0 ? undefined : Object.assign({}, ...lines);
};

const usageText = (ctx: ExtensionContext): string => {
  const thread = sumUsage(assistantMessages(ctx));
  const { delegated, families } = readAccounts(ctx);
  const ledger = readLedger();

  const children = delegated.map((threadId) => ({
    line: mergedChildLine(ledger, threadId),
    threadId,
  }));

  const childCost = children.reduce(
    (sum, { line }) => sum + (line?.cost ?? 0),
    0
  );

  const out = accountLines(families);

  return [
    `This thread: ${thread.replies} replies, ${count(thread.tokens)} tokens, ${dollars(thread.cost)}, cache hit rate ${hitRate(thread.input, thread.cacheRead, thread.cacheWrite)}.`,
    ...(children.length === 0
      ? ["No children."]
      : [
          `Children (${children.length}): ${dollars(childCost)} in total.`,
          ...children.map(({ line, threadId }) => childLine(threadId, line)),
        ]),
    ...(out.length === 0
      ? ["All model families are available."]
      : ["Model families out:", ...out.map((line) => `  ${line}`)]),
  ].join("\n");
};

export const registerUsage = (pi: ExtensionAPI): void => {
  // A delegated child records what it cost, so its parent can report it.
  pi.on("message_end", async (event, ctx) => {
    const { message } = event;

    if (message.role !== "assistant" || message.stopReason !== "stop") {
      return;
    }

    const own = await ownThreadId();

    if (own === null || !isDelegated(own)) {
      return;
    }

    // message_end fires before Pi adds the final message to the branch.
    const usage = sumUsage([...assistantMessages(ctx), message]);

    appendLedger({
      at: new Date().toISOString(),
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: Number(usage.cost.toFixed(4)),
      input: usage.input,
      model: ctx.model?.id ?? null,
      threadId: own,
      tokens: usage.tokens,
    });
  });

  pi.registerCommand("t3-usage", {
    description:
      "Show what this thread and its children cost, the cache hit rate, and which model families are out: /t3-usage",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(usageText(ctx), "info");
      }
    },
  });
};
