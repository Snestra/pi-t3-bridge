import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Validator } from "@earendil-works/pi-schema";
import { lock } from "proper-lockfile";

// Machine-wide bridge files, shared by every Pi session. Each feature owns
// its file's shape. This module only knows how to read and write one safely.

const stateHome = (): string =>
  process.env.XDG_STATE_HOME?.trim() || path.join(homedir(), ".local", "state");

const stateDir = (): string => path.join(stateHome(), "pi-t3");

// Releases before the bridge had its own name kept this state under
// t3-pstack. The first load after the rename moves it once, so out-of-usage
// marks and the cost ledger carry over. A failed move leaves both alone.
export const moveOldState = (): void => {
  const old = path.join(stateHome(), "t3-pstack");

  if (existsSync(stateDir()) || !existsSync(old)) {
    return;
  }

  try {
    renameSync(old, stateDir());
  } catch {
    // The bridge starts with empty state instead.
  }
};

export const statePath = (name: string): string => path.join(stateDir(), name);

// A file that is missing, not JSON, or not the owner's shape reads as
// undefined.
export const readState = <T>(
  name: string,
  validator: Validator<T>
): T | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(name), "utf-8"));

    return validator.check(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

// The write goes to a temporary file renamed over the old one, so a reader
// sees the old file or the new one, never half.
export const writeState = <T>(name: string, value: T, mode?: number): void => {
  mkdirSync(stateDir(), { recursive: true });

  const target = statePath(name);
  const temporary = `${target}.${process.pid}.tmp`;

  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporary, target);
};

// Every Pi session on the machine may change the same file, so the read, the
// change and the write happen under one lock, and no session drops another's
// change.
export const updateState = async <T>(
  name: string,
  validator: Validator<T>,
  change: (current: T | undefined) => T
): Promise<void> => {
  mkdirSync(stateDir(), { recursive: true });

  const target = statePath(name);

  const release = await lock(target, {
    lockfilePath: `${target}.lock`,
    realpath: false,
    retries: { maxTimeout: 200, minTimeout: 20, retries: 50 },
  });

  try {
    writeState(name, change(readState(name, validator)));
  } finally {
    await release();
  }
};

// Each log keeps its newest lines in <name> and the lines before them in
// <name>.1, so one log never holds more than about twice this much.
const LOG_LIMIT_BYTES = 10 * 1024 * 1024;

const OLDER = ".1";

export const appendLog = <T>(name: string, line: T): void => {
  mkdirSync(stateDir(), { recursive: true });

  const file = statePath(name);

  if (
    (statSync(file, { throwIfNoEntry: false })?.size ?? 0) >= LOG_LIMIT_BYTES
  ) {
    renameSync(file, `${file}${OLDER}`);
  }

  appendFileSync(file, `${JSON.stringify(line)}\n`);
};

const readLines = (file: string): string[] => {
  try {
    return readFileSync(file, "utf-8").split("\n");
  } catch {
    return [];
  }
};

// Oldest first, so a later line still wins over an earlier one. Lines that
// are not JSON or not the owner's shape are left out.
export const readLog = <T>(name: string, validator: Validator<T>): T[] => {
  const file = statePath(name);

  return [...readLines(`${file}${OLDER}`), ...readLines(file)].flatMap(
    (line) => {
      try {
        const parsed: unknown = JSON.parse(line);

        return validator.check(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    }
  );
};
