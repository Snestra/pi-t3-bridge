import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { PstackPaths } from "./resources.ts";

// paths.pstackRoot already has the overlay applied, so the hook text on
// disk is the Pi text. The overlay owns every rewrite of upstream wording.
export const sessionGuidance = (paths: PstackPaths): string => {
  const contextPath = path.join(
    paths.pstackRoot,
    "hooks",
    "session-start-context.md"
  );

  // A checkout without pstack/ serves no hook file of its own.
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
