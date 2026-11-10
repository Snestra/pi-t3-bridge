import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import * as piAi from "@earendil-works/pi-ai";
import { num, obj, str } from "@earendil-works/pi-schema";

import { createSession } from "./harness.mjs";

const temporary = await mkdtemp(path.join(tmpdir(), "pi-t3-bridge-tasks-"));
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

const delegatedCalls = [];

const stubTools = (pi) => {
  pi.registerTool({
    description: "Stands in for a tool that starts another agent.",
    execute: (_id, params) => {
      delegatedCalls.push(params);

      return Promise.resolve({
        content: [{ text: "delegated", type: "text" }],
        details: undefined,
      });
    },
    label: "delegate_stub",
    name: "delegate_stub",
    parameters: obj({ task: str() }, { open: true }),
  });

  pi.registerTool({
    annotations: { readOnlyHint: true },
    description: "Stands in for a read-only lookup tool.",
    execute: () =>
      Promise.resolve({
        content: [{ text: "looked up", type: "text" }],
        details: undefined,
      }),
    label: "lookup_stub",
    name: "lookup_stub",
    parameters: obj({}, { open: true }),
  });
};

const fakeHtmlRender = (calls) => (pi) => {
  pi.registerTool({
    description: "Test double for the T3 html_render MCP tool.",
    execute: (_id, params) => {
      calls.push(params);

      return Promise.resolve({
        content: [{ text: "rendered", type: "text" }],
        details: undefined,
      });
    },
    exposure: "deferred",
    label: "html_render",
    name: "mcp__t3-code__html_render",
    parameters: obj(
      {
        height: num(),
        html: str(),
        title: str(),
      },
      { open: true }
    ),
  });
};

const scriptedUi = (answers) =>
  new Proxy(
    {
      input: () => Promise.resolve(answers.shift()),
      select: () => Promise.resolve(answers.shift()),
    },
    { get: (target, key) => target[key] ?? (() => {}) }
  );

const call = (name, args) =>
  piAi.fauxAssistantMessage([piAi.fauxToolCall(name, args)], {
    stopReason: "toolUse",
  });

const done = () => piAi.fauxAssistantMessage("Done.");

const startSession = async ({ answers, name, renderCalls }) => {
  const { cwd, faux, loader, session } = await createSession({
    extensionFactories:
      renderCalls === undefined
        ? [stubTools]
        : [stubTools, fakeHtmlRender(renderCalls)],
    jev: false,
    name,
    root: temporary,
  });

  assert.deepEqual(loader.getExtensions().errors, []);

  const bindings = { mode: "rpc" };

  if (answers !== undefined) {
    bindings.uiContext = scriptedUi(answers);
  }

  await session.bindExtensions(bindings);

  const turn = async (responses, prompt = "Run the scripted turn.") => {
    const before = session.messages.length;

    faux.setResponses(responses);
    await session.prompt(prompt);

    return session.messages
      .slice(before)
      .filter((message) => message.role === "toolResult");
  };

  return { cwd, session, turn };
};

const text = (result) =>
  result.content.map((part) => part.text ?? "").join("\n");

test("tasks renders the full task list as an inline T3 card", async () => {
  const renderCalls = [];
  const { session, turn } = await startSession({ name: "tasks", renderCalls });

  try {
    const [published, rejected] = await turn([
      call("tasks", {
        steps: [
          { id: "shape", status: "completed", text: "Name the data shape" },
          { id: "build", status: "in_progress", text: "Build <b>the</b> tool" },
          { id: "verify", status: "pending", text: "Verify it" },
        ],
      }),
      call("tasks", {
        steps: [
          { id: "a", status: "in_progress", text: "First" },
          { id: "b", status: "in_progress", text: "Second" },
        ],
      }),
      done(),
    ]);

    assert.equal(published.isError, false, text(published));
    assert.equal(published.details.rendered, true);
    assert.match(text(published), /\[doing\] Build <b>the<\/b> tool/u);
    assert.equal(renderCalls.length, 1);
    assert.equal(renderCalls[0].title, "Tasks");
    assert.match(renderCalls[0].html, /lang="en"/u);
    assert.match(renderCalls[0].html, /<title>Tasks<\/title>/u);
    assert.match(renderCalls[0].html, /<main class="card">/u);
    assert.match(renderCalls[0].html, /<h1>Tasks<\/h1>/u);
    assert.match(renderCalls[0].html, /aria-hidden="true"/u);
    assert.match(renderCalls[0].html, /In progress:/u);
    assert.doesNotMatch(renderCalls[0].html, /class="bar"/u);
    assert.match(renderCalls[0].html, /1 of 3 complete/u);
    assert.match(renderCalls[0].html, /Build &lt;b&gt;the&lt;\/b&gt; tool/u);
    assert.doesNotMatch(renderCalls[0].html, /<b>the<\/b>/u);

    assert.equal(rejected.isError, true);
    assert.equal(renderCalls.length, 1);

    const longStep =
      "/Users/example/project/src/components/a-very-long-unbroken-file-path-that-keeps-going/tasks.ts";

    const explanation =
      "The list changed because the first step finished and the remaining work was split.";

    const [shortPublished, longPublished] = await turn([
      call("tasks", {
        explanation,
        steps: [{ id: "long", status: "in_progress", text: "src/tasks.ts" }],
      }),
      call("tasks", {
        explanation,
        steps: [{ id: "long", status: "in_progress", text: longStep }],
      }),
      done(),
    ]);

    assert.equal(shortPublished.isError, false, text(shortPublished));
    assert.equal(longPublished.isError, false, text(longPublished));
    assert.equal(renderCalls.length, 3);
    assert.ok(
      renderCalls[2].height > renderCalls[1].height,
      "a step that wraps gets a taller card"
    );
  } finally {
    session.dispose();
  }
});

test("tasks still reports the list where T3 cannot render cards", async () => {
  const { session, turn } = await startSession({ name: "plain" });

  try {
    const [published] = await turn([
      call("tasks", {
        steps: [{ id: "one", status: "pending", text: "Only step" }],
      }),
      done(),
    ]);

    assert.equal(published.isError, false, text(published));
    assert.equal(published.details.rendered, false);
    assert.match(text(published), /0 of 1 complete/u);
  } finally {
    session.dispose();
  }
});

test("plan blocks file changes until the user approves", async () => {
  const renderCalls = [];
  const answers = ["Revise", "Split it into two steps"];

  const { cwd, session, turn } = await startSession({
    answers,
    name: "plan",
    renderCalls,
  });

  const target = path.join(cwd, "result.txt");

  await writeFile(path.join(cwd, "notes.txt"), "context");

  try {
    const [
      revised,
      blockedWrite,
      blockedShell,
      blockedDelegate,
      allowedLookup,
      allowedTasks,
      allowedRead,
    ] = await turn([
      call("plan", {
        plan: "1. Write result.txt",
        title: "Write the result",
      }),
      call("write", { content: "too early", path: "result.txt" }),
      call("bash", { command: "printf early > result.txt" }),
      call("delegate_stub", { task: "write result.txt for me" }),
      call("lookup_stub", {}),
      call("tasks", {
        steps: [{ id: "write", status: "pending", text: "Write result.txt" }],
      }),
      call("read", { path: "notes.txt" }),
      done(),
    ]);

    assert.equal(revised.isError, false, text(revised));
    assert.match(text(revised), /Split it into two steps/u);
    assert.equal(renderCalls[0].title, "Write the result");
    assert.doesNotMatch(renderCalls[0].html, /Waiting for approval/u);
    assert.equal(blockedWrite.isError, true);
    assert.equal(blockedShell.isError, true);
    assert.equal(blockedDelegate.isError, true);
    assert.deepEqual(delegatedCalls, []);
    assert.equal(allowedLookup.isError, false, text(allowedLookup));
    assert.equal(allowedTasks.isError, false, text(allowedTasks));
    assert.equal(allowedRead.isError, false, text(allowedRead));
    assert.match(text(allowedRead), /context/u);
    assert.equal(existsSync(target), false);

    await session.reload();
    answers.push("Approve", "Cancel");

    const [
      blockedAfterReload,
      approved,
      allowedWrite,
      cancelled,
      blockedAfterCancel,
    ] = await turn([
      call("write", { content: "still too early", path: "result.txt" }),
      call("plan", {
        plan: "1. Write result.txt\n2. Check it",
        title: "Write the result",
      }),
      call("write", { content: "approved", path: "result.txt" }),
      piAi.fauxAssistantMessage(
        [
          piAi.fauxToolCall("plan", { plan: "1. Delete result.txt" }),
          piAi.fauxToolCall("write", {
            content: "kept going",
            path: "result.txt",
          }),
        ],
        { stopReason: "toolUse" }
      ),
      done(),
    ]);

    assert.equal(blockedAfterReload.isError, true);
    assert.equal(approved.isError, false, text(approved));
    assert.match(text(approved), /approved/u);
    assert.equal(allowedWrite.isError, false, text(allowedWrite));
    assert.equal(await readFile(target, "utf-8"), "approved");
    assert.equal(cancelled.isError, false, text(cancelled));
    assert.match(text(cancelled), /cancelled/u);
    assert.equal(blockedAfterCancel.isError, true);
    assert.equal(await readFile(target, "utf-8"), "approved");

    const [afterCancel] = await turn([
      call("write", { content: "user took over", path: "result.txt" }),
      done(),
    ]);

    assert.equal(afterCancel.isError, false, text(afterCancel));
    assert.equal(await readFile(target, "utf-8"), "user took over");
  } finally {
    session.dispose();
  }
});

test("plan sizes its card for wrapped plan text", async () => {
  const renderCalls = [];
  const answers = ["Approve", "Approve"];

  const { session, turn } = await startSession({
    answers,
    name: "plan-height",
    renderCalls,
  });

  try {
    const longLine =
      "1. Update the task card and the plan card so that long file paths wrap inside the card and the frame is tall enough to show every wrapped line.";

    const [short, approved] = await turn([
      call("plan", { plan: "1. Wrap.", title: "Wrap the cards" }),
      call("plan", { plan: longLine, title: "Wrap the cards" }),
      done(),
    ]);

    assert.equal(short.isError, false, text(short));
    assert.equal(approved.isError, false, text(approved));
    assert.equal(renderCalls.length, 2);
    assert.doesNotMatch(renderCalls[1].html, /Waiting for approval/u);
    assert.ok(
      renderCalls[1].height > renderCalls[0].height,
      "a plan line that wraps gets a taller card"
    );
  } finally {
    session.dispose();
  }
});

test("plan shows the plan as markdown and draws its Mermaid diagrams", async () => {
  const renderCalls = [];
  const answers = ["Approve"];

  const { session, turn } = await startSession({
    answers,
    name: "plan-markdown",
    renderCalls,
  });

  const plan = [
    "Goal: you or an agent changes **homelab's tools** in one repo.",
    "",
    "```mermaid",
    "sequenceDiagram",
    "    participant Agent as agent (T3 project ~/.t3/projects/homelab)",
    "    participant GitHub as bjoernaagaard/homelab (main)",
    "    Agent->>GitHub: git push",
    "```",
    "",
    "1. Commit the pending `config.toml` change.",
    "2. Push <script>alert(1)</script> to `main`.",
    "3. Read [the docs](javascript:alert(2)) and [Pele](https://pele.run).",
    "4. Check text <pre><img/src=x onerror=alert(3)></pre> too.",
    "5. Return a List&lt;T&gt;.",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  A->>",
    "```",
  ].join("\n");

  try {
    const [approved] = await turn([
      call("plan", { plan, title: "Homelab tools" }),
      done(),
    ]);

    assert.equal(approved.isError, false, text(approved));
    assert.equal(renderCalls.length, 1);

    const [{ height, html }] = renderCalls;

    assert.match(html, /<svg[^>]*class="pele pele-sequence"/u);
    assert.equal(html.match(/<svg/gu).length, 1);
    assert.doesNotMatch(html, /```/u);
    assert.match(html, /<strong>homelab(?:&#39;|')s tools<\/strong>/u);
    assert.match(html, /<ol>/u);
    assert.match(html, /<code>config\.toml<\/code>/u);
    assert.doesNotMatch(html, /<script>alert/u);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
    assert.doesNotMatch(html, /href="javascript/u);
    assert.doesNotMatch(html, /<img/u);
    assert.match(html, /List&lt;T&gt;/u);
    assert.match(html, /the docs/u);
    assert.match(html, /<a href="https:\/\/pele\.run">Pele<\/a>/u);
    assert.match(html, /could not be drawn/u);
    assert.match(html, /A-&gt;&gt;/u);
    assert.match(html, /\.pele\{[^}]*--pele-fg:var\(--foreground\)/u);
    assert.ok(height > 300, `height ${height}`);
    assert.ok(height < 900, `height ${height}`);
  } finally {
    session.dispose();
  }
});

test("plan refuses to run without a client that can ask the user", async () => {
  const { cwd, session, turn } = await startSession({ name: "headless" });

  try {
    const [refused, write] = await turn([
      call("plan", { plan: "1. Anything" }),
      call("write", { content: "free", path: "free.txt" }),
      done(),
    ]);

    assert.equal(refused.isError, true);
    assert.equal(write.isError, false, text(write));
    assert.equal(existsSync(path.join(cwd, "free.txt")), true);
  } finally {
    session.dispose();
  }
});
