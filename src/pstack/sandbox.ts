import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { compile, num, obj, opt, str, union } from "@earendil-works/pi-schema";

import { readConfig } from "../bridge/config.ts";

// Which sandbox a delegated child's shell commands run in, and how a command
// is wrapped for it. The policy (which paths a command may write, which stay
// read-only inside them) is the same on every OS. Each backend turns it into
// a wrapped command string.

const run = promisify(execFile);

const SANDBOX = "/usr/bin/sandbox-exec";

// Only root can write these, unlike the mise and npm directories on PATH,
// which a child can write, so a child cannot swap in a bwrap of its own.
const BWRAP_PATHS = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"];

const PROBE_TIMEOUT_MS = 10_000;

const isProbeFailure = compile(
  obj(
    {
      code: opt(union([num(), str()])),
      message: opt(str()),
      stderr: opt(str()),
    },
    { open: true }
  )
).check;

// Settled once per child: its own XDG_RUNTIME_DIR, and the pnpm store it
// shares with the parent.
interface ChildEnv {
  readonly pnpmStore: string | undefined;
  readonly runtimeDir: string;
}

export type Sandbox =
  | { kind: "bubblewrap"; bwrap: string; env: ChildEnv }
  | { kind: "off"; env: ChildEnv }
  | { kind: "sandbox-exec"; env: ChildEnv }
  | { kind: "unavailable"; reason: string };

// One shell word, whatever the text holds.
export const quote = (text: string): string =>
  `'${text.replaceAll("'", `'\\''`)}'`;

export const real = (target: string): string => {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
};

// The store pnpm picks for this workdir outside the sandbox, from project and
// user config alike. Undefined when pnpm isn't installed. A store at or above
// home would open all of home, so it stays unbound.
const pnpmStore = async (workdir: string): Promise<string | undefined> => {
  try {
    const { stdout } = await run("pnpm", ["store", "path"], {
      cwd: workdir,
      timeout: PROBE_TIMEOUT_MS,
    });

    const store = path.dirname(stdout.trim());
    const fromHome = path.relative(store, homedir());

    return path.isAbsolute(store) && fromHome.startsWith("..")
      ? store
      : undefined;
  } catch {
    return undefined;
  }
};

// Tool caches, installs and the pnpm store stay writable, so uv, npm, pnpm
// and mise work.
const cacheRoots = (store: string | undefined): string[] => {
  const home = homedir();

  return [
    path.join(home, ".cache"),
    path.join(home, ".npm"),
    path.join(home, ".local", "share", "uv"),
    path.join(home, ".local", "share", "mise"),
    ...(store === undefined ? [] : [store]),
  ];
};

const writableRoots = (
  workdir: string,
  gitDir: string | undefined,
  store: string | undefined
) =>
  [
    workdir,
    gitDir,
    ...cacheRoots(store),
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
  bwrap: string,
  command: string,
  workdir: string,
  gitDir: string | undefined,
  store: string | undefined
): string[] => [
  bwrap,
  "--ro-bind",
  "/",
  "/",
  "--dev-bind",
  "/dev",
  "/dev",
  // A child cannot see or signal processes outside its own commands, so a
  // stray pkill from a child cannot reach a daemon on the host. What a
  // command starts in the background dies when that command ends.
  "--die-with-parent",
  "--unshare-pid",
  "--proc",
  "/proc",
  ...existing(writableRoots(workdir, gitDir, store)).flatMap((root) =>
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
const probeBwrap = async (bwrap: string): Promise<string | undefined> => {
  try {
    await run(bwrap, ["--ro-bind", "/", "/", "--", "/bin/true"], {
      timeout: PROBE_TIMEOUT_MS,
    });

    return undefined;
  } catch (error) {
    const failed = isProbeFailure(error) ? error : {};

    return `bwrap cannot start: ${(failed.stderr || failed.message || "no output").trim()}`;
  }
};

// A missing root can't be bound, and a missing hooks directory could be
// created by the child, so both are made on the host first. They are empty
// directories, so git and the tools see no change. A root the user can't
// create stays unbound.
const prepareBinds = (
  gitDir: string | undefined,
  store: string | undefined
): void => {
  for (const root of cacheRoots(store)) {
    try {
      mkdirSync(root, { recursive: true });
    } catch {
      // Left unbound.
    }
  }

  if (gitDir !== undefined) {
    mkdirSync(path.join(gitDir, "hooks"), { recursive: true });
  }
};

// Runtime directories made in this process and not yet removed. A session
// that ends without session_shutdown, such as an SDK session.dispose(), would
// otherwise leave its directory behind, so the rest go when the process exits.
const runtimeDirs = new Set<string>();

const removeRuntimeDir = (dir: string): void => {
  rmSync(dir, { force: true, recursive: true });
  runtimeDirs.delete(dir);
};

process.once("exit", () => {
  for (const dir of runtimeDirs) {
    removeRuntimeDir(dir);
  }
});

const childEnv = async (workdir: string): Promise<ChildEnv> => {
  const store = await pnpmStore(workdir);
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "pi-t3-child-"));

  runtimeDirs.add(runtimeDir);

  return { pnpmStore: store, runtimeDir };
};

// Run once per child, before its first command. "childSandbox": "off" in the
// config wins on every platform.
export const chooseSandbox = async (
  workdir: string,
  gitDir: string | undefined
): Promise<Sandbox> => {
  if (readConfig().childSandbox === "off") {
    return { env: await childEnv(workdir), kind: "off" };
  }

  if (process.platform === "darwin" && existsSync(SANDBOX)) {
    return { env: await childEnv(workdir), kind: "sandbox-exec" };
  }

  if (process.platform !== "linux") {
    return {
      kind: "unavailable",
      reason: `no sandbox for ${process.platform}`,
    };
  }

  const bwrap = BWRAP_PATHS.find((candidate) => existsSync(candidate));

  if (bwrap === undefined) {
    return {
      kind: "unavailable",
      reason: `bwrap is not installed in ${BWRAP_PATHS.join(" or ")}`,
    };
  }

  const problem = await probeBwrap(bwrap);

  if (problem !== undefined) {
    return { kind: "unavailable", reason: problem };
  }

  const env = await childEnv(workdir);

  try {
    prepareBinds(gitDir, env.pnpmStore);
  } catch (error) {
    removeRuntimeDir(env.runtimeDir);

    throw error;
  }

  return { bwrap, env, kind: "bubblewrap" };
};

// Removes the runtime directory chooseSandbox made for this child. Pi calls
// session_shutdown once the child's session ends, so no command of this child
// still needs it.
export const releaseSandbox = (sandbox: Sandbox | undefined): void => {
  if (sandbox !== undefined && sandbox.kind !== "unavailable") {
    removeRuntimeDir(sandbox.env.runtimeDir);
  }
};

// pnpm 12 takes its store lock in $XDG_RUNTIME_DIR, which the sandbox keeps
// read-only, so each child gets its own. Each bwrap bind is its own mount, and
// Linux refuses a hardlink between mounts, so pnpm would build a second store
// in the workdir. Naming the store keeps the one pnpm picked for the parent,
// and pnpm copies from it. Install scripts stay off, so a `prepare` such as `lefthook install`
// doesn't fail on the read-only hooks. npm and yarn read npm_config_*, pnpm 11
// and later read pnpm_config_*. npm also skips pre and post scripts of
// `npm run` then.
const exportEnv = (env: ChildEnv, command: string): string =>
  `export XDG_RUNTIME_DIR=${quote(env.runtimeDir)} TMPDIR=${quote(tmpdir())}${env.pnpmStore === undefined ? "" : ` pnpm_config_store_dir=${quote(env.pnpmStore)}`} npm_config_ignore_scripts=true pnpm_config_ignore_scripts=true; ${command}`;

// Undefined when no sandbox runs: the caller must not run the command.
export const wrap = (
  sandbox: Sandbox | undefined,
  command: string,
  workdir: string,
  gitDir: string | undefined
): string | undefined => {
  switch (sandbox?.kind) {
    case "sandbox-exec": {
      return exportEnv(
        sandbox.env,
        `${SANDBOX} -p ${quote(sandboxProfile(writableRoots(workdir, gitDir, sandbox.env.pnpmStore), gitDenies(gitDir)))} /bin/bash -c ${quote(command)}`
      );
    }

    case "bubblewrap": {
      return exportEnv(
        sandbox.env,
        bwrapArgs(
          sandbox.bwrap,
          command,
          workdir,
          gitDir,
          sandbox.env.pnpmStore
        )
          .map(quote)
          .join(" ")
      );
    }

    case "off": {
      return exportEnv(sandbox.env, command);
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
