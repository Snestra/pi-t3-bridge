import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { brief } from "./harness.mjs";

const extensionDir = path.dirname(import.meta.dirname);

const installRoot =
  process.env.PI_MANAGED_INSTALL_ROOT ??
  path.join(homedir(), ".pi/agent/install");

const versionText = await readFile(
  path.join(installRoot, "current-version"),
  "utf-8"
);

const modulesRoot = path.join(
  installRoot,
  "releases",
  versionText.trim(),
  "node_modules/@earendil-works"
);

const piSdk = await import(
  pathToFileURL(path.join(modulesRoot, "pi-coding-agent/dist/index.js"))
);

const piAi = await import(
  pathToFileURL(path.join(modulesRoot, "pi-ai/dist/index.js"))
);

const { Type } = await import(
  pathToFileURL(path.join(modulesRoot, "../typebox/build/index.mjs"))
);

const liveCatalog = JSON.parse(
  await readFile(
    path.join(import.meta.dirname, "fixtures/t3-catalog.json"),
    "utf-8"
  )
);

const claudeParent = {
  ...structuredClone(liveCatalog),
  inheritedModel: "cliproxyapi/claude-opus-5-5",
  inheritedProviderInstanceId: "pi",
};

const temporary = await mkdtemp(path.join(tmpdir(), "pi-t3-bridge-accounts-"));

const savedEnv = new Map(
  ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "T3_MCP_URL"].map((key) => [
    key,
    process.env[key],
  ])
);

process.env.XDG_CONFIG_HOME = path.join(temporary, "config");

process.env.T3_MCP_URL = "http://127.0.0.1:9/mcp";

await mkdir(path.join(temporary, "config", "pi-t3-bridge"), {
  recursive: true,
});

await writeFile(
  path.join(temporary, "config", "pi-t3-bridge", "models.md"),
  ""
);

after(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  await rm(temporary, { force: true, recursive: true });
});

const textResult = (value) =>
  Promise.resolve({
    content: [{ text: JSON.stringify(value), type: "text" }],
    details: undefined,
  });

const fakeT3 = (world) => (pi) => {
  pi.registerTool({
    description: "Test double for orchestrator_capabilities.",
    execute: () => textResult(world.catalog),
    exposure: "deferred",
    label: "orchestrator_capabilities",
    name: "mcp__t3-code__orchestrator_capabilities",
    parameters: Type.Object({}),
  });

  pi.registerTool({
    description: "Test double for delegate_task.",
    execute: (_id, params) => {
      world.started += 1;

      const taskId = `task-${world.started}`;

      world.delegated.push({ ...params, taskId });

      return textResult({
        childThreadId: `child-${taskId}`,
        status: "running",
        taskId,
      });
    },
    label: "delegate_task",
    name: "mcp__t3-code__delegate_task",
    parameters: Type.Object({
      target: Type.Optional(Type.Unknown()),
      task: Type.String(),
    }),
  });

  pi.registerTool({
    description: "Test double for t3_thread_read.",
    execute: (_id, params) => {
      world.reads.push(params);

      const outcome = world.outcomes.get(params.threadId) ?? "running";
      const failed = outcome === "usage-limit" || outcome === "provider-error";

      return textResult({
        hasMore: false,
        items: failed
          ? [
              {
                status: "failed",
                text: "x",
                textTruncated: true,
                title:
                  outcome === "usage-limit"
                    ? "Usage limit reached"
                    : "Provider error",
                type: "error",
              },
            ]
          : [],
        nextPosition: 1,
        recentRuns: [{ status: failed ? "failed" : outcome }],
        thread: {
          status: failed ? "failed" : outcome,
          threadId: params.threadId,
        },
      });
    },
    exposure: "deferred",
    label: "t3_thread_read",
    name: "mcp__t3-code__t3_thread_read",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      maxCharsPerItem: Type.Optional(Type.Number()),
      threadId: Type.String(),
      view: Type.Optional(Type.String()),
    }),
  });
};

const startSession = async (name, world) => {
  const root = path.join(temporary, name);

  process.env.XDG_STATE_HOME = path.join(root, "state");
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
    extensionFactories: [fakeT3(world)],
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
    sessionManager: piSdk.SessionManager.create(
      cwd,
      path.join(root, "sessions")
    ),
    settingsManager,
    thinkingLevel: "off",
  });

  await session.bindExtensions({ mode: "rpc" });

  const turn = async (calls, prompt = "Run the scripted turn.") => {
    const before = session.messages.length;

    faux.setResponses([
      ...calls.map(([tool, args]) =>
        piAi.fauxAssistantMessage([piAi.fauxToolCall(tool, args)], {
          stopReason: "toolUse",
        })
      ),
      piAi.fauxAssistantMessage("Done."),
    ]);
    await session.prompt(prompt);

    return session.messages
      .slice(before)
      .filter((message) => message.role === "toolResult")
      .map((message) => ({
        details: message.details,
        isError: message.isError,
        text: message.content.map((part) => part.text ?? "").join(" "),
      }));
  };

  return { session, turn };
};

const newWorld = (catalog = claudeParent) => ({
  catalog,
  delegated: [],
  outcomes: new Map(),
  reads: [],
  started: 0,
});

const model = (role, complexity = "general") => [
  "pstack_model",
  { complexity, role },
];

const delegate = (target) => [
  "mcp__t3-code__delegate_task",
  target === undefined
    ? { task: brief({ size: "M" }) }
    : {
        isolation: "worktree",
        target,
        task: brief({ size: /gpt/u.test(target.model) ? "S" : "M" }),
      },
];

const onPi = (id, thinking = "high") => ({
  model: `cliproxyapi/${id}`,
  options: { thinking },
  providerInstanceId: "pi",
});

test("an ordinary provider error does not exclude the family", async () => {
  const world = newWorld();
  const { session, turn } = await startSession("provider-error", world);

  try {
    await turn([model("bug-fix"), delegate(onPi("claude-opus-5-5"))]);
    world.outcomes.set("child-task-1", "provider-error");

    const [again, started] = await turn([
      model("bug-fix"),
      delegate(onPi("claude-opus-5-5")),
    ]);

    assert.deepEqual(again.details.targets, [onPi("claude-opus-5-5")]);
    assert.equal(started.isError, false, started.text);
  } finally {
    session.dispose();
  }
});

test("a finished delegate is read once, with truncated text so its delivery stays intact", async () => {
  const world = newWorld();
  const { session, turn } = await startSession("read-once", world);

  try {
    await turn([model("bug-fix"), delegate(onPi("claude-opus-5-5"))]);
    world.outcomes.set("child-task-1", "completed");
    await turn([model("bug-fix")]);
    await turn([model("bug-fix")]);

    assert.equal(world.reads.length, 1);
    assert.equal(world.reads[0].threadId, "child-task-1");
    assert.equal(world.reads[0].maxCharsPerItem, 400);
  } finally {
    session.dispose();
  }
});

test("a panel drops exhausted families and blocks below two", async () => {
  const world = newWorld();
  const { session, turn } = await startSession("panel", world);

  try {
    await session.prompt("/t3-exhausted claude");

    const [twoLeft] = await turn([model("interrogate reviewers")]);

    assert.deepEqual(twoLeft.details.targets, [
      onPi("gpt-6-astra"),
      onPi("muse-wonder-full-1.0"),
    ]);

    await session.prompt("/t3-exhausted gpt");

    const [oneLeft] = await turn([model("interrogate reviewers")]);

    assert.equal(oneLeft.details.kind, "blocked");
  } finally {
    session.dispose();
  }
});
