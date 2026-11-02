import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

// The child's extension reads its limits from the delegation brief
// (skills/poteto-mode/brief.md).

export type Size = "S" | "M" | "L";

export interface Brief {
  readonly acceptance: string | undefined;
  readonly diskMb: number | undefined;
  readonly files: readonly string[];
  readonly job: string | undefined;
  readonly minutes: number | undefined;
  readonly sections: ReadonlyMap<string, string>;
  readonly size: Size | undefined;
}

export interface BriefRules {
  readonly jobs: readonly string[];
  readonly noWrites: readonly string[];
  readonly sizes: Readonly<
    Record<string, { readonly files: number; readonly minutes: number }>
  >;
}

export const SECTIONS = [
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
export const APPROVAL_LINE = /^\s*allow (?:xhigh|max)\b/imu;

// A command that changes the shared account state, where one can start: at the
// start of a line, or after a space, quote or bracket. Inside a path such as
// notes/t3-exhausted.md the slash follows a name, so it is not a command.
export const ACCOUNT_COMMAND = /(?<![\w.~/-])\/t3-(?:exhausted|recovered)\b/u;

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

      const [first = ""] = item.replaceAll("`", "").trim().split(/\s+/u);

      return [first.replace(/[:,]$/u, "")];
    })
    .filter((item) => item !== "");

export const parseBrief = (text: string): Brief | undefined => {
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

const headerProblems = (brief: Brief, rules: BriefRules): string[] => {
  const problems: string[] = [];

  if (brief.job === undefined || !rules.jobs.includes(brief.job)) {
    problems.push(
      `The header needs "Job: <${rules.jobs.join(" | ")}>", the job type pstack_model routed.`
    );
  }

  if (brief.size === undefined) {
    problems.push('The header needs "Size: S" or "Size: M".');
  } else if (brief.size === "L") {
    problems.push(
      "Size L is too large to delegate: split it into S or M tasks, or do it yourself."
    );
  }

  if (brief.minutes === undefined || brief.minutes <= 0) {
    problems.push('The header needs "Time limit: <N> min".');
  }

  if (brief.diskMb === undefined || brief.diskMb <= 0) {
    problems.push('The header needs "Disk limit: <N> MB".');
  }

  return problems;
};

const sizeProblems = (brief: Brief, rules: BriefRules): string[] => {
  const problems: string[] = [];
  const limits = brief.size === undefined ? undefined : rules.sizes[brief.size];

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

const fileProblems = (brief: Brief, rules: BriefRules): string[] => {
  const problems: string[] = [];

  const readOnly =
    brief.job !== undefined &&
    rules.noWrites.includes(brief.job) &&
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
export const briefProblems = (text: string, rules: BriefRules): string[] => {
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
    ...headerProblems(brief, rules),
    ...sizeProblems(brief, rules),
    ...sectionProblems(brief),
    ...fileProblems(brief, rules),
  ];
};

// A complete brief distinguishes a child session from a user's own prompt.
const dispatchable = (brief: Brief): boolean =>
  brief.job !== undefined &&
  brief.size !== undefined &&
  brief.minutes !== undefined &&
  brief.diskMb !== undefined &&
  SECTIONS.every((section) => brief.sections.has(section));

// The brief that started this session, when it is a delegated child.
export const sessionBrief = (
  ctx: ExtensionContext
): { readonly brief: Brief; readonly startedAt: number } | undefined => {
  const first = ctx.sessionManager
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "user");

  if (first?.type !== "message" || first.message.role !== "user") {
    return undefined;
  }

  const { content } = first.message;

  const text = Value.Check(Type.String(), content)
    ? content
    : content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

  const brief = parseBrief(text);

  return brief === undefined || !dispatchable(brief)
    ? undefined
    : { brief, startedAt: Date.parse(first.timestamp) };
};
