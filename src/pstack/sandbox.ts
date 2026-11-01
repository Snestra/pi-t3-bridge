import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

import { readConfig } from "../bridge/config.ts";

// Which sandbox a delegated child's shell commands run in, and how a command
// is wrapped for it. The policy (which paths a command may write, which stay
// read-only inside them) is the same on every OS. Each backend turns it into
// a wrapped command string.

const run = promisify(execFile);

const SANDBOX = "/usr/bin/sandbox-exec";

const BWRAP = "bwrap";

const PROBE_TIMEOUT_MS = 10_000;

const ProbeFailureSchema = Type.Object({
  code: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  message: Type.Optional(Type.String()),
  stderr: Type.Optional(Type.String()),
});

export type Sandbox =
  | { kind: "bubblewrap" }
  | { kind: "off" }
  | { kind: "sandbox-exec" }
  | { kind: "unavailable"; reason: string };

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

export const real = (target: string): string => {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
};

// Tool caches and installs stay writable, so uv, npm and mise work.
const cacheRoots = (): string[] => {
  const home = homedir();

  return [
    path.join(home, ".cache"),
    path.join(home, ".npm"),
    path.join(home, ".local", "share", "uv"),
    path.join(home, ".local", "share", "mise"),
  ];
};

const writableRoots = (workdir: string, gitDir: string | undefined) =>
  [
    workdir,
    gitDir,
    ...cacheRoots(),
    path.join(homedir(), "Library", "Caches"),
    "/private/var/folders",
    tmpdir(),
    "/dev",
  ]
    .filter((root): root is string => root !== undefined)
    .flatMap((root) => [root, real(root)]);

// Hooks and config in the git dir run later, outside the sandbox, when the
// parent commits or merges the child's work, so they stay read-only.
const gitDenies = (gitDir: string | undefined): string[] =>
  gitDir === undefined
    ? []
    : [gitDir, real(gitDir)].flatMap((dir) => [
        `(subpath ${JSON.stringify(path.join(dir, "hooks"))})`,
        `(literal ${JSON.stringify(path.join(dir, "config"))})`,
        `(literal ${JSON.stringify(path.join(dir, "config.lock"))})`,
      ]);

const sandboxProfile = (
  roots: readonly string[],
  denies: readonly string[]
): string =>
  [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${[...new Set(roots)].map((root) => `(subpath ${JSON.stringify(root)})`).join(" ")})`,
    ...(denies.length === 0
      ? []
      : [`(deny file-write* ${[...new Set(denies)].join(" ")})`]),
  ].join("");

// bwrap creates a missing bind target on the host, so only paths that exist
// are bound, each once, where it really is.
const existing = (paths: readonly string[]): string[] => [
  ...new Set(
    paths.flatMap((target) => (existsSync(target) ? [real(target)] : []))
  ),
];

// A read-only config also stops `git config`: its rename of config.lock over
// config fails on the mount, so config.lock needs no bind of its own.
const bwrapArgs = (
  command: string,
  workdir: string,
  gitDir: string | undefined
): string[] => [
  BWRAP,
  "--ro-bind",
  "/",
  "/",
  "--dev-bind",
  "/dev",
  "/dev",
  "--proc",
  "/proc",
  ...existing(writableRoots(workdir, gitDir)).flatMap((root) =>
    root === "/dev" ? [] : ["--bind", root, root]
  ),
  ...existing(
    gitDir === undefined
      ? []
      : [path.join(gitDir, "hooks"), path.join(gitDir, "config")]
  ).flatMap((deny) => ["--ro-bind", deny, deny]),
  "--",
  "/bin/bash",
  "-c",
  command,
];

// One run of bwrap tells whether it is installed and may make the user
// namespace it needs. Docker's default seccomp, Ubuntu 24.04's AppArmor
// default, and WSL1 all stop it here.
const probeBwrap = async (): Promise<string | undefined> => {
  try {
    await run(BWRAP, ["--ro-bind", "/", "/", "--", "/bin/true"], {
      timeout: PROBE_TIMEOUT_MS,
    });

    return undefined;
  } catch (error) {
    const failed = Value.Check(ProbeFailureSchema, error) ? error : {};

    return failed.code === "ENOENT"
      ? "bwrap is not installed"
      : `bwrap cannot start: ${(failed.stderr || failed.message || "no output").trim()}`;
  }
};

// A missing root can't be bound, and a missing hooks directory could be
// created by the child, so both are made on the host first. They are empty
// directories, so git and the tools see no change.
const prepareBinds = (gitDir: string | undefined): void => {
  for (const root of cacheRoots()) {
    mkdirSync(root, { recursive: true });
  }

  if (gitDir !== undefined) {
    mkdirSync(path.join(gitDir, "hooks"), { recursive: true });
  }
};

// Run once per child, before its first command. "childSandbox": "off" in the
// config wins on every platform.
export const chooseSandbox = async (
  gitDir: string | undefined
): Promise<Sandbox> => {
  if (readConfig().childSandbox === "off") {
    return { kind: "off" };
  }

  if (process.platform === "darwin" && existsSync(SANDBOX)) {
    return { kind: "sandbox-exec" };
  }

  if (process.platform !== "linux") {
    return {
      kind: "unavailable",
      reason: `no sandbox for ${process.platform}`,
    };
  }

  const problem = await probeBwrap();

  if (problem !== undefined) {
    return { kind: "unavailable", reason: problem };
  }

  prepareBinds(gitDir);

  return { kind: "bubblewrap" };
};

// Undefined when no sandbox runs: the caller must not run the command.
export const wrap = (
  sandbox: Sandbox | undefined,
  command: string,
  workdir: string,
  gitDir: string | undefined
): string | undefined => {
  switch (sandbox?.kind) {
    case "sandbox-exec": {
      return `${SANDBOX} -p ${quote(sandboxProfile(writableRoots(workdir, gitDir), gitDenies(gitDir)))} /bin/bash -c ${quote(command)}`;
    }

    case "bubblewrap": {
      return bwrapArgs(command, workdir, gitDir).map(quote).join(" ");
    }

    case "off": {
      return command;
    }

    default: {
      return undefined;
    }
  }
};

// Why no sandbox runs, or undefined when one does (or "off" was chosen).
export const unavailableReason = (
  sandbox: Sandbox | undefined
): string | undefined => {
  if (sandbox === undefined) {
    return "not chosen yet";
  }

  return sandbox.kind === "unavailable" ? sandbox.reason : undefined;
};

export const sandboxLabel = (sandbox: Sandbox | undefined): string => {
  const reason = unavailableReason(sandbox);

  return reason === undefined
    ? (sandbox?.kind ?? "")
    : `unavailable (${reason})`;
};
