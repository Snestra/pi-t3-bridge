import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import * as piAi from "@earendil-works/pi-ai";
import * as piSdk from "@earendil-works/pi-coding-agent";
import { obj, opt, str, unknown } from "@earendil-works/pi-schema";

const extensionDir = path.dirname(import.meta.dirname);

const liveCatalog = JSON.parse(
  await readFile(
    path.join(import.meta.dirname, "fixtures/t3-catalog.json"),
    "utf-8"
  )
);

const policy = JSON.parse(
  await readFile(path.join(extensionDir, "pstack", "models.json"), "utf-8")
);

const temporary = await mkdtemp(path.join(tmpdir(), "pi-t3-bridge-models-"));
const sheetDir = path.join(temporary, "config", "pi-t3-bridge");
const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
const previousT3McpUrl = process.env.T3_MCP_URL;
const previousStateHome = process.env.XDG_STATE_HOME;

process.env.XDG_CONFIG_HOME = path.join(temporary, "config");

process.env.T3_MCP_URL = "http://127.0.0.1:9/mcp";

process.env.XDG_STATE_HOME = path.join(temporary, "state");

after(async () => {
  for (const [key, value] of [
    ["XDG_CONFIG_HOME", previousXdgConfigHome],
    ["T3_MCP_URL", previousT3McpUrl],
    ["XDG_STATE_HOME", previousStateHome],
  ]) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  await rm(temporary, { force: true, recursive: true });
});

const delegated = [];

const delegateTool = (pi) => {
  pi.registerTool({
    description: "Test double for T3's delegate_task.",
    execute: (_id, params) => {
      delegated.push(params);

      return Promise.resolve({
        content: [{ text: "started", type: "text" }],
        details: undefined,
      });
    },
    label: "delegate_task",
    name: "mcp__t3-code__delegate_task",
    parameters: obj(
      {
        target: opt(unknown()),
        task: str(),
      },
      { open: true }
    ),
  });
};

const catalogTool = (catalog, bridged) => (pi) => {
  pi.registerTool({
    description: "Test double for T3's orchestrator_capabilities.",
    execute: () =>
      Promise.resolve(
        bridged
          ? {
              content: [{ text: "Catalog ready.", type: "text" }],
              details: undefined,
              structuredContent: {
                content: [{ text: "Catalog ready.", type: "text" }],
                isError: false,
                structuredContent: catalog,
              },
            }
          : {
              content: [{ text: JSON.stringify(catalog), type: "text" }],
              details: undefined,
            }
      ),
    exposure: "deferred",
    label: "orchestrator_capabilities",
    name: "mcp__t3-code__orchestrator_capabilities",
    parameters: obj({}, { open: true }),
  });
};

const runTurn = async ({
  bridged = false,
  calls,
  turns = [calls],
  catalog = liveCatalog,
  name,
  prompt = "Run the scripted turn.",
  sheet = "",
}) => {
  await mkdir(sheetDir, { recursive: true });
  await writeFile(path.join(sheetDir, "models.md"), sheet);

  const root = path.join(temporary, name);
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");

  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const faux = piAi.fauxProvider({ provider: `faux-${name}` });

  const modelRuntime = await piSdk.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
  });

  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(`faux-${name}`, "test");

  const settingsManager = piSdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  const loader = new piSdk.DefaultResourceLoader({
    additionalExtensionPaths: [
      path.join(extensionDir, "bridge.ts"),
      path.join(extensionDir, "pstack.ts"),
    ],
    agentDir,
    cwd,
    extensionFactories: [catalogTool(catalog, bridged), delegateTool],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
  });

  await loader.reload();

  const { session } = await piSdk.createAgentSession({
    agentDir,
    cwd,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader: loader,
    sessionManager: piSdk.SessionManager.inMemory(cwd),
    settingsManager,
    thinkingLevel: "off",
  });

  await session.bindExtensions({ mode: "rpc" });

  try {
    faux.setResponses([
      ...turns.map((turnCalls) =>
        piAi.fauxAssistantMessage(
          turnCalls.map(([tool, args]) => piAi.fauxToolCall(tool, args)),
          { stopReason: "toolUse" }
        )
      ),
      piAi.fauxAssistantMessage("Done."),
    ]);
    await session.prompt(prompt);

    return session.messages.filter((message) => message.role === "toolResult");
  } finally {
    session.dispose();
  }
};

const resolve = async ({ roles, ...options }) => {
  const results = await runTurn({
    ...options,
    calls: roles.map((role) => [
      "pstack_model",
      role instanceof Object ? role : { role },
    ]),
  });

  return results.map((message) => {
    assert.equal(message.isError, false, JSON.stringify(message.content));

    return message.details;
  });
};

// A real sheet as a user wrote it, with named panels and auto roles.
const SHEET = await readFile(
  path.join(import.meta.dirname, "fixtures/models-sheet.txt"),
  "utf-8"
);

const onPi = (model, thinking) => ({
  model: `cliproxyapi/${model}`,
  options: { thinking },
  providerInstanceId: "pi",
});

test("a sheet panel on disabled providers moves to the same models on Pi", async () => {
  const [panel] = await resolve({
    name: "sheet-panel",
    roles: ["interrogate reviewers"],
    sheet:
      "interrogate reviewers: claudeAgent/claude-opus-5-5 effort=high, codex/gpt-6.1-sol reasoningEffort=high, muse/muse-wonder-1.0 reasoningEffort=high\n",
  });

  assert.deepEqual(panel.targets, [
    onPi("claude-opus-5-5", "high"),
    onPi("gpt-6.1-sol", "high"),
    onPi("muse-wonder-1.0", "high"),
  ]);
});

test("a sheet model with no reasoning level takes it from the job's complexity", async () => {
  const [groundwork, bounded, general, pinned, panel] = await resolve({
    name: "sheet-reasoning",
    roles: [
      { complexity: "groundwork", role: "feature, refactoring" },
      { complexity: "bounded", role: "feature, refactoring" },
      { complexity: "general", role: "feature, refactoring" },
      { complexity: "groundwork", role: "hardest tasks" },
      { complexity: "bounded", role: "interrogate reviewers" },
    ],
    sheet: [
      "feature, refactoring: pi/cliproxyapi/claude-opus-5-5",
      "hardest tasks: pi/cliproxyapi/claude-opus-5-5 thinking=high",
      "interrogate reviewers: pi/cliproxyapi/claude-opus-5-5, codex/gpt-6.1-sol reasoningEffort=high",
      "",
    ].join("\n"),
  });

  assert.deepEqual(groundwork.targets, [onPi("claude-opus-5-5", "low")]);
  assert.deepEqual(bounded.targets, [onPi("claude-opus-5-5", "medium")]);
  assert.deepEqual(general.targets, [onPi("claude-opus-5-5", "high")]);
  assert.deepEqual(pinned.targets, [onPi("claude-opus-5-5", "high")]);
  assert.deepEqual(panel.targets, [
    onPi("claude-opus-5-5", "medium"),
    onPi("gpt-6.1-sol", "high"),
  ]);
});

test("routed roles stay in the parent's family and size by complexity", async () => {
  const gptParent = {
    ...structuredClone(liveCatalog),
    inheritedModel: "cliproxyapi/gpt-6.1-sol",
    inheritedProviderInstanceId: "pi",
  };

  const [general, bounded, groundwork] = await resolve({
    catalog: gptParent,
    name: "routed",
    roles: [
      { complexity: "general", role: "feature, refactoring" },
      { complexity: "bounded", role: "how explorer" },
      { complexity: "groundwork", role: "swarm workers" },
    ],
    sheet: "feature, refactoring: inherit-parent\n",
  });

  assert.deepEqual(general.targets, [onPi("gpt-6-astra", "high")]);
  assert.deepEqual(bounded.targets, [onPi("gpt-6.1-sol", "medium")]);
  assert.deepEqual(groundwork.targets, [onPi("gpt-6-luna", "low")]);
});

test("a panel with no sheet line seats one model per family", async () => {
  const [panel] = await resolve({
    name: "routed-panel",
    roles: [{ complexity: "bounded", role: "architect runners" }],
  });

  assert.deepEqual(panel.targets, [
    onPi("claude-sonnet-5-5", "medium"),
    onPi("gpt-6.1-sol", "medium"),
    onPi("muse-wonder-1.0", "medium"),
  ]);
});

test("the catalog is read through T3's in-thread bridge result", async () => {
  const [panel] = await resolve({
    bridged: true,
    name: "bridged",
    roles: ["architect runners"],
  });

  assert.equal(panel.targets.length, 3);
});

test("a sheet target on a provider that comes back is used as written", async () => {
  const enabled = structuredClone(liveCatalog);

  const claude = enabled.providers.find(
    (provider) => provider.providerInstanceId === "claudeAgent"
  );

  claude.canRunChildTask = true;
  claude.canRunCrossProviderChildTask = true;

  const [single] = await resolve({
    catalog: enabled,
    name: "enabled",
    roles: ["bug-fix"],
    sheet: "bug-fix: claudeAgent/claude-opus-5-5 effort=high\n",
  });

  assert.deepEqual(single.targets, [
    {
      model: "claude-opus-5-5",
      options: { effort: "high" },
      providerInstanceId: "claudeAgent",
    },
  ]);
});

test("a switch option comes back as the boolean T3 expects, and only its own name sets it", async () => {
  const enabled = structuredClone(liveCatalog);

  const claude = enabled.providers.find(
    (provider) => provider.providerInstanceId === "claudeAgent"
  );

  claude.canRunChildTask = true;
  claude.canRunCrossProviderChildTask = true;

  const [single] = await resolve({
    catalog: enabled,
    name: "switch",
    roles: ["bug-fix"],
    sheet:
      "bug-fix: claudeAgent/claude-opus-5-5 effort=high fastMode=true fast=true\n",
  });

  assert.deepEqual(single.targets, [
    {
      model: "claude-opus-5-5",
      options: { effort: "high", fastMode: true },
      providerInstanceId: "claudeAgent",
    },
  ]);
  assert.ok(
    single.notes.some((note) => note.includes("fast=true")),
    JSON.stringify(single.notes)
  );
});

test("a panel that cannot reach two model families is blocked", async () => {
  const claudeOnly = structuredClone(liveCatalog);

  const pi = claudeOnly.providers.find(
    (provider) => provider.providerInstanceId === "pi"
  );

  pi.models = pi.models.filter((model) => model.id.includes("claude"));

  const [panel] = await resolve({
    catalog: claudeOnly,
    name: "one-family",
    roles: ["architect runners"],
  });

  assert.equal(panel.kind, "blocked");
  assert.match(panel.reason, /BLOCKED: independent review/u);
});

test("a single role with no runnable model runs on the parent", async () => {
  const [single] = await resolve({
    catalog: { ...structuredClone(liveCatalog), providers: [] },
    name: "empty",
    roles: ["how explorer"],
  });

  assert.equal(single.kind, "inherit-parent");
});

test("every role in a user's sheet resolves on the live catalog", async () => {
  const results = await resolve({
    name: "user-sheet",
    roles: policy.roles.map((role) => role.role),
    sheet: SHEET,
  });

  assert.equal(results.length, policy.roles.length);
  assert.ok(results.every((result) => result.kind !== "blocked"));
});

test("each skill's Models section lists its roles", async () => {
  const skills = await Promise.all(
    policy.roles.map((role) =>
      readFile(
        path.join(extensionDir, "pstack", "skills", role.skill, "SKILL.md"),
        "utf-8"
      )
    )
  );

  for (const [index, role] of policy.roles.entries()) {
    assert.ok(
      skills[index].includes(`- ${role.role}: `),
      `${role.skill} lists ${role.role}`
    );
  }
});
