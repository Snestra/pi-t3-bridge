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
import type { PstackPaths } from "./resources.ts";

const SESSION_HOOK_OFF = /^session hook:\s*off\s*$/mu;

export const modelSheetPath = (): string =>
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

export const sessionHookEnabled = (): boolean => {
  const sheetPath = modelSheetPath();

  if (!existsSync(sheetPath)) {
    return true;
  }

  return !SESSION_HOOK_OFF.test(readFileSync(sheetPath, "utf-8"));
};

// paths.pstackRoot already has the overlay applied, so the hook text on
// disk is the Pi text. The overlay owns every rewrite of upstream wording.
export const sessionGuidance = (paths: PstackPaths): string => {
  const contextPath = path.join(
    paths.pstackRoot,
    "hooks",
    "session-start-context.md"
  );

  const guidance = existsSync(contextPath)
    ? readFileSync(contextPath, "utf-8").trim()
    : "You have pi-t3-bridge, pstack for T3 Code.";

  return [
    guidance,
    "",
    "Pi notes:",
    `- The pstack root is ${paths.pstackRoot}. Read skill and agent files there when a skill names a plugin root.`,
    "- The session task tool is `tasks`. Keep the playbook todolist there and send the complete list on every change, with stable step ids and at most one step in_progress.",
    "- When a workflow needs the transcript, use the `transcript` tool, not the Claude Code or Codex finders.",
    "- When a plan needs the user's approval before edits, call the `plan` tool.",
  ].join("\n");
};
