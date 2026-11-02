import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

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

const temporary = await mkdtemp(path.join(tmpdir(), "pi-t3-bridge-ask-"));
const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
const previousT3McpUrl = process.env.T3_MCP_URL;

// These sessions stand in for a Pi thread inside T3, where T3 owns the MCP bridge.
process.env.T3_MCP_URL = "http://127.0.0.1:9/mcp";

process.env.XDG_CONFIG_HOME = path.join(temporary, "config");

// These tests do not exercise the stop judge, so keep it away from the real Jev.
const configFile = path.join(temporary, "config", "pi-t3", "config.json");

await mkdir(path.dirname(configFile), { recursive: true });

await writeFile(configFile, JSON.stringify({ steer: "off" }));

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

  await rm(temporary, { force: true, recursive: true });
});

const stubTools = (delegated) => (pi) => {
  pi.registerTool({
    description: "Stands in for a tool that starts another agent.",
    execute: (_id, params) => {
      delegated.push(params);

      return Promise.resolve({
        content: [{ text: "delegated", type: "text" }],
        details: undefined,
      });
    },
    label: "delegate_stub",
    name: "delegate_stub",
    parameters: Type.Object({ task: Type.String() }),
  });
};

const foreignAsk = (foreign) => ({
  factory: (pi) => {
    pi.registerTool({
      description: "Stands in for the pi-ask extension's ask tool.",
      execute: (_id, params) => {
        foreign.calls.push(params);

        return Promise.resolve({
          content: [{ text: "foreign ask ran", type: "text" }],
          details: undefined,
        });
      },
      label: "ask",
      name: "ask",
      parameters: Type.Object({
        prompts: Type.Array(Type.Object({ title: Type.String() })),
      }),
    });

    pi.on("session_start", () => {
      foreign.source = pi
        .getAllTools()
        .find((tool) => tool.name === "ask").sourceInfo.source;
    });
  },
  name: "pi-ask",
});

// A script entry is the next dialog's answer. UNTIL_TIMEOUT leaves that dialog open until its timeout,
// and UNTIL_STOP leaves it open until the run is stopped.
const UNTIL_TIMEOUT = Symbol("until timeout");
const UNTIL_STOP = Symbol("until stop");

const stopped = async (signal) => {
  await once(signal, "abort");
};

const scriptedUi = (script) => {
  const dialogs = [];
  const notices = [];

  const { promise: waitingForStop, resolve: markWaiting } =
    Promise.withResolvers();

  const answer = (dialog) => {
    dialogs.push(dialog);

    const next = script.shift();

    if (next === UNTIL_STOP) {
      markWaiting();

      return stopped(dialog.opts.signal);
    }

    return Promise.resolve(
      next === UNTIL_TIMEOUT ? delay(dialog.opts.timeout) : next
    );
  };

  const ui = new Proxy(
    {
      input: (title, placeholder, opts) =>
        answer({ kind: "input", opts, placeholder, title }),
      notify: (message, type) => {
        notices.push({ message, type });
      },
      select: (title, options, opts) =>
        answer({ kind: "select", options, opts, title }),
    },
    { get: (target, key) => target[key] ?? (() => {}) }
  );

  return { dialogs, notices, ui, waitingForStop };
};

const call = (name, args) =>
  piAi.fauxAssistantMessage([piAi.fauxToolCall(name, args)], {
    stopReason: "toolUse",
  });

const done = () => piAi.fauxAssistantMessage("Done.");

const startSession = async ({ foreign, mode = "rpc", name, script }) => {
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

  const delegated = [];

  const loader = new piSdk.DefaultResourceLoader({
    additionalExtensionPaths: [
      path.join(extensionDir, "bridge.ts"),
      path.join(extensionDir, "pstack.ts"),
    ],
    agentDir,
    cwd,
    extensionFactories:
      foreign === undefined
        ? [stubTools(delegated)]
        : [stubTools(delegated), foreignAsk(foreign)],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
  });

  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);

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

  const ui = script === undefined ? undefined : scriptedUi(script);

  await session.bindExtensions(
    ui === undefined ? { mode } : { mode, uiContext: ui.ui }
  );

  const turn = async (responses, prompt = "Run the scripted turn.") => {
    const before = session.messages.length;

    faux.setResponses(responses);
    await session.prompt(prompt);

    return session.messages
      .slice(before)
      .filter((message) => message.role === "toolResult");
  };

  return { delegated, session, turn, ui };
};

const text = (result) =>
  result.content.map((part) => part.text ?? "").join("\n");

const databaseQuestion = {
  body: "It stores the cache.",
  choices: [
    { description: "No server to run.", label: "SQLite (recommended)" },
    { label: "Postgres" },
  ],
  title: "Which database?",
};

test("on T3 a choice question is one card with only its labels, and picking one asks nothing more", async () => {
  const { session, turn, ui } = await startSession({
    name: "t3-choice",
    script: ["Postgres"],
  });

  try {
    const [asked] = await turn([
      call("ask", { questions: [databaseQuestion] }),
      done(),
    ]);

    assert.equal(asked.isError, false, text(asked));
    assert.equal(ui.dialogs.length, 1);
    assert.equal(ui.dialogs[0].kind, "select");
    assert.deepEqual(ui.dialogs[0].options, [
      "SQLite (recommended)",
      "Postgres",
    ]);
    assert.match(ui.dialogs[0].title, /^Which database\?/u);
    assert.match(ui.dialogs[0].title, /It stores the cache\./u);
    assert.ok(
      ui.dialogs[0].title.includes(
        "- **SQLite (recommended)**: No server to run."
      )
    );
    assert.deepEqual(asked.details, {
      answers: [{ index: 1, kind: "chose", label: "Postgres", question: 0 }],
    });
    assert.equal(text(asked), "1. Which database?: Postgres");
  } finally {
    session.dispose();
  }
});

test("on T3 text typed on a choice card comes back as the user's own answer", async () => {
  const { session, turn, ui } = await startSession({
    name: "t3-typed",
    script: ["Why not Redis?"],
  });

  try {
    const [asked] = await turn([
      call("ask", { questions: [databaseQuestion] }),
      done(),
    ]);

    assert.equal(asked.isError, false, text(asked));
    assert.equal(ui.dialogs.length, 1);
    assert.deepEqual(asked.details, {
      answers: [{ kind: "typed", question: 0, text: "Why not Redis?" }],
    });
    assert.match(text(asked), /Why not Redis\?/u);
    assert.match(text(asked), /instead of picking/u);
  } finally {
    session.dispose();
  }
});

test("on T3 a free-text question is one input card, and an empty answer asks for a rephrase", async () => {
  const { session, turn, ui } = await startSession({
    name: "t3-free",
    script: ["", "Acme"],
  });

  const question = { body: "It names the package.", title: "Project name?" };

  try {
    const [empty, typed] = await turn([
      call("ask", { questions: [question] }),
      call("ask", { questions: [question] }),
      done(),
    ]);

    assert.equal(ui.dialogs.length, 2);
    assert.equal(ui.dialogs[0].kind, "input");
    assert.equal(ui.dialogs[0].title, "Project name?");
    assert.equal(
      ui.dialogs[0].placeholder,
      "Project name?\n\nIt names the package."
    );

    assert.equal(empty.isError, false, text(empty));
    assert.deepEqual(empty.details, {
      answers: [{ kind: "rephrase", question: 0 }],
    });
    assert.match(text(empty), /Rephrase/u);

    assert.equal(typed.isError, false, text(typed));
    assert.deepEqual(typed.details, {
      answers: [{ kind: "typed", question: 0, text: "Acme" }],
    });
    assert.equal(text(typed), "1. Project name?: Acme");
  } finally {
    session.dispose();
  }
});

test("a dismissed card stops the questions and ends the turn", async () => {
  const { delegated, session, turn, ui } = await startSession({
    name: "dismissed",
    script: ["Postgres", undefined, "never asked"],
  });

  try {
    const results = await turn([
      call("ask", {
        questions: [
          databaseQuestion,
          { title: "Project name?" },
          { title: "License?" },
        ],
      }),
      call("delegate_stub", { task: "keep going after the dismissal" }),
      done(),
    ]);

    assert.equal(results.length, 1);

    const [asked] = results;

    assert.equal(asked.isError, false, text(asked));
    assert.deepEqual(asked.details, {
      answers: [{ index: 1, kind: "chose", label: "Postgres", question: 0 }],
      stop: { kind: "dismissed", question: 1, unasked: 1 },
    });
    assert.equal(ui.dialogs.length, 2);
    assert.match(text(asked), /dismissed question 2/u);
    assert.match(text(asked), /Stop and wait for their next message/u);
    assert.deepEqual(delegated, []);
  } finally {
    session.dispose();
  }
});

test("stopping the run while a card is open keeps the answers given before it", async () => {
  const { session, turn, ui } = await startSession({
    name: "stopped",
    script: ["Postgres", UNTIL_STOP],
  });

  try {
    const running = turn([
      call("ask", {
        questions: [databaseQuestion, { title: "Project name?" }],
      }),
      done(),
    ]);

    await ui.waitingForStop;
    await session.abort();

    const [asked] = await running;

    assert.equal(asked.isError, false, text(asked));
    assert.deepEqual(asked.details, {
      answers: [{ index: 1, kind: "chose", label: "Postgres", question: 0 }],
      stop: { kind: "dismissed", question: 1, unasked: 0 },
    });
    assert.match(text(asked), /1\. Which database\?: Postgres/u);
  } finally {
    session.dispose();
  }
});

test("a card left unanswered until the timeout reports that no answer came in time", async () => {
  const { session, turn, ui } = await startSession({
    name: "timeout",
    script: [UNTIL_TIMEOUT],
  });

  try {
    const [asked] = await turn([
      call("ask", { questions: [databaseQuestion], timeoutSeconds: 10 }),
      done(),
    ]);

    assert.equal(asked.isError, false, text(asked));
    assert.ok(ui.dialogs[0].opts.timeout > 9000, "timeout is about 10 s");
    assert.ok(ui.dialogs[0].opts.timeout <= 10_000, "timeout is about 10 s");
    assert.deepEqual(asked.details, {
      answers: [],
      stop: { kind: "timed_out", question: 0, unasked: 0 },
    });
    assert.match(text(asked), /within 10 s/u);
  } finally {
    session.dispose();
  }
});

test("in the Pi terminal a choice question offers a row to type an own answer", async () => {
  const { session, turn, ui } = await startSession({
    mode: "tui",
    name: "terminal",
    script: ["Type my own answer", "Use Redis"],
  });

  try {
    const [asked] = await turn([
      call("ask", { questions: [databaseQuestion] }),
      done(),
    ]);

    assert.equal(asked.isError, false, text(asked));
    assert.equal(ui.dialogs.length, 2);
    assert.deepEqual(ui.dialogs[0].options, [
      "SQLite (recommended)",
      "Postgres",
      "Type my own answer",
    ]);
    assert.equal(ui.dialogs[1].kind, "input");
    assert.deepEqual(asked.details, {
      answers: [{ kind: "typed", question: 0, text: "Use Redis" }],
    });
    assert.match(text(asked), /Use Redis/u);
  } finally {
    session.dispose();
  }
});

test("pi-ask field names and duplicate labels are refused with a fix", async () => {
  const { session, turn, ui } = await startSession({
    name: "refused",
    script: [],
  });

  try {
    const [piAskNames, duplicates] = await turn([
      call("ask", { prompts: [{ title: "Which database?" }] }),
      call("ask", {
        questions: [
          { choices: [{ label: "Yes" }, { label: " Yes " }], title: "Ship?" },
        ],
      }),
      done(),
    ]);

    assert.equal(piAskNames.isError, true);
    assert.match(text(piAskNames), /"questions"/u);
    assert.equal(duplicates.isError, true);
    assert.match(text(duplicates), /duplicate/u);
    assert.deepEqual(ui.dialogs, []);
  } finally {
    session.dispose();
  }
});

test("while pi-ask provides ask, its tool runs and the user is warned once", async () => {
  const foreign = { calls: [], source: undefined };

  const { session, turn, ui } = await startSession({
    foreign,
    name: "conflict",
    script: [],
  });

  try {
    const [asked] = await turn([
      call("ask", { prompts: [{ title: "Which database?" }] }),
      done(),
    ]);

    await turn([done()], "Another message.");

    assert.equal(asked.isError, false, text(asked));
    assert.equal(text(asked), "foreign ask ran");
    assert.deepEqual(foreign.calls, [
      { prompts: [{ title: "Which database?" }] },
    ]);
    assert.deepEqual(ui.dialogs, []);
    assert.deepEqual(ui.notices, [
      {
        message: `pi-t3's ask is off because ${foreign.source} provides ask. Remove ${foreign.source} from ~/.pi/agent/settings.json packages to switch.`,
        type: "warning",
      },
    ]);
  } finally {
    session.dispose();
  }
});

test("a config value the bridge cannot use is reported once", async () => {
  await writeFile(configFile, JSON.stringify({ mcpUrl: 3, steer: "off" }));

  const { session, turn, ui } = await startSession({
    name: "bad-config",
    script: [],
  });

  try {
    await turn([done()]);
    await turn([done()], "Another message.");

    assert.deepEqual(ui.notices, [
      {
        message: `"mcpUrl" in ${configFile} has an invalid value, so its default applies.`,
        type: "warning",
      },
    ]);
  } finally {
    session.dispose();
    await writeFile(configFile, JSON.stringify({ steer: "off" }));
  }
});

test("ask still runs while a plan waits for approval", async () => {
  const { session, turn } = await startSession({
    name: "plan",
    script: ["Revise", "Smaller steps", "Postgres"],
  });

  try {
    const [revised, blockedWrite, asked] = await turn([
      call("plan", { plan: "1. Write result.txt" }),
      call("write", { content: "too early", path: "result.txt" }),
      call("ask", { questions: [databaseQuestion] }),
      done(),
    ]);

    assert.equal(revised.isError, false, text(revised));
    assert.equal(blockedWrite.isError, true);
    assert.equal(asked.isError, false, text(asked));
    assert.equal(text(asked), "1. Which database?: Postgres");
  } finally {
    session.dispose();
  }
});

test("ask refuses to run without a client that can show the card", async () => {
  const { session, turn } = await startSession({ name: "headless" });

  try {
    const [refused] = await turn([
      call("ask", { questions: [databaseQuestion] }),
      done(),
    ]);

    assert.equal(refused.isError, true);
    assert.match(text(refused), /needs an interactive client/u);
  } finally {
    session.dispose();
  }
});
