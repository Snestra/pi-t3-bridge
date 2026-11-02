import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const extensionDir = path.dirname(import.meta.dirname);

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

export const piSdk = await import(
  pathToFileURL(path.join(modulesRoot, "pi-coding-agent/dist/index.js"))
);

export const piAi = await import(
  pathToFileURL(path.join(modulesRoot, "pi-ai/dist/index.js"))
);

const { Type } = await import(
  pathToFileURL(path.join(modulesRoot, "../typebox/build/index.mjs"))
);

const { Value } = await import(
  pathToFileURL(path.join(modulesRoot, "../typebox/build/value/index.mjs"))
);

export const liveCatalog = JSON.parse(
  await readFile(
    path.join(import.meta.dirname, "fixtures/t3-catalog.json"),
    "utf-8"
  )
);

export const textResult = (value) =>
  Promise.resolve({
    content: [
      {
        text: Value.Check(Type.String(), value) ? value : JSON.stringify(value),
        type: "text",
      },
    ],
    details: undefined,
  });

// T3's tools as test doubles. `world` records what the extension sent.
export const fakeT3 = (world) => (pi) => {
  pi.registerTool({
    description: "Test double for orchestrator_capabilities.",
    execute: () => textResult(world.catalog ?? liveCatalog),
    exposure: "deferred",
    label: "orchestrator_capabilities",
    name: "mcp__t3-code__orchestrator_capabilities",
    parameters: Type.Object({}),
  });

  pi.registerTool({
    description: "Test double for delegate_task.",
    execute: (_id, params) => {
      world.started = (world.started ?? 0) + 1;

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
      isolation: Type.Optional(Type.String()),
      mode: Type.Optional(Type.String()),
      target: Type.Optional(Type.Unknown()),
      task: Type.String(),
    }),
  });

  pi.registerTool({
    description: "Test double for task_status.",
    execute: () => textResult(world.taskStatus ?? { status: "running" }),
    label: "task_status",
    name: "mcp__t3-code__task_status",
    parameters: Type.Object({ taskId: Type.String() }),
  });

  pi.registerTool({
    description: "Test double for t3_thread_send.",
    execute: (_id, params) => {
      world.sent.push(params);

      return textResult({ ok: true });
    },
    label: "t3_thread_send",
    name: "mcp__t3-code__t3_thread_send",
    parameters: Type.Object({
      message: Type.String(),
      threadId: Type.String(),
    }),
  });

  pi.registerTool({
    description: "Test double for t3_thread_read.",
    execute: (_id, params) => {
      world.reads.push(params);

      const outcome = world.outcomes.get(params.threadId) ?? {
        status: "running",
      };

      return textResult({
        hasMore: false,
        items: outcome.error
          ? [
              {
                status: "failed",
                text: outcome.error.slice(0, params.maxCharsPerItem ?? 4000),
                textTruncated:
                  outcome.error.length > (params.maxCharsPerItem ?? 4000),
                title: outcome.title ?? "Provider error",
                type: "error",
              },
            ]
          : [],
        nextPosition: 1,
        recentRuns: [{ status: outcome.status }],
        thread: { status: outcome.status, threadId: params.threadId },
      });
    },
    exposure: "deferred",
    label: "t3_thread_read",
    name: "mcp__t3-code__t3_thread_read",
    parameters: Type.Object({
      afterPosition: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
      maxCharsPerItem: Type.Optional(Type.Number()),
      threadId: Type.String(),
      view: Type.Optional(Type.String()),
    }),
  });
};

export const newWorld = (catalog = liveCatalog) => ({
  catalog,
  delegated: [],
  outcomes: new Map(),
  reads: [],
  sent: [],
  started: 0,
});

// A classifier that answers nothing, so a session never reaches the real Jev
// unless a test scripts one.
const unscripted = () => ({
  answers: {},
  errorMessage: "No classifier is scripted for this session.",
  stopReason: "error",
});

// Replaces the built-in `typesafe` provider with one whose classifier is a
// function of the request: `classify(context)` returns `{ answers, stopReason }`.
const registerClassifier = async (modelRuntime, classify) => {
  modelRuntime.registerNativeProvider(
    piAi.createProvider({
      auth: {
        apiKey: { name: "Test", resolve: () => Promise.resolve({ auth: {} }) },
      },
      classifiers: {
        "typesafe-system-one": {
          classify: async (model, context) => ({
            api: model.api,
            model: model.id,
            provider: model.provider,
            timestamp: Date.now(),
            ...(await classify(context)),
          }),
        },
      },
      id: "typesafe",
      models: [
        {
          api: "typesafe-system-one",
          contextWindow: 64_000,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
          id: "jev-latest",
          input: ["text"],
          name: "Jev test",
          provider: "typesafe",
          type: "classifier",
        },
      ],
    })
  );
  await modelRuntime.setRuntimeApiKey("typesafe", "test");
};

// One Pi session with this extension loaded, driven by a scripted faux model.
// `modelId` sets the session model's ID, and so its family. `classify` scripts
// the stop judge, and `agentsFiles` are the context files the session loads.
export const startSession = async ({
  agentsFiles = [],
  classify = unscripted,
  cwd,
  extensions = ["bridge.ts", "pstack.ts"],
  modelId = "claude-opus-5-5",
  name,
  retry = { enabled: false },
  root,
  world,
}) => {
  const sessionRoot = path.join(root, name);
  const workdir = cwd ?? path.join(sessionRoot, "workspace");
  const agentDir = path.join(sessionRoot, "agent");

  await mkdir(workdir, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const faux = piAi.fauxProvider({
    models: [{ id: modelId, name: modelId }],
    provider: `faux-${name}`,
  });

  const modelRuntime = await piSdk.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
  });

  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(`faux-${name}`, "test");
  await registerClassifier(modelRuntime, classify);

  const settingsManager = piSdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry,
  });

  const loader = new piSdk.DefaultResourceLoader({
    additionalExtensionPaths: extensions.map((file) =>
      path.join(extensionDir, file)
    ),
    agentDir,
    agentsFilesOverride: () => ({ agentsFiles }),
    cwd: workdir,
    extensionFactories: world === undefined ? [] : [fakeT3(world)],
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
    cwd: workdir,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader: loader,
    sessionManager: piSdk.SessionManager.create(
      workdir,
      path.join(sessionRoot, "sessions")
    ),
    settingsManager,
    thinkingLevel: "off",
  });

  await session.bindExtensions({ mode: "rpc" });

  const results = (before) =>
    session.messages
      .slice(before)
      .filter((message) => message.role === "toolResult")
      .map((message) => ({
        details: message.details,
        isError: message.isError,
        text: message.content.map((part) => part.text ?? "").join(" "),
      }));

  // Each inner list is one assistant message's tool calls. `end` is the final
  // assistant message: a string, or a faux message such as an error.
  const turn = async (
    steps,
    prompt = "Run the scripted turn.",
    end = "Done."
  ) => {
    const before = session.messages.length;

    faux.setResponses([
      ...steps.map((calls) =>
        piAi.fauxAssistantMessage(
          calls.map(([tool, args]) => piAi.fauxToolCall(tool, args)),
          { stopReason: "toolUse" }
        )
      ),
      Value.Check(Type.String(), end) ? piAi.fauxAssistantMessage(end) : end,
    ]);
    await session.prompt(prompt);

    return results(before);
  };

  const lastAssistantText = () => {
    const last = session.messages.findLast(
      (message) => message.role === "assistant"
    );

    return (last?.content ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  };

  return { cwd: workdir, faux, lastAssistantText, session, turn };
};

// A brief in the pstack template. `drop` leaves sections out, to test the guard.
export const brief = ({
  accept = "node --test test/a.test.mjs",
  disk = 500,
  drop = [],
  extra = "",
  files = ["src/a.ts"],
  job = "implement",
  minutes = 30,
  size = "S",
} = {}) => {
  const sections = [
    [
      "header",
      `# Task: make the test pass\nJob: ${job} · Size: ${size} · Time limit: ${minutes} min · Disk limit: ${disk} MB`,
    ],
    ["goal", "## Goal\nMake the test pass."],
    ["accept", `## Acceptance command\n\`\`\`sh\n${accept}\n\`\`\``],
    [
      "files",
      `## Files you may write\n${files.map((file) => `- ${file}`).join("\n")}`,
    ],
    ["nongoals", "## Non-goals\n- No other changes."],
    ["context", "## Context\n- /Users/example/repo/src: where the code lives"],
    [
      "stop",
      "## Stop conditions\nStop and report BLOCKED when a fact here is wrong.",
    ],
    ["report", "## Report\nSTATUS: PASS | ISSUES | BLOCKED"],
  ];

  return `${sections
    .flatMap(([key, text]) => (drop.includes(key) ? [] : [text]))
    .join("\n\n")}${extra}`;
};

// A git repo with one commit, at <root>/<name>/repo, for a child to work in.
export const childRepo = async (root, name) => {
  const repo = path.join(root, name, "repo");

  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "keep.txt"), "keep\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    { cwd: repo }
  );

  return repo;
};

// A file outside every writable root, which a sandboxed child must not create.
export const escapePath = path.join(
  homedir(),
  ".pi-t3-bridge-sandbox-escape-test"
);

export const onPi = (model, thinking) => ({
  model: `cliproxyapi/${model}`,
  options: { thinking },
  providerInstanceId: "pi",
});
