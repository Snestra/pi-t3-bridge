import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as piSdk from "@earendil-works/pi-coding-agent";

const extensionDir = path.dirname(import.meta.dirname);

test("upstream pstack files live only under pstack/", async () => {
  const upstream = await readdir(path.join(extensionDir, "pstack"));

  // GitHub shows the root README.md on the repository page, so the package keeps
  // its own beside upstream's.
  const stray = upstream.filter(
    (name) => name !== "README.md" && existsSync(path.join(extensionDir, name))
  );

  assert.deepEqual(
    stray,
    [],
    "Upstream files landed at the extension root. Merge pstack-upstream with git merge -X subtree=pstack pstack-upstream, then run npm test so overlay/overlay.json anchors are checked against the new upstream text."
  );
});

// A copy with only the bridge in it, so any import of src/pstack or pstack/
// fails to load.
test("the bridge loads and registers its tools with no pstack files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-t3-bridge-alone-"));

  try {
    await mkdir(path.join(root, "src"));
    await cp(
      path.join(extensionDir, "bridge.ts"),
      path.join(root, "bridge.ts")
    );
    await cp(
      path.join(extensionDir, "package.json"),
      path.join(root, "package.json")
    );
    await cp(
      path.join(extensionDir, "src", "bridge"),
      path.join(root, "src", "bridge"),
      { recursive: true }
    );
    await symlink(
      path.join(extensionDir, "node_modules"),
      path.join(root, "node_modules")
    );

    const agentDir = path.join(root, "agent");

    const settingsManager = piSdk.SettingsManager.inMemory({
      compaction: { enabled: false },
    });

    const loader = new piSdk.DefaultResourceLoader({
      additionalExtensionPaths: [path.join(root, "bridge.ts")],
      agentDir,
      cwd: root,
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager,
    });

    await loader.reload();

    const { errors, extensions } = loader.getExtensions();

    assert.deepEqual(errors, []);
    assert.equal(extensions.length, 1);

    const { session } = await piSdk.createAgentSession({
      agentDir,
      cwd: root,
      resourceLoader: loader,
      sessionManager: piSdk.SessionManager.inMemory(root),
      settingsManager,
      tools: [],
    });

    try {
      await session.bindExtensions({ mode: "rpc" });

      const tools = session.extensionRunner
        .getAllRegisteredTools()
        .map((tool) => tool.definition.name)
        .toSorted();

      const commands = session.extensionRunner
        .getRegisteredCommands()
        .map((command) => command.name)
        .toSorted();

      assert.deepEqual(tools, [
        "ask",
        "create_goal",
        "create_workflow",
        "get_goal",
        "get_workflow",
        "launch_workflow_step",
        "plan",
        "reconcile_workflow_step",
        "tasks",
        "transcript",
        "transition_workflow",
        "update_goal",
      ]);
      assert.deepEqual(commands, [
        "goal",
        "t3-exhausted",
        "t3-recovered",
        "t3-transcript",
        "t3-usage",
      ]);
    } finally {
      session.dispose();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
