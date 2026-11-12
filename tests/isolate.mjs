// Loaded by `npm test` with --import, so no test file reads or writes the
// user's real config, state, or cache folders. Files that set their own
// XDG paths still override these.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "pi-t3-test-home-"));

for (const [name, folder] of [
  ["XDG_CACHE_HOME", "cache"],
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_STATE_HOME", "state"],
]) {
  process.env[name] = path.join(root, folder);
}

process.on("exit", () => rmSync(root, { force: true, recursive: true }));
