import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import { configHome } from "../bridge/config.ts";

// The user's pstack model sheet: which model each role runs on, and switches
// such as the session hook.

const SESSION_HOOK_OFF = /^session hook:\s*off\s*$/mu;

const modelSheetPath = (): string =>
  path.join(configHome(), "pi-t3-bridge", "models.md");

// Releases before the rename kept the sheet under t3-pstack. The first load
// after the rename moves it once. A symlinked sheet gets a new link to its
// resolved target, since a relative link would dangle once moved. A failed
// move leaves both alone.
export const moveOldSheet = (): void => {
  const old = path.join(configHome(), "t3-pstack", "models.md");
  const sheet = modelSheetPath();

  if (existsSync(sheet) || !existsSync(old)) {
    return;
  }

  try {
    mkdirSync(path.dirname(sheet), { recursive: true });

    if (lstatSync(old).isSymbolicLink()) {
      symlinkSync(realpathSync(old), sheet);
      unlinkSync(old);
    } else {
      renameSync(old, sheet);
    }
  } catch {
    // Routing falls back to the defaults instead.
  }
};

// The user's model sheet, or "" when there is none, so routing uses the
// defaults.
export const readSheet = (): string => {
  try {
    return readFileSync(modelSheetPath(), "utf-8");
  } catch {
    return "";
  }
};

// The sheet can turn off pstack's session guidance with "session hook: off".
export const sessionHookEnabled = (): boolean =>
  !SESSION_HOOK_OFF.test(readSheet());
