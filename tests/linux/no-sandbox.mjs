// Runs inside the Linux container, started by tests/linux-sandbox.test.mjs.
// Docker's default seccomp stops bubblewrap from making its user namespace,
// so a child has no sandbox and its bash must be blocked.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { brief, childRepo, escapePath, startSession } from "../harness.mjs";

const temporary = await mkdtemp(path.join(tmpdir(), "pi-t3-bridge-linux-"));

process.env.XDG_CONFIG_HOME = path.join(temporary, "config");

process.env.XDG_STATE_HOME = path.join(temporary, "state");

after(async () => {
  await rm(temporary, { force: true, recursive: true });
});

test("on Linux with no usable sandbox, a child's bash is blocked", async () => {
  const repo = await childRepo(temporary, "child-blocked");

  const child = await startSession({
    cwd: repo,
    modelId: "gpt-6.1-sol",
    name: "child-blocked",
    root: temporary,
  });

  try {
    const [escaped] = await child.turn(
      [[["bash", { command: `echo x > ${escapePath}` }]]],
      brief({ accept: "true", files: ["src/a.txt"], job: "implement" }),
      "STATUS: BLOCKED"
    );

    assert.equal(escaped.isError, true, escaped.text);
    assert.match(escaped.text, /bwrap cannot start/u);
    assert.match(escaped.text, /bubblewrap/u);
    assert.equal(existsSync(escapePath), false, "the blocked bash still ran");

    const report = child.lastAssistantText();

    assert.match(report, /STATUS: BLOCKED/u);
    assert.match(report, /SANDBOX: unavailable/u);
    assert.match(report, /ACCEPTANCE: .*exit 126/u);
    assert.match(report, /not run: no sandbox/u);
  } finally {
    child.session.dispose();
    await rm(escapePath, { force: true });
  }
});
