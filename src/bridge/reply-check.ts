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
import { requestSecretTool } from "./request-secret.ts";
import { isDelegatedChild } from "./thread.ts";

// Fixed checks on the reply a run is about to stop on. No model judges
// anything, so the same reply always gets the same result.
//   length    the reply hit the output limit, so the agent continues it
//   secret    the reply asks the user for a login, token, key, or password
//             in prose, so the agent asks again with request_secret
//   handoff   the reply waits on the user in prose, so the agent does the
//             task or asks with the ask tool, which waits for the answer
//   question  the reply ends by asking the user something in prose, so the
//             agent asks it again with the ask tool

const NOTE = "pi-t3-reply-check";

const KINDS = ["length", "secret", "handoff", "question"] as const;

type Kind = (typeof KINDS)[number];

// Per user prompt, so a model that keeps doing it cannot loop. A reply cut
// off at the output limit can need more than one continuation.
const LIMITS: Readonly<Record<Kind, number>> = {
  handoff: 1,
  length: 2,
  question: 1,
  secret: 1,
};

const DONT_REPEAT = "Don't repeat the rest of the message.";

const noteText = (kind: Kind, secretTool: string): string => {
  switch (kind) {
    case "length": {
      return "Bridge · Cut off: Your last message hit the output limit. Continue exactly where it stopped.";
    }

    case "secret": {
      return `Bridge · Secret in prose: Your last message asks the user for a login, token, key, or password in plain text, or waits for them to set one up. Call ${secretTool} now for each secret you need, with the page where the user gets it as \`url\`, so the card shows a sign-in button, and with \`delivery: "file"\` when a shell command needs the value. Then use it yourself and carry on. For a step that is not a secret, call ask and wait until the user says it is done. ${DONT_REPEAT}`;
    }

    case "handoff": {
      return `Bridge · Handoff in prose: Your last message waits on the user in plain text, and nobody reads it until long after the run stops. If you can do the task yourself, do it now. If the work is done and you need nothing from the user, stop without a message. Otherwise call the ask tool now with one card per thing you need, your recommendation first. For a step only the user can take, the card says exactly what to do and waits until they say it is done. Never ask for a password, token, or key in an ask card. ${DONT_REPEAT}`;
    }

    default: {
      return `Bridge · Question in prose: Your last message asks the user a question in plain text, which nobody answers. If the user must choose, approve, or resolve something before the work can go on, call the ask tool now with that question, your recommendation first. If the question is an offer, or its only sensible answer is yes, drop it and stop without a message. ${DONT_REPEAT}`;
    }
  }
};

// How many prose lines at the end of a reply count as its closing. Questions
// and requests for the user sit there, and questions earlier in a reply are
// usually the headings of an explanation.
const CLOSING_LINES = 5;

// A question mark that ends a sentence, after any closing quote, bracket, or
// Markdown emphasis.
const QUESTION_END = /\?["'”’*_)\]]*(?:\s|$)/u;

// The heading of a section that lists what the agent needs from the user.
// Each line under it is checked for a secret, and for a wait like any
// closing line. A plain step such as "start a new session" is a note, not a
// block, so it doesn't count on its own.
const NEEDS_HEADING = /\bwhat i need from you\b/iu;

const NEEDS_LEAD = /^.*?\bwhat i need from you\b\W*/iu;

// A sentence that says the user needs to do nothing, or that the agent does
// the step itself, asks for nothing.
const NOTHING_NEEDED =
  /\b(?:nothing|no need|no action|don't need|do not need|needn't|won't need|not needed|no longer need)\b/iu;

// Sentences that wait on the user, so the work can't go on until they act.
// "Let me know if you want..." is an offer, not a wait, so a following "if"
// excuses it. Instructions such as "you'll need to" or "please restart"
// tell the user how to use the result and don't block the run.
const HANDOFF = [
  /\blet me know\b(?! if\b)/iu,
  /\b(?:tell|ping|message) me\b(?! if\b)/iu,
  /\b(?:once|after) you(?:'ve| have|'re| are)?\b/iu,
  /\bonce (?:that|this|it|they)(?:'s|'re| is| are) (?:done|in place|set|ready)\b/iu,
  /\bwhen you(?:'re| are|'ve| have)? (?:done|ready|finished|back)\b/iu,
  /\bwhen you get a (?:chance|moment)\b/iu,
  /\b(?:reply|respond) with\b/iu,
  /\b(?:i'll|i will|i'm|i am) (?:wait|waiting|standing by)\b/iu,
  /\bwaiting (?:for|on) you\b/iu,
  /\bblocked (?:on|until) you\b/iu,
] as const;

// Names of secrets, and environment variables that hold one, such as
// STRIPE_SECRET_KEY. PIN is matched in capitals so "pin a version" is not one.
const SECRET_NOUN =
  /\b(?:passwords?|passcodes?|passphrases?|pairing codes?|(?:6|six)-digit codes?|verification codes?|one-time codes?|2fa codes?|otp|api[ _-]?keys?|secret keys?|access keys?|private keys?|(?:access|auth|bearer|api|refresh|session) tokens?|personal access tokens?|pats?|tokens?|credentials|creds|login details)\b/iu;

const SECRET_NAME =
  /\b(?:[A-Z][A-Z0-9]*_)*(?:TOKEN|KEY|SECRET|PASSWORD|PASSPHRASE|PAT)(?:_[A-Z0-9]+)*\b|\bPINs?\b/u;

// A sign-in only the user can do, such as `gh auth login`.
const SIGN_IN =
  /\b(?:log ?in|sign ?in|auth login|authenticate|re-?authenticate|re-?auth)\b/iu;

// Words that put a secret in the user's hands.
const GIVE_VERB =
  /\b(?:send|paste|share|give|provide|supply|enter|type|reply with|set|export|add|put|drop|need|create|generate|grab|copy)\b/iu;

const LIST_MARKER = String.raw`^(?:\d+[.)]\s+|[-*•]\s+)?`;

// A sentence about what the agent did or will do asks the user for nothing.
const BY_AGENT = new RegExp(`${LIST_MARKER}(?:i|we)\\b`, "iu");

// A sentence addressed to the user: it names them, or it opens with a verb.
const TO_USER = new RegExp(
  String.raw`\b(?:you|your|please)\b|${LIST_MARKER}(?:send|paste|share|give|provide|supply|enter|type|reply|set|export|add|put|drop|run|log|sign|create|generate|grab|copy|open|go|visit|authenticate)\b`,
  "iu"
);

// A sign-in the user is told to do, not one the reply describes.
const SIGN_IN_TO_USER = new RegExp(
  String.raw`${LIST_MARKER}(?:please\s+)?(?:run|log|sign|authenticate|re-?auth\w*)\b|\bplease\b|\byou(?:'ll| will)? (?:need|have) to\b|\b(?:once|after) you\b`,
  "iu"
);

const WHAT_IS = /\b(?:what(?:'s| is| are)|which)\b/iu;

const noteDetails = compile(obj({ kind: oneOf([...KINDS]) }));

const replyText = (message: AssistantMessage): string =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

// Table rows and text in double quotes are examples the reply shows, not
// something it asks, so neither counts.
const TABLE_ROW = /^\|/u;

const QUOTED = /"[^"\n]*"|“[^”\n]*”/gu;

const splitLines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !TABLE_ROW.test(line));

const proseLines = (text: string): string[] =>
  splitLines(
    text
      .replaceAll(/^```[\s\S]*?^```/gmu, "")
      .replaceAll(/`[^`\n]*`/gu, "")
      .replaceAll(QUOTED, "")
  );

const asksInProse = (reply: string): boolean =>
  proseLines(reply)
    .slice(-CLOSING_LINES)
    .some((line) => QUESTION_END.test(line));

// Prose for the word checks. Inline code keeps its words, because a request
// such as "set `STRIPE_SECRET_KEY`" names its secret in code.
const wordLines = (reply: string): string[] =>
  splitLines(
    reply
      .replaceAll(/^```[\s\S]*?^```/gmu, "")
      .replaceAll("`", "")
      .replaceAll(/[‘’]/gu, "'")
      .replaceAll(/\*\*|__/gu, "")
      .replaceAll(QUOTED, "")
  );

const sentences = (lines: readonly string[]): string[] =>
  lines.flatMap((line) => line.split(/(?<=[.!?])\s+/u));

// The closing sentences, and the lines under a "What I need from you"
// heading, which are requests even when they read as plain steps.
interface Closing {
  readonly needs: string[];
  readonly tail: string[];
}

const closing = (reply: string): Closing => {
  const lines = wordLines(reply);
  const heading = lines.findLastIndex((line) => NEEDS_HEADING.test(line));

  // The heading can share its line with the first request.
  const section =
    heading === -1
      ? []
      : [
          (lines[heading] ?? "").replace(NEEDS_LEAD, ""),
          ...lines.slice(heading + 1),
        ];

  return {
    needs: sentences(section).filter(
      (sentence) => sentence !== "" && !NOTHING_NEEDED.test(sentence)
    ),
    tail: sentences(lines.slice(-CLOSING_LINES)).filter(
      (sentence) => !NOTHING_NEEDED.test(sentence)
    ),
  };
};

const namesSecret = (sentence: string): boolean =>
  SECRET_NOUN.test(sentence) || SECRET_NAME.test(sentence);

// `listed` marks a line under a "What I need from you" heading, which is
// addressed to the user however it reads.
const asksForSecret = (sentence: string, listed: boolean): boolean =>
  !BY_AGENT.test(sentence) &&
  ((namesSecret(sentence) &&
    ((GIVE_VERB.test(sentence) && (listed || TO_USER.test(sentence))) ||
      (WHAT_IS.test(sentence) && sentence.endsWith("?")))) ||
    (SIGN_IN.test(sentence) && (listed || SIGN_IN_TO_USER.test(sentence))));

const handsOff = (sentence: string): boolean =>
  HANDOFF.some((pattern) => pattern.test(sentence));

// Which request the reply's closing makes of the user, if any. A secret wins
// over a plain handoff, because it needs its own tool.
const requestIn = (reply: string): "secret" | "handoff" | undefined => {
  const { needs, tail } = closing(reply);

  if (
    needs.some((sentence) => asksForSecret(sentence, true)) ||
    tail.some((sentence) => asksForSecret(sentence, false))
  ) {
    return "secret";
  }

  return needs.some(handsOff) || tail.some(handsOff) ? "handoff" : undefined;
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
  kind: Kind,
  secretTool: string
): BoundaryResult => ({
  continue: true,
  entries: [
    ...event.entries,
    {
      content: noteText(kind, secretTool),
      customType: NOTE,
      details: { kind },
      display: true,
      type: "custom_message",
    },
  ],
});

// The kinds a reply's prose matches, first match first. A kind whose tool
// is not declared to the model falls through to the next.
const proseKinds = (
  reply: string,
  tools: { readonly ask: boolean; readonly secret: boolean }
): Kind[] => {
  const request = requestIn(reply);

  return [
    ...(request === "secret" && tools.secret ? ["secret" as const] : []),
    ...(request !== undefined && tools.ask ? ["handoff" as const] : []),
    ...(tools.ask && asksInProse(reply) ? ["question" as const] : []),
  ];
};

const check = async (
  pi: ExtensionAPI,
  last: AssistantMessage,
  ctx: ExtensionContext
): Promise<Kind[]> => {
  if (last.stopReason === "length") {
    return ["length"];
  }

  // A delegated child has nobody to ask, and a client without a UI can't
  // show the card.
  if (last.stopReason !== "stop" || !ctx.hasUI) {
    return [];
  }

  const active = pi.getActiveTools();
  const secretTool = requestSecretTool(pi);

  const kinds = proseKinds(replyText(last), {
    ask: active.includes("ask"),
    secret: secretTool !== undefined && active.includes(secretTool),
  });

  return kinds.length === 0 || (await isDelegatedChild()) ? [] : kinds;
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

    const kinds = await check(pi, last, ctx);
    const kind = kinds.find((candidate) => !atLimit(branch, candidate));

    return kind === undefined
      ? undefined
      : sendBack(event, kind, requestSecretTool(pi) ?? "request_secret");
  });
};
