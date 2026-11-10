import assert from "node:assert/strict";
import { glob, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { SessionManager, VERSION } from "@earendil-works/pi-coding-agent";

import { createSession } from "./harness.mjs";

const testDir = import.meta.dirname;
const extensionDir = path.dirname(testDir);
const artifactDir = path.join(extensionDir, "artifacts");

const evidence = {
  checks: [],
  piVersion: VERSION,
  scope: "Implemented Pi extension behavior",
};

const temporary = await mkdtemp(path.join(tmpdir(), "pi-t3-bridge-extension-"));
const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
const previousT3McpUrl = process.env.T3_MCP_URL;

// These sessions stand in for a Pi thread inside T3, where T3 owns the MCP bridge.
process.env.T3_MCP_URL = "http://127.0.0.1:9/mcp";

after(async () => {
  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }

  if (previousT3McpUrl === undefined) {
    Reflect.deleteProperty(process.env, "T3_MCP_URL");
  } else {
    process.env.T3_MCP_URL = previousT3McpUrl;
  }

  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, "implementation.json"),
    `${JSON.stringify(evidence, null, 2)}\n`
  );
  await rm(temporary, { force: true, recursive: true });
});

test("the Pi extension loads the bundled pstack project and supplies session guidance", async () => {
  const cwd = path.join(temporary, "workspace");
  const agentDir = path.join(temporary, "agent");
  const configHome = path.join(temporary, "config");
  const sheetDir = path.join(configHome, "pi-t3-bridge");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(sheetDir, { recursive: true });
  await writeFile(path.join(sheetDir, "models.md"), "session hook: on\n");
  process.env.XDG_CONFIG_HOME = configHome;

  const manager = SessionManager.create(cwd, path.join(temporary, "sessions"));

  const rootId = manager.appendMessage({
    content: "common root",
    role: "user",
    timestamp: Date.now(),
  });

  const abandonedId = manager.appendMessage({
    content: "abandoned branch",
    role: "user",
    timestamp: Date.now(),
  });

  manager.branch(rootId);

  const activeId = manager.appendMessage({
    content: "active branch",
    role: "user",
    timestamp: Date.now(),
  });

  const { loader, session } = await createSession({
    name: "",
    root: temporary,
    sessionManager: () => manager,
    tools: [],
  });

  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 2);

  const errors = [];

  try {
    await session.bindExtensions({
      mode: "rpc",
      onError: (error) => errors.push(error),
    });
    const { skills } = loader.getSkills();

    const bundled = await Array.fromAsync(
      glob("pstack/skills/*/SKILL.md", { cwd: extensionDir })
    );

    assert.equal(skills.length, bundled.length);
    assert.equal(
      new Set(skills.map((skill) => skill.name)).size,
      bundled.length
    );
    assert.equal(
      skills.find((skill) => skill.name === "poteto-mode")
        ?.disableModelInvocation,
      false
    );
    assert.equal(
      skills.find((skill) => skill.name === "reflect")?.disableModelInvocation,
      true
    );
    assert.ok(session.extensionRunner.getToolDefinition("transcript"));

    const base = {
      cwd,
      sections: { existing_instructions: "preserve this section" },
      selectedTools: [],
    };

    const guided = await session.extensionRunner.emitBeforeAgentStart(
      { messageType: "user", prompt: "build a feature" },
      base
    );

    assert.equal(
      guided.systemPromptOptions.sections.existing_instructions,
      "preserve this section"
    );
    const guidance = guided.systemPromptOptions.sections.pi_t3_bridge;
    assert.match(guidance, /poteto-mode/u);
    assert.match(guidance, /transcript/u);
    assert.doesNotMatch(
      guidance,
      /On Codex|t3-pstack-models\.md|t3-pstack:poteto-mode/u,
      "an overlay patch in overlay/overlay.json no longer matches the hook text"
    );
    assert.ok(
      guidance.includes("pstack-overlay"),
      "guidance names the overlaid pstack root, not the upstream copy"
    );

    const tool = session.extensionRunner.getToolDefinition("transcript");

    const toolResult = await tool.execute(
      "test-call",
      {},
      undefined,
      undefined,
      { mode: "rpc", sessionManager: manager }
    );

    assert.equal(toolResult.details.sessionFile, manager.getSessionFile());
    assert.ok(toolResult.details.branchEntryIds.includes(rootId));
    assert.ok(toolResult.details.branchEntryIds.includes(activeId));
    assert.ok(!toolResult.details.branchEntryIds.includes(abandonedId));

    await session.prompt("/t3-transcript");

    const transcriptEntries = manager
      .getBranch()
      .filter((entry) => entry.customType === "pi-t3-transcript");

    assert.equal(transcriptEntries.length, 1);
    assert.equal(
      transcriptEntries[0].data.sessionFile,
      manager.getSessionFile()
    );

    await writeFile(path.join(sheetDir, "models.md"), "session hook: off\n");

    const disabled = await session.extensionRunner.emitBeforeAgentStart(
      { messageType: "user", prompt: "guidance must remain disabled" },
      base
    );

    assert.equal(disabled.systemPromptOptions.sections.pi_t3_bridge, undefined);

    await session.reload();
    assert.equal(loader.getSkills().skills.length, bundled.length);
    assert.equal(
      session.extensionRunner
        .getRegisteredCommands()
        .filter((command) => command.name === "t3-transcript").length,
      1
    );
    assert.deepEqual(errors, []);
    evidence.checks.push({
      diagnostics: loader.getSkills().diagnostics,
      guidanceInjected: true,
      hookOffHonored: true,
      name: "Pi extension end to end contract",
      pass: true,
      providerCalls: 0,
      reloadWithoutDuplicates: true,
      skills: skills.length,
      transcriptCommand: true,
      transcriptTool: true,
    });
  } finally {
    session.dispose();
  }
});
