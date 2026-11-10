import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compile, str } from "@earendil-works/pi-schema";

import { ACCOUNT_COMMAND } from "../bridge/accounts.ts";
import type { Policy } from "./resources.ts";

// The child's extension reads its limits from the delegation brief
// (skills/poteto-mode/brief.md).

export type Size = "S" | "M" | "L";

const isString = compile(str()).check;

export interface Brief {
  readonly acceptance: string | undefined;
  readonly diskMb: number | undefined;
  readonly files: readonly string[];
  readonly job: string | undefined;
  readonly minutes: number | undefined;
  readonly sections: ReadonlyMap<string, string>;
  readonly size: Size | undefined;
}

const SECTIONS = [
  "Goal",
  "Acceptance command",
  "Files you may write",
  "Non-goals",
  "Context",
  "Stop conditions",
  "Report",
] as const;

const TASK_HEADING = /^# Task:/mu;

// The user's approval of reasoning above high, as a whole message or line.
const APPROVAL_LINE = /^\s*allow (?:xhigh|max)\b/imu;

export const SIZE_L_REFUSED =
  "Size L is too large to delegate: split it into S or M tasks, or do it yourself.";

const BROAD_PATHS = new Set(["*", "**", "**/*", "/", ".", "./", "~"]);

const number = (pattern: RegExp, text: string): number | undefined => {
  const match = pattern.exec(text)?.groups?.value;

  return match === undefined ? undefined : Number(match);
};

const listItems = (section: string | undefined): string[] =>
  (section ?? "")
    .split("\n")
    .flatMap((line) => {
      const item = /^\s*[-*]\s+(?<item>.+)$/u.exec(line)?.groups?.item;

      if (item === undefined) {
        return [];
      }

      // A bullet may list several paths. Every token with a slash or a glob
      // counts, so "a/** and b/c.ts" writes both. A bullet with no such
      // token is a plain file name followed by prose, so only its first
      // word counts.
      const tokens = item
        .replaceAll("`", "")
        .trim()
        .split(/[\s,]+/u)
        .map((token) =>
          token
            .replace(/^[([{\u201C']+/u, "")
            .replace(/[.,;)\]}\u201D']+$/u, "")
        )
        .filter((token) => token !== "");

      const paths = tokens.filter(
        (token) => token.includes("/") || token.includes("*")
      );

      return paths.length > 0 ? paths : [tokens[0] ?? ""];
    })
    .filter((item) => item !== "");

const parseBrief = (text: string): Brief | undefined => {
  const start = TASK_HEADING.exec(text);

  if (start === null) {
    return undefined;
  }

  const body = text.slice(start.index);
  const header = body.split(/^## /mu)[0] ?? "";
  const sections = new Map<string, string>();

  for (const part of body.split(/^## /mu).slice(1)) {
    const [title = "", ...rest] = part.split("\n");

    sections.set(title.trim(), rest.join("\n"));
  }

  const fence = /```[^\n]*\n(?<code>[\s\S]*?)```/u.exec(
    sections.get("Acceptance command") ?? ""
  );

  const size = /\bSize:\s*(?<size>[SML])\b/u.exec(header)?.groups?.size;

  return {
    acceptance: fence?.groups?.code?.trim() || undefined,
    diskMb: number(/Disk limit:\s*(?<value>[\d.]+)\s*MB/iu, header),
    files: listItems(sections.get("Files you may write")),
    job: /\bJob:\s*(?<job>[a-z]+)/iu.exec(header)?.groups?.job?.toLowerCase(),
    minutes: number(/Time limit:\s*(?<value>[\d.]+)\s*min/iu, header),
    sections,
    size: size === "S" || size === "M" || size === "L" ? size : undefined,
  };
};

const textProblems = (text: string): string[] => {
  const problems: string[] = [];

  if (APPROVAL_LINE.test(text)) {
    problems.push(
      'A brief cannot carry the user\'s approval line ("allow xhigh"). Only the user grants it, in this chat.'
    );
  }

  if (ACCOUNT_COMMAND.test(text)) {
    problems.push(
      "A brief cannot contain /t3-exhausted or /t3-recovered. Account state is shared, so the child already sees it."
    );
  }

  return problems;
};

const headerProblems = (brief: Brief, policy: Policy): string[] => {
  const jobs = Object.keys(policy.jobs);
  const problems: string[] = [];

  if (brief.job === undefined || !jobs.includes(brief.job)) {
    problems.push(
      `The header needs "Job: <${jobs.join(" | ")}>", the job type pstack_model routed.`
    );
  }

  if (brief.size === undefined) {
    problems.push('The header needs "Size: S" or "Size: M".');
  } else if (brief.size === "L") {
    problems.push(SIZE_L_REFUSED);
  }

  if (brief.minutes === undefined || brief.minutes <= 0) {
    problems.push('The header needs "Time limit: <N> min".');
  }

  if (brief.diskMb === undefined || brief.diskMb <= 0) {
    problems.push('The header needs "Disk limit: <N> MB".');
  }

  return problems;
};

const sizeProblems = (brief: Brief, policy: Policy): string[] => {
  const problems: string[] = [];

  const limits =
    brief.size === undefined ? undefined : policy.briefs.sizes[brief.size];

  if (
    limits !== undefined &&
    brief.minutes !== undefined &&
    brief.minutes > limits.minutes
  ) {
    problems.push(
      `Size ${brief.size} allows at most ${limits.minutes} min. Raise the size or split the task.`
    );
  }

  if (limits !== undefined && brief.files.length > limits.files) {
    problems.push(
      `Size ${brief.size} allows at most ${limits.files} files in "Files you may write".`
    );
  }

  return problems;
};

const sectionProblems = (brief: Brief): string[] => {
  const problems: string[] = [];

  for (const section of SECTIONS) {
    if (!brief.sections.has(section)) {
      problems.push(`Missing section "## ${section}".`);
    }
  }

  if (
    brief.sections.has("Acceptance command") &&
    brief.acceptance === undefined
  ) {
    problems.push(
      "The acceptance command must be a fenced code block under ## Acceptance command."
    );
  }

  return problems;
};

const fileProblems = (brief: Brief, policy: Policy): string[] => {
  const problems: string[] = [];

  const readOnly =
    brief.job !== undefined &&
    policy.briefs.noWrites.includes(brief.job) &&
    brief.files.length === 1 &&
    brief.files[0]?.toLowerCase() === "none";

  if (brief.sections.has("Files you may write") && brief.files.length === 0) {
    problems.push(
      '"Files you may write" needs at least one path (or "- none" for a review or check job).'
    );
  }

  if (!readOnly) {
    for (const file of brief.files) {
      if (BROAD_PATHS.has(file) || file.toLowerCase() === "none") {
        problems.push(
          `"${file}" in "Files you may write" is not a narrow path. List the files or a narrow glob.`
        );
      }
    }
  }

  return problems;
};

// Everything wrong with a brief, as one line each, so the parent can fix all
// of it in one go.
const briefProblems = (text: string, policy: Policy): string[] => {
  const problems = textProblems(text);
  const brief = parseBrief(text);

  if (brief === undefined) {
    problems.push(
      "The brief does not follow skills/poteto-mode/brief.md: it has no `# Task:` heading. Write it from that template."
    );

    return problems;
  }

  return [
    ...problems,
    ...headerProblems(brief, policy),
    ...sizeProblems(brief, policy),
    ...sectionProblems(brief),
    ...fileProblems(brief, policy),
  ];
};

// A complete brief distinguishes a child session from a user's own prompt.
const dispatchable = (brief: Brief): boolean =>
  brief.job !== undefined &&
  brief.size !== undefined &&
  brief.minutes !== undefined &&
  brief.diskMb !== undefined &&
  SECTIONS.every((section) => brief.sections.has(section));

const firstMessage = (
  ctx: ExtensionContext
): { readonly at: number; readonly text: string } | undefined => {
  const first = ctx.sessionManager
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "user");

  if (first?.type !== "message" || first.message.role !== "user") {
    return undefined;
  }

  const { content } = first.message;

  return {
    at: Date.parse(first.timestamp),
    text: isString(content)
      ? content
      : content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n"),
  };
};

export const sessionBrief = (
  ctx: ExtensionContext
): { readonly brief: Brief; readonly startedAt: number } | undefined => {
  const first = firstMessage(ctx);
  const brief = first === undefined ? undefined : parseBrief(first.text);

  return first === undefined || brief === undefined || !dispatchable(brief)
    ? undefined
    : { brief, startedAt: first.at };
};

// What is wrong with a brief that has a `# Task:` heading but is not complete
// enough to hold a child to. Undefined when there is no such brief.
export const incompleteBrief = (
  ctx: ExtensionContext,
  policy: Policy
): string[] | undefined => {
  const first = firstMessage(ctx);
  const brief = first === undefined ? undefined : parseBrief(first.text);

  return first === undefined || brief === undefined || dispatchable(brief)
    ? undefined
    : briefProblems(first.text, policy);
};
