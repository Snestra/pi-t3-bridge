import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { compile, str } from "@earendil-works/pi-schema";

// Turns the session branch into the text the stop judge reads. The rendering
// follows pi-mast-steer's src/transcript.ts (MIT, github.com/dbreunig/pi-mast-steer):
// user text, assistant text and tool calls, tool results, and other
// extensions' notes, without thinking or images.

// The custom message type of this feature's own nudges. The judge must not
// read them, and the nudge cap counts them.
export const STEER_NOTE = "pi-t3-steer";

// The custom message type of the MAST notes. They are kept apart from the
// nudges so they never count toward the cap. The judge must not read them.
export const MAST_NOTE = "pi-t3-mast";

const TASK_CHARS = 3000;
const RECENT_CHARS = 12_000;

// The MAST judge reads as much of the prompt as pi-mast-steer's does.
const MAST_TASK_CHARS = 3000;
const MAST_WINDOW_CHARS = 40_000;

const WHOLE_LOG = "The excerpt is the entire log.";

const END_OF_LOG =
  "The excerpt is the end of the log. Earlier parts of the log came before it.";

export interface StopInput {
  // The section of the user's own instructions that says how a turn ends.
  readonly userRules: string | undefined;
  readonly task: string;
  readonly recentWork: string;
  readonly finalMessage: string;
}

interface Part {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

const HANDOFF_HEADING = /^#{1,6}\s+.*what you need from me/iu;
const ANY_HEADING = /^#{1,6}\s/u;

// The section ends at the next heading of any depth. In the user's file the
// next heading is a sub-topic with its own rules, which the judge must not
// mistake for part of the handoff rule.
const sectionOf = (content: string): string | undefined => {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => HANDOFF_HEADING.test(line));

  if (start === -1) {
    return undefined;
  }

  const length = lines
    .slice(start + 1)
    .findIndex((line) => ANY_HEADING.test(line));

  const end = length === -1 ? lines.length : start + 1 + length;

  return lines.slice(start, end).join("\n").trim();
};

export const handoffRule = (
  files: readonly { readonly path: string; readonly content: string }[]
): string | undefined => {
  for (const file of files) {
    const section = sectionOf(file.content);

    if (section !== undefined) {
      return section;
    }
  }

  return undefined;
};

const isString = compile(str()).check;

const textOf = (content: string | readonly Part[]): string =>
  isString(content)
    ? content
    : content
        .flatMap((part) =>
          part.type === "text" && part.text ? [part.text] : []
        )
        .join("\n");

const renderEntry = (entry: SessionEntry): string[] => {
  if (entry.type === "custom_message") {
    // Other extensions' notes reach the model as context, so the judge sees them too.
    return entry.customType === STEER_NOTE || entry.customType === MAST_NOTE
      ? []
      : [`[note: ${entry.customType}]\n${textOf(entry.content)}\n`];
  }

  if (entry.type !== "message") {
    return [];
  }

  const { message } = entry;

  if (message.role === "user") {
    return [`[user]\n${textOf(message.content)}\n`];
  }

  if (message.role === "toolResult") {
    return [
      `[tool ${message.isError ? "error" : "result"}: ${message.toolName}]\n${textOf(message.content)}\n`,
    ];
  }

  if (message.role !== "assistant") {
    return [];
  }

  const lines = message.content.flatMap((part: Part) => {
    if (part.type === "text" && part.text?.trim()) {
      return [part.text];
    }

    return part.type === "toolCall"
      ? [`tool call: ${part.name} ${JSON.stringify(part.arguments ?? {})}`]
      : [];
  });

  return [`[assistant]\n${lines.join("\n")}\n`];
};

// The last `size` characters, starting at a line boundary when one falls
// inside them. A long partial first line is kept, so the window is not left
// nearly empty.
const lastWindow = (log: string, size: number): string => {
  if (log.length <= size) {
    return log;
  }

  const tail = log.slice(log.length - size);

  if (log[log.length - size - 1] === "\n") {
    return tail;
  }

  const newline = tail.indexOf("\n");

  return newline === -1 || newline > size / 10 ? tail : tail.slice(newline + 1);
};

const isUser = (entry: SessionEntry): boolean =>
  entry.type === "message" && entry.message.role === "user";

// The entries after the last user message. Notes are custom messages, so
// they never start a new prompt.
export const sincePrompt = (
  branch: readonly SessionEntry[]
): readonly SessionEntry[] => branch.slice(branch.findLastIndex(isUser) + 1);

const isAssistant = (entry: SessionEntry): boolean =>
  entry.type === "message" && entry.message.role === "assistant";

// The prompt is the last user message before the final assistant message.
// Steer notes are custom messages, so a nudge does not start a new prompt.
export const stopInput = (
  branch: readonly SessionEntry[],
  rule: string | undefined
): StopInput | undefined => {
  const finalAt = branch.findLastIndex(isAssistant);
  const final = branch[finalAt];

  if (final?.type !== "message" || final.message.role !== "assistant") {
    return undefined;
  }

  const before = branch.slice(0, finalAt);
  const taskAt = before.findLastIndex(isUser);
  const prompt = before[taskAt];

  if (prompt?.type !== "message" || prompt.message.role !== "user") {
    return undefined;
  }

  const finalMessage = textOf(final.message.content).trim();

  if (finalMessage === "") {
    return undefined;
  }

  return {
    finalMessage,
    recentWork: lastWindow(
      before
        .slice(taskAt + 1)
        .flatMap(renderEntry)
        .join("\n"),
      RECENT_CHARS
    ),
    task: textOf(prompt.message.content).slice(0, TASK_CHARS),
    userRules: rule,
  };
};

export interface MastExcerpt {
  readonly task: string;
  readonly window: string;
  readonly position: string;
}

// What the MAST judge reads, ported from pi-mast-steer's buildExcerpt. `scopeFrom`
// is the branch length when the prompt started. The prompt is the first user
// message at or just before it, so a message typed mid-run stays inside the
// scope instead of replacing the task. Without a scope the last user message
// starts it.
export const mastExcerpt = (
  branch: readonly SessionEntry[],
  scopeFrom: number | undefined
): MastExcerpt | undefined => {
  const inScope =
    scopeFrom === undefined
      ? -1
      : branch.findIndex((entry, at) => at >= scopeFrom - 1 && isUser(entry));

  const start = inScope === -1 ? branch.findLastIndex(isUser) : inScope;

  if (start === -1) {
    return undefined;
  }

  const log = branch.slice(start).flatMap(renderEntry).join("\n");
  const window = lastWindow(log, MAST_WINDOW_CHARS);

  return {
    position: window.length === log.length ? WHOLE_LOG : END_OF_LOG,
    task: log.slice(0, MAST_TASK_CHARS),
    window,
  };
};
