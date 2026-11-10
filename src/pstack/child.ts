import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  bool,
  compile,
  nul,
  num,
  obj,
  opt,
  str,
  union,
  unknown,
} from "@earendil-works/pi-schema";

import { bashTimeoutSeconds } from "../bridge/bash-timeout.ts";
import { appendLedger } from "../bridge/state.ts";
import { isDelegatedChild, ownThreadId } from "../bridge/thread.ts";
import { incompleteBrief, sessionBrief } from "./brief.ts";
import type { Brief, BriefRules } from "./brief.ts";
import { readPolicy } from "./resources.ts";
import {
  chooseSandbox,
  real,
  sandboxLabel,
  unavailableReason,
  wrap,
} from "./sandbox.ts";
import type { Sandbox } from "./sandbox.ts";

// Rules a delegated child cannot talk its way around. A session whose first
// message is a pstack brief gets them: writes only inside its workdir (a
// sandbox around every shell command, or no shell at all) and only to its
// listed files (write and edit), its time and disk limits, and a report line
// the code writes from commands it runs itself, not from what the model says.

const run = promisify(execFile);

const DU_TIMEOUT_MS = 15_000;

const SCRATCH = ".scratch/";

const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

// Where a write to target lands once every symlink on its path is followed.
// Undefined for a dangling link, whose landing spot cannot be known.
const landing = (target: string): string | undefined => {
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    try {
      return realpathSync(target);
    } catch {
      return undefined;
    }
  }

  const parent = path.dirname(target);

  if (parent === target) {
    return target;
  }

  const base = landing(parent);

  return base === undefined
    ? undefined
    : path.join(base, path.basename(target));
};

const globToRegExp = (glob: string): RegExp => {
  const source = glob
    .replace(/^\.\//u, "")
    .replace(/\/\*\*$/u, "\u0002")
    .replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**/", "\u0000")
    .replaceAll("**", "\u0001")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll("\u0000", "(?:.*/)?")
    .replaceAll("\u0001", ".*")
    .replaceAll("\u0002", "(?:/.*)?");

  return new RegExp(`^${source}/?$`, "u");
};

const allowedFile = (brief: Brief, relative: string): boolean =>
  relative.startsWith(SCRATCH) ||
  brief.files.some((file) => globToRegExp(file).test(relative));

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

const duKb = async (target: string): Promise<number | undefined> => {
  try {
    // node_modules is left out: pnpm fills it from the store, so its size is
    // bounded by the lockfile and says nothing about runaway usage.
    const { stdout } = await run(
      "/bin/bash",
      [
        "-c",
        `du -sk ${quote(target)} && find ${quote(target)} -name node_modules -prune -type d -exec du -sk {} +`,
      ],
      { timeout: DU_TIMEOUT_MS }
    );

    const lines = stdout.trim().split("\n");
    const total = Number(lines[0]?.split(/\s/u)[0]);

    if (!Number.isFinite(total)) {
      return undefined;
    }

    const modules = lines
      .slice(1)
      .reduce((sum, line) => sum + Number(line.split(/\s/u)[0]), 0);

    return total >= modules ? total - modules : total;
  } catch {
    return undefined;
  }
};

const remainingSeconds = (startedAt: number, brief: Brief): number =>
  brief.minutes === undefined
    ? Number.POSITIVE_INFINITY
    : startedAt / 1000 + brief.minutes * 60 - Date.now() / 1000;

const isExecFailure = compile(
  obj(
    {
      code: opt(union([num(), str(), nul()])),
      killed: opt(bool()),
      stderr: opt(str()),
      stdout: opt(str()),
    },
    { open: true }
  )
).check;

const isBashInput = compile(
  obj({ command: str(), timeout: opt(unknown()) }, { open: true })
).check;

const isPathInput = compile(obj({ path: str() }, { open: true })).check;

const isNumber = compile(num()).check;

const readBriefRules = (): BriefRules => {
  const { briefs, jobs } = readPolicy();

  return {
    jobs: Object.keys(jobs),
    noWrites: briefs.noWrites,
    sizes: briefs.sizes,
  };
};

// Paths relative to the workdir, as the brief lists them. git prints paths
// from the repository root, and -z keeps names with spaces unquoted. A rename
// prints its new path, then its old path as a separate record.
const changedFiles = async (cwd: string): Promise<string[]> => {
  try {
    const [{ stdout: prefix }, { stdout }] = await Promise.all([
      run("git", ["rev-parse", "--show-prefix"], { cwd }),
      run(
        "git",
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
        { cwd }
      ),
    ]);

    const root = prefix.trim();
    const records = stdout.split("\0");
    const files: string[] = [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] ?? "";

      if (record.length < 4) {
        continue;
      }

      files.push(record.slice(3).slice(root.length));

      if (record.startsWith("R") || record.startsWith("C")) {
        index += 1;
      }
    }

    return files;
  } catch {
    return [];
  }
};

const reportStatus = (
  blocked: boolean,
  accepted: { exit: number },
  outside: readonly string[]
): "BLOCKED" | "ISSUES" | "PASS" => {
  if (blocked) {
    return "BLOCKED";
  }

  return accepted.exit === 0 && outside.length === 0 ? "PASS" : "ISSUES";
};

const diskGrowthMb = (
  nowKb: number | undefined,
  baselineKb: number | undefined
): number | undefined =>
  nowKb === undefined || baselineKb === undefined
    ? undefined
    : Math.max(0, (nowKb - baselineKb) / 1024);

const overLimit = (
  grownMb: number | undefined,
  limitMb: number | undefined
): boolean =>
  grownMb !== undefined && limitMb !== undefined && grownMb > limitMb;

interface Report {
  readonly accepted: { exit: number; tail: string };
  readonly before: number | undefined;
  readonly brief: Brief;
  readonly changed: number;
  readonly diskMb: number | undefined;
  readonly minutes: number;
  readonly outside: readonly string[];
  readonly sandbox: Sandbox | undefined;
  readonly status: string;
}

const reportBlock = (report: Report): string => {
  const { accepted, brief, diskMb, minutes, outside, sandbox } = report;
  const tail = accepted.tail.trim().split("\n").slice(-10).join("\n");

  const before =
    report.before === undefined ? "" : ` (before: exit ${report.before})`;

  return [
    "",
    "---",
    "## Checked by pi-t3-bridge (run by code, not written by the model)",
    `STATUS: ${report.status}`,
    `ACCEPTANCE: \`${brief.acceptance ?? ""}\` -> exit ${accepted.exit}${before}`,
    ...(tail === "" ? [] : ["```text", tail, "```"]),
    `FILES: ${report.changed} changed; outside the list: ${outside.length === 0 ? "none" : outside.join(", ")}`,
    `DISK: ${diskMb === undefined ? "unknown" : `+${diskMb.toFixed(1)} MB`} in the workdir (limit ${brief.diskMb ?? "?"} MB)`,
    `TIME: ${minutes.toFixed(1)} of ${brief.minutes ?? "?"} min`,
    `SANDBOX: ${sandboxLabel(sandbox)}`,
  ].join("\n");
};

interface ChildState {
  baselineKb: number | undefined;
  before: number | undefined;
  diskCheck: Promise<void>;
  diskOver: boolean;
  diskQueued: boolean;
  gitDir: string | undefined;
  greenAtStart: boolean;
  ready: boolean;
  sandbox: Sandbox | undefined;
}

export const registerChild = (pi: ExtensionAPI): void => {
  const state: ChildState = {
    baselineKb: undefined,
    before: undefined,
    diskCheck: Promise.resolve(),
    diskOver: false,
    diskQueued: false,
    gitDir: undefined,
    greenAtStart: false,
    ready: false,
    sandbox: undefined,
  };

  const runAcceptance = async (
    command: string,
    workdir: string,
    seconds: number
  ): Promise<{ exit: number; tail: string }> => {
    const wrapped = wrap(state.sandbox, command, workdir, state.gitDir);

    if (wrapped === undefined) {
      return {
        exit: 126,
        tail: `not run: no sandbox (${unavailableReason(state.sandbox)})`,
      };
    }

    try {
      const { stdout, stderr } = await run("/bin/bash", ["-c", wrapped], {
        cwd: workdir,
        maxBuffer: 16 * 1024 * 1024,
        timeout: seconds * 1000,
      });

      return { exit: 0, tail: `${stdout}${stderr}` };
    } catch (error) {
      const failed = isExecFailure(error) ? error : {};

      const exit = isNumber(failed.code) ? failed.code : 124;

      return {
        exit,
        tail: `${failed.stdout ?? ""}${failed.stderr ?? ""}${failed.killed ? "\n(timed out)" : ""}`,
      };
    }
  };

  const prepare = async (ctx: ExtensionContext, brief: Brief) => {
    if (state.ready) {
      return;
    }

    state.ready = true;

    try {
      const { stdout } = await run("git", ["rev-parse", "--git-common-dir"], {
        cwd: ctx.cwd,
      });

      state.gitDir = path.resolve(ctx.cwd, stdout.trim());
    } catch {
      state.gitDir = undefined;
    }

    state.sandbox = await chooseSandbox(ctx.cwd, state.gitDir);

    state.baselineKb = await duKb(ctx.cwd);

    const { redBeforeGreen } = readPolicy().briefs;

    if (
      brief.acceptance !== undefined &&
      brief.job !== undefined &&
      redBeforeGreen.includes(brief.job)
    ) {
      const { exit } = await runAcceptance(
        brief.acceptance,
        ctx.cwd,
        bashTimeoutSeconds()
      );

      state.before = exit;
      state.greenAtStart = exit === 0;
    }
  };

  pi.on("before_agent_start", async (_event, ctx) => {
    const started = sessionBrief(ctx);

    if (started !== undefined) {
      await prepare(ctx, started.brief);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const started = sessionBrief(ctx);

    if (started === undefined) {
      // A delegated child whose brief is incomplete would otherwise run with
      // no sandbox and no limits, as if it were the user's own session.
      const problems = incompleteBrief(ctx, readBriefRules());

      if (problems === undefined) {
        return;
      }

      return (await isDelegatedChild())
        ? {
            block: true,
            reason: `This delegated task's brief is incomplete, so it can't run in the sandbox and every tool is blocked. Use no more tools. Report STATUS: BLOCKED (incomplete brief) with these problems, so the parent can resend a complete brief:\n- ${problems.join("\n- ")}`,
          }
        : undefined;
    }

    const { brief, startedAt } = started;

    await prepare(ctx, brief);
    await state.diskCheck;

    if (state.greenAtStart) {
      return {
        block: true,
        reason:
          "The acceptance command already passes before any change (exit 0), so it checks nothing. Make no changes. Report STATUS: BLOCKED and say the acceptance command already passes.",
      };
    }

    const remaining = remainingSeconds(startedAt, brief);

    if (remaining <= 0) {
      return {
        block: true,
        reason: `The time limit of ${brief.minutes} min is reached. Use no more tools. Report now with STATUS: BLOCKED (time limit) and what is left.`,
      };
    }

    if (state.diskOver) {
      return {
        block: true,
        reason: `The disk limit of ${brief.diskMb} MB is reached in the workdir. Use no more tools. Report STATUS: BLOCKED (disk limit) and what used the space.`,
      };
    }

    const { input } = event;

    if (event.toolName === "bash" && isBashInput(input)) {
      const wrapped = wrap(state.sandbox, input.command, ctx.cwd, state.gitDir);

      if (wrapped === undefined) {
        return {
          block: true,
          reason: `No sandbox can run for this shell (${unavailableReason(state.sandbox)}), so shell commands are blocked. The user can install \`bubblewrap\`, set kernel.apparmor_restrict_unprivileged_userns=0, or set "childSandbox": "off" in ~/.config/pi-t3/config.json. Use no more shell commands. Report STATUS: BLOCKED (no sandbox).`,
        };
      }

      const limit = Math.max(1, Math.ceil(remaining));

      input.timeout = isNumber(input.timeout)
        ? Math.min(input.timeout, limit)
        : limit;
      input.command = wrapped;

      return;
    }

    if (WRITE_TOOLS.has(event.toolName) && isPathInput(input)) {
      const absolute = landing(
        path.resolve(ctx.cwd, input.path.replace(/^~(?=\/)/u, homedir()))
      );

      const relative =
        absolute === undefined
          ? undefined
          : path.relative(real(ctx.cwd), absolute);

      if (
        relative === undefined ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !allowedFile(brief, relative)
      ) {
        return {
          block: true,
          reason: `${input.path} is not in "Files you may write" (${brief.files.join(", ")}). Stop and report BLOCKED if the task needs it.`,
        };
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const started = sessionBrief(ctx);

    if (
      started === undefined ||
      event.toolName !== "bash" ||
      state.diskQueued
    ) {
      return;
    }

    const { diskMb } = started.brief;
    const { cwd } = ctx;

    // Measured while the model thinks. The next tool call waits for it. One
    // du runs at a time, and a burst of results queues at most one more,
    // which starts after them all. ctx throws once the session is gone, so
    // cwd is read before the handler returns.
    const previous = state.diskCheck;

    state.diskQueued = true;
    state.diskCheck = (async () => {
      await previous;

      state.diskQueued = false;

      const now = await duKb(cwd);

      if (
        now !== undefined &&
        state.baselineKb !== undefined &&
        diskMb !== undefined &&
        (now - state.baselineKb) / 1024 > diskMb
      ) {
        state.diskOver = true;
      }
    })();
  });

  pi.on("message_end", async (event, ctx) => {
    const { message } = event;
    const started = sessionBrief(ctx);

    if (
      started === undefined ||
      message.role !== "assistant" ||
      message.stopReason !== "stop"
    ) {
      return;
    }

    const { brief, startedAt } = started;

    await prepare(ctx, brief);
    await state.diskCheck;

    const accepted =
      brief.acceptance === undefined
        ? { exit: 2, tail: "no acceptance command" }
        : await runAcceptance(brief.acceptance, ctx.cwd, bashTimeoutSeconds());

    const changed = await changedFiles(ctx.cwd);

    const outside = changed.filter((file) => !allowedFile(brief, file));
    const diskMb = diskGrowthMb(await duKb(ctx.cwd), state.baselineKb);

    const minutes = (Date.now() - startedAt) / 60_000;
    const overTime = brief.minutes !== undefined && minutes > brief.minutes;

    const diskOver = state.diskOver || overLimit(diskMb, brief.diskMb);

    const status = reportStatus(
      state.greenAtStart ||
        overTime ||
        diskOver ||
        unavailableReason(state.sandbox) !== undefined,
      accepted,
      outside
    );

    const block = reportBlock({
      accepted,
      before: state.before,
      brief,
      changed: changed.length,
      diskMb,
      minutes,
      outside,
      sandbox: state.sandbox,
      status,
    });

    // The bridge writes this child's cost in a line of its own.
    appendLedger({
      at: new Date().toISOString(),
      before: state.before ?? null,
      diskMb: diskMb === undefined ? null : Number(diskMb.toFixed(1)),
      exit: accepted.exit,
      job: brief.job ?? null,
      minutes: Number(minutes.toFixed(1)),
      outside: outside.length,
      report: block,
      size: brief.size ?? null,
      status,
      threadId: await ownThreadId(),
      workdir: ctx.cwd,
    });

    return {
      message: {
        ...message,
        content: [...message.content, { text: block, type: "text" }],
      },
    };
  });
};
