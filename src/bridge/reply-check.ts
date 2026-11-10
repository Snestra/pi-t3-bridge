import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent,
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { compile, obj, oneOf } from "@earendil-works/pi-schema";

import { sincePrompt } from "./branch.ts";
import { isDelegatedChild } from "./thread.ts";

// Two fixed checks on the reply a run is about to stop on. No model judges
// anything, so the same reply always gets the same result.
//   length    the reply hit the output limit, so the agent continues it
//   question  the reply ends by asking the user something in prose, so the
//             agent asks it again with the ask tool, which waits for an answer

const NOTE = "pi-t3-reply-check";

type Kind = "length" | "question";

// Per user prompt, so a model that keeps doing it cannot loop. A reply cut
// off at the output limit can need more than one continuation.
const LIMITS: Readonly<Record<Kind, number>> = { length: 2, question: 1 };

const TEXT: Readonly<Record<Kind, string>> = {
  length:
    "Bridge · Cut off: Your last message hit the output limit. Continue exactly where it stopped.",
  question:
    "Bridge · Question in prose: Your last message asks the user a question in plain text, which nobody answers. Call the ask tool now with that question, your recommendation first. Don't repeat the rest of the message.",
};

// How many prose lines at the end of a reply count as its closing. Questions
// for the user sit there, and questions earlier in a reply are usually the
// headings of an explanation.
const CLOSING_LINES = 5;

// A question mark that ends a sentence, after any closing quote, bracket, or
// Markdown emphasis.
const QUESTION_END = /\?["'”’*_)\]]*(?:\s|$)/u;

const noteDetails = compile(obj({ kind: oneOf(["length", "question"]) }));

const replyText = (message: AssistantMessage): string =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

const proseLines = (text: string): string[] =>
  text
    .replaceAll(/^```[\s\S]*?^```/gmu, "")
    .replaceAll(/`[^`\n]*`/gu, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

const asksInProse = (text: string): boolean =>
  proseLines(text)
    .slice(-CLOSING_LINES)
    .some((line) => QUESTION_END.test(line));

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

// Counted from the branch, so the limit holds across a reload. A note is a
// custom message, not a user message, so it does not reset the count.
const atLimit = (branch: readonly SessionEntry[], kind: Kind): boolean =>
  sincePrompt(branch).filter(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === NOTE &&
      noteDetails.check(entry.details) &&
      entry.details.kind === kind
  ).length >= LIMITS[kind];

// Pi replaces the whole entry list with what a handler returns, so the
// entries other handlers proposed are kept.
const sendBack = (
  event: AgentBeforeSettleEvent,
  kind: Kind
): BoundaryResult => ({
  continue: true,
  entries: [
    ...event.entries,
    {
      content: TEXT[kind],
      customType: NOTE,
      details: { kind },
      display: true,
      type: "custom_message",
    },
  ],
});

const check = async (
  pi: ExtensionAPI,
  last: AssistantMessage,
  ctx: ExtensionContext
): Promise<Kind | undefined> => {
  if (last.stopReason === "length") {
    return "length";
  }

  // A delegated child has nobody to ask, and a client without a UI can't
  // show the card.
  return last.stopReason === "stop" &&
    ctx.hasUI &&
    pi.getActiveTools().includes("ask") &&
    asksInProse(replyText(last)) &&
    !(await isDelegatedChild())
    ? "question"
    : undefined;
};

export const registerReplyCheck = (pi: ExtensionAPI): void => {
  pi.on("agent_before_settle", async (event, ctx) => {
    // An error outcome is left to accounts.ts, which schedules the resume. A
    // message the user already queued answers the reply instead.
    if (event.outcome !== "completed" || ctx.hasPendingMessages()) {
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const last = finalAssistant(branch);

    if (last === undefined) {
      return;
    }

    const kind = await check(pi, last, ctx);

    return kind === undefined || atLimit(branch, kind)
      ? undefined
      : sendBack(event, kind);
  });
};
