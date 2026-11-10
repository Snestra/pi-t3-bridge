import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import * as piAi from "@earendil-works/pi-ai";
import * as piSdk from "@earendil-works/pi-coding-agent";
import {
  compile,
  num,
  obj,
  opt,
  str,
  unknown,
} from "@earendil-works/pi-schema";

export const extensionDir = path.dirname(import.meta.dirname);

const isString = compile(str()).check;

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
        text: isString(value) ? value : JSON.stringify(value),
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
    parameters: obj({}, { open: true }),
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
    parameters: obj(
      {
        isolation: opt(str()),
        mode: opt(str()),
        target: opt(unknown()),
        task: str(),
      },
      { open: true }
    ),
  });

  pi.registerTool({
    description: "Test double for task_status.",
    execute: () => textResult(world.taskStatus ?? { status: "running" }),
    label: "task_status",
    name: "mcp__t3-code__task_status",
    parameters: obj({ taskId: str() }, { open: true }),
  });

  pi.registerTool({
    description: "Test double for t3_thread_send.",
    execute: (_id, params) => {
      world.sent.push(params);

      return textResult({ ok: true });
    },
    label: "t3_thread_send",
    name: "mcp__t3-code__t3_thread_send",
    parameters: obj(
      {
        message: str(),
        threadId: str(),
      },
      { open: true }
    ),
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
    parameters: obj(
      {
        afterPosition: opt(num()),
        limit: opt(num()),
        maxCharsPerItem: opt(num()),
        threadId: str(),
        view: opt(str()),
      },
      { open: true }
    ),
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

// The Pi session recipe every test file shares: a faux provider, a model
// runtime, a loader with this extension's files, and an agent session. It does
// not bind extensions, so each caller binds its own UI.
//   name, root     the session lives in <root>/<name>/{workspace,agent,sessions}
//   cwd            overrides the workspace directory
//   extensions     file names in the repo root to load
//   extensionFactories  extra in-process extensions
//   modelId        the faux model's ID (and so its family); default faux model if unset
//   jev            true: scripted classifier. false: no Jev at all. "builtin": leave Pi's own
//   classify       scripts the stop judge when jev is true
//   retry          Pi retry settings
//   agentsFiles    the context files the session loads
//   sessionManager (cwd, sessionsDir) => SessionManager, to replace the default
//   tools          passed to createAgentSession
export const createSession = async ({
  agentsFiles = [],
  classify = unscripted,
  cwd,
  extensionFactories = [],
  extensions = ["bridge.ts", "pstack.ts"],
  jev = true,
  modelId,
  name,
  retry = { enabled: false },
  root,
  sessionManager,
  tools,
}) => {
  const sessionRoot = path.join(root, name);
  const workdir = cwd ?? path.join(sessionRoot, "workspace");
  const agentDir = path.join(sessionRoot, "agent");
  const sessionsDir = path.join(sessionRoot, "sessions");

  await mkdir(workdir, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const fauxOptions = { provider: `faux-${name}` };

  if (modelId !== undefined) {
    fauxOptions.models = [{ id: modelId, name: modelId }];
  }

  const faux = piAi.fauxProvider(fauxOptions);

  const modelRuntime = await piSdk.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
  });

  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(`faux-${name}`, "test");

  if (jev === true) {
    await registerClassifier(modelRuntime, classify);
  } else if (jev === false) {
    modelRuntime.registerNativeProvider(
      piAi.createProvider({
        auth: {
          apiKey: {
            name: "Test",
            resolve: () => Promise.resolve({ auth: {} }),
          },
        },
        classifiers: {
          "typesafe-system-one": {
            classify: () =>
              Promise.reject(new Error("No Jev in this session.")),
          },
        },
        id: "typesafe",
        models: [],
      })
    );
  }

  // Pi reports a new provider as configured only after a background refresh.
  // A real session starts long before its first judge call, so wait for it.
  await modelRuntime.refresh({ allowNetwork: false });

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
    extensionFactories,
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
  });

  await loader.reload();

  const sessionOptions = {
    agentDir,
    cwd: workdir,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader: loader,
    sessionManager:
      sessionManager?.(workdir, sessionsDir) ??
      piSdk.SessionManager.create(workdir, sessionsDir),
    settingsManager,
    thinkingLevel: "off",
  };

  if (tools !== undefined) {
    sessionOptions.tools = tools;
  }

  const { session } = await piSdk.createAgentSession(sessionOptions);

  return { cwd: workdir, faux, loader, modelRuntime, session };
};

// One Pi session with this extension loaded, driven by a scripted faux model.
// `modelId` sets the session model's ID, and so its family. `classify` scripts
// the stop judge, and `agentsFiles` are the context files the session loads.
// `jev: false` swaps the built-in typesafe provider for one with no models, so
// the session has no Jev even when TYPESAFE_API_KEY is set on the machine.
export const startSession = async ({
  agentsFiles = [],
  classify = unscripted,
  cwd,
  extensions = ["bridge.ts", "pstack.ts"],
  jev = true,
  modelId = "claude-opus-5-5",
  name,
  retry = { enabled: false },
  root,
  world,
}) => {
  const {
    cwd: workdir,
    faux,
    session,
  } = await createSession({
    agentsFiles,
    classify,
    cwd,
    extensionFactories: world === undefined ? [] : [fakeT3(world)],
    extensions,
    jev,
    modelId,
    name,
    retry,
    root,
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
      isString(end) ? piAi.fauxAssistantMessage(end) : end,
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
