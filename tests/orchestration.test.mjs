import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import * as piAi from "@earendil-works/pi-ai";

import {
  brief,
  childRepo,
  escapePath,
  liveCatalog,
  newWorld,
  onPi,
  startSession,
} from "./harness.mjs";

const temporary = await mkdtemp(path.join(tmpdir(), "pi-t3-bridge-orch-"));
const sheetDir = path.join(temporary, "config", "pi-t3-bridge");

const savedEnv = new Map(
  [
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "T3_MCP_URL",
    "T3_MCP_BEARER_TOKEN",
  ].map((key) => [key, process.env[key]])
);

const failureFixtures = JSON.parse(
  await readFile(
    path.join(import.meta.dirname, "fixtures/t3-failures.json"),
    "utf-8"
  )
).failures;

// A stand-in for T3's MCP endpoint that records every tools/call. It names
// the calling thread `ownThread`.
const mcpCalls = [];

let ownThread = "child-thread-1";

const mcp = createServer((request, response) => {
  let body = "";

  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    if (request.headers.authorization !== "Bearer test-token") {
      response.writeHead(401).end();

      return;
    }

    const message = body === "" ? {} : JSON.parse(body);

    if (message.id === undefined) {
      response.writeHead(202).end();

      return;
    }

    const reply = (result) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      });
      response.end(JSON.stringify({ id: message.id, jsonrpc: "2.0", result }));
    };

    if (message.method === "initialize") {
      reply({ capabilities: {}, protocolVersion: "2025-06-18" });

      return;
    }

    mcpCalls.push(message.params);

    const replies = {
      delete_scheduled_task: { deleted: true },
      orchestrator_capabilities: { parentThreadId: ownThread },
      schedule_task: {
        nextRunAt: "2026-10-21T00:00:00.000Z",
        scheduledTaskId: "sched-1",
      },
      t3_thread_read: {
        hasMore: false,
        items: [],
        nextPosition: null,
        thread: { status: "completed" },
      },
    };

    const structured = replies[message.params.name] ?? {};

    reply({
      content: [{ text: JSON.stringify(structured), type: "text" }],
      isError: false,
      structuredContent: structured,
    });
  });
});

before(async () => {
  mcp.listen(0, "127.0.0.1");
  await once(mcp, "listening");
  process.env.T3_MCP_URL = `http://127.0.0.1:${mcp.address().port}/mcp`;
  process.env.T3_MCP_BEARER_TOKEN = "test-token";
});

let stateCount = 0;

beforeEach(async () => {
  stateCount += 1;
  process.env.XDG_CONFIG_HOME = path.join(temporary, "config");
  process.env.XDG_STATE_HOME = path.join(temporary, `state-${stateCount}`);
  await mkdir(sheetDir, { recursive: true });
  await writeFile(path.join(sheetDir, "models.md"), "");
  mcpCalls.length = 0;
  ownThread = "child-thread-1";
});

after(async () => {
  mcp.close();

  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  await rm(temporary, { force: true, recursive: true });
});

const parent = (name, world = newWorld()) =>
  startSession({ name, root: temporary, world });

const model = (args) => ["pstack_model", args];

const delegate = (args) => ["mcp__t3-code__delegate_task", args];

const sharedState = async () =>
  JSON.parse(
    await readFile(
      path.join(process.env.XDG_STATE_HOME, "pi-t3", "accounts.json"),
      "utf-8"
    )
  );

// Routing table

test("each job and size routes to the tier, model and reasoning in the table", async () => {
  const { session, turn } = await parent("table");

  try {
    const cases = [
      ["mechanical", "S", "claude-haiku-5-5", "low"],
      ["mechanical", "M", "claude-sonnet-5-5", "medium"],
      ["check", "S", "gpt-6-luna", "low"],
      ["check", "M", "claude-haiku-5-5", "medium"],
      ["research", "S", "muse-spark-1.3", "medium"],
      ["research", "M", "muse-wonder-1.0", "medium"],
      ["implement", "S", "gpt-6.1-sol", "medium"],
      ["implement", "M", "claude-sonnet-5-5", "high"],
      ["hard", "S", "claude-opus-5-5", "high"],
      ["hard", "M", "claude-opus-5-5", "high"],
    ];

    const results = await turn([
      cases.map(([job, size]) =>
        model({ job, role: "feature, refactoring", size })
      ),
    ]);

    for (const [index, [job, size, id, thinking]] of cases.entries()) {
      assert.deepEqual(
        results[index].details.targets,
        [onPi(id, thinking)],
        `${job} ${size}: ${results[index].text}`
      );
    }

    const [review, design] = await turn([
      [
        model({ job: "review", role: "interrogate reviewers", size: "S" }),
        model({ job: "design", role: "architect runners", size: "M" }),
      ],
    ]);

    assert.deepEqual(review.details.targets, [
      onPi("claude-opus-5-5", "high"),
      onPi("muse-wonder-full-1.0", "high"),
      onPi("gpt-6.1-sol", "high"),
    ]);
    assert.deepEqual(design.details.targets, [
      onPi("claude-opus-5-5", "high"),
      onPi("muse-wonder-full-1.0", "high"),
      onPi("gpt-6-astra", "high"),
    ]);
  } finally {
    session.dispose();
  }
});

test("size L is refused with a request to split the job", async () => {
  const { session, turn } = await parent("size-l");

  try {
    const [large] = await turn([
      [model({ job: "implement", role: "feature, refactoring", size: "L" })],
    ]);

    assert.equal(large.isError, true);
    assert.match(large.text, /split/iu);
  } finally {
    session.dispose();
  }
});

test("the families follow the user's tiers", async () => {
  const gptParent = {
    ...structuredClone(liveCatalog),
    inheritedModel: "cliproxyapi/gpt-6.1-sol",
  };

  const { session, turn } = await parent("tiers", newWorld(gptParent));

  try {
    const [general, bounded, groundwork] = await turn([
      [
        model({ complexity: "general", role: "bug-fix" }),
        model({ complexity: "bounded", role: "bug-fix" }),
        model({ complexity: "groundwork", role: "bug-fix" }),
      ],
    ]);

    assert.deepEqual(general.details.targets, [onPi("gpt-6-astra", "high")]);
    assert.deepEqual(bounded.details.targets, [onPi("gpt-6.1-sol", "medium")]);
    assert.deepEqual(groundwork.details.targets, [onPi("gpt-6-luna", "low")]);

    const [panel] = await turn([
      [model({ complexity: "general", role: "architect runners" })],
    ]);

    assert.ok(
      panel.details.targets.some(
        (target) => target.model === "cliproxyapi/muse-wonder-full-1.0"
      ),
      panel.text
    );
  } finally {
    session.dispose();
  }
});

test("an exhausted family falls back at the same size, and M work never falls back to GPT", async () => {
  const { session, turn } = await parent("fallback");

  try {
    await session.prompt("/t3-exhausted gpt");

    const [implement, check] = await turn([
      [
        model({ job: "implement", role: "feature, refactoring", size: "S" }),
        model({ job: "check", role: "swarm workers", size: "S" }),
      ],
    ]);

    assert.deepEqual(implement.details.targets, [
      onPi("claude-sonnet-5-5", "medium"),
    ]);
    assert.deepEqual(check.details.targets, [onPi("claude-haiku-5-5", "low")]);

    await session.prompt("/t3-recovered gpt");
    await session.prompt("/t3-exhausted claude");

    const [medium] = await turn([
      [model({ job: "implement", role: "feature, refactoring", size: "M" })],
    ]);

    assert.deepEqual(medium.details.targets, [onPi("muse-wonder-1.0", "high")]);
  } finally {
    session.dispose();
  }
});

// Brief guard

const resolved = (job, size) => [
  model({ job, role: "feature, refactoring", size }),
];

test("a brief with every section and a table target is dispatched", async () => {
  const world = newWorld();
  const { session, turn } = await parent("brief-ok", world);

  try {
    const [, ok] = await turn([
      resolved("implement", "M"),
      [
        delegate({
          mode: "async",
          target: onPi("claude-sonnet-5-5", "high"),
          task: brief({ minutes: 90, size: "M" }),
        }),
      ],
    ]);

    assert.equal(ok.isError, false, ok.text);
    assert.equal(world.delegated.length, 1);

    const [pathOk] = await turn([
      [
        delegate({
          mode: "async",
          target: onPi("claude-sonnet-5-5", "high"),
          task: brief({
            extra:
              "\n\nRun artifacts/t3-exhausted-live.mjs and read ~/notes/t3-recovered.md.",
            minutes: 90,
            size: "M",
          }),
        }),
      ],
    ]);

    assert.equal(pathOk.isError, false, pathOk.text);
    assert.equal(world.delegated.length, 2);
  } finally {
    session.dispose();
  }
});

// Usage limits

// Each fixture's child runs on a family of its own, so its mark stands alone.
const fixtureFamily = (index) => `fixture${index}`;

const expectedReset = (fixture, since) =>
  fixture.resetAt ??
  new Date(Date.parse(since) + fixture.resetInSeconds * 1000).toISOString();

test("every recorded T3 failure marks its child's family as expected", async () => {
  const world = newWorld();
  const { session, turn } = await parent("failure-fixtures", world);

  try {
    await turn([
      failureFixtures.map((_fixture, index) =>
        delegate({
          target: onPi(`${fixtureFamily(index)}-model`, "medium"),
          task: brief(),
        })
      ),
    ]);

    for (const [index, { failure }] of failureFixtures.entries()) {
      world.outcomes.set(`child-task-${index + 1}`, {
        error: failure.message,
        status: "failed",
        title: failure.title,
      });
    }

    await turn([resolved("implement", "S")]);

    const { families } = await sharedState();

    for (const [index, fixture] of failureFixtures.entries()) {
      const record = families[fixtureFamily(index)];

      assert.equal(
        record?.reason ?? "other",
        fixture.kind,
        fixture.failure.message
      );
      assert.ok(
        record === undefined ||
          Math.abs(
            Date.parse(record.resetAt) -
              Date.parse(expectedReset(fixture, record.since))
          ) < 5000,
        fixture.failure.message
      );
    }
  } finally {
    session.dispose();
  }
});

test("with only the bridge loaded, a probed family opens again once its child finishes", async () => {
  const stateDir = path.join(process.env.XDG_STATE_HOME, "pi-t3");

  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "accounts.json"),
    JSON.stringify({
      families: {
        gpt: {
          reason: "exhausted",
          resetAt: "2026-01-01T00:00:00.000Z",
          since: "2025-12-31T00:00:00.000Z",
          source: "delegate",
          state: "exhausted",
        },
      },
    })
  );

  const world = newWorld();

  world.taskStatus = { childThreadId: "child-task-1", status: "completed" };

  const { session, turn } = await startSession({
    extensions: ["bridge.ts"],
    name: "bridge-settle",
    root: temporary,
    world,
  });

  try {
    await turn([
      [
        delegate({
          target: { model: "cliproxyapi/gpt-6.1-sol" },
          task: "Review the diff.",
        }),
      ],
    ]);

    const probing = await sharedState();

    assert.equal(probing.families.gpt.state, "probing");

    await turn([[["mcp__t3-code__task_status", { taskId: "task-1" }]]]);

    const settled = await sharedState();

    assert.deepEqual(settled.families, {});
  } finally {
    session.dispose();
  }
});

test("state from before the rename moves to pi-t3 once, and a family marked out stays out", async () => {
  const oldDir = path.join(process.env.XDG_STATE_HOME, "t3-pstack");

  const record = {
    families: {
      gpt: {
        reason: "exhausted",
        resetAt: "2099-01-01T00:00:00.000Z",
        since: "2026-10-30T00:00:00.000Z",
        source: "user",
        state: "exhausted",
      },
    },
  };

  await mkdir(oldDir, { recursive: true });
  await writeFile(path.join(oldDir, "accounts.json"), JSON.stringify(record));

  const { session } = await parent("moved-state");

  try {
    assert.equal(existsSync(oldDir), false);
    assert.deepEqual(await sharedState(), record);
  } finally {
    session.dispose();
  }
});

test("a family marked out in one chat is out in every chat", async () => {
  const first = await parent("shared-a");

  await first.session.prompt("/t3-exhausted gpt");
  first.session.dispose();

  const second = await parent("shared-b");

  try {
    const [routed] = await second.turn([
      [model({ job: "implement", role: "feature, refactoring", size: "S" })],
    ]);

    assert.deepEqual(routed.details.targets, [
      onPi("claude-sonnet-5-5", "medium"),
    ]);
  } finally {
    second.session.dispose();
  }
});

test("a delegate's usage-limit text in T3 marks its family out with the reset time", async () => {
  const world = newWorld();
  const { session, turn } = await parent("settle-text", world);

  try {
    await turn([
      resolved("implement", "S"),
      [
        delegate({
          isolation: "worktree",
          target: onPi("gpt-6.1-sol", "medium"),
          task: brief(),
        }),
      ],
    ]);

    world.outcomes.set("child-task-1", {
      error: "You have hit your ChatGPT usage limit. Try again in ~155 min.",
      status: "failed",
    });

    const [rerouted] = await turn([resolved("implement", "S")]);

    assert.doesNotMatch(rerouted.details.targets[0].model, /gpt/u);

    const state = await sharedState();

    const minutes =
      (Date.parse(state.families.gpt.resetAt) - Date.now()) / 60_000;

    assert.ok(minutes > 150 && minutes < 156, String(minutes));
  } finally {
    session.dispose();
  }
});

test("a child that hits a usage limit marks its own family out at once", async () => {
  ownThread = "thread:delegated-task:child-1";

  const child = await startSession({
    modelId: "gpt-6.1-sol",
    name: "child-limit",
    root: temporary,
  });

  try {
    await child.turn(
      [],
      brief({ accept: "false" }),
      piAi.fauxAssistantMessage("", {
        errorMessage:
          "auth_unavailable: no auth available (providers=codex, model=gpt-6.1-sol; last upstream error: websocket: close 1012)",
        stopReason: "error",
      })
    );

    const state = await sharedState();

    assert.equal(state.families.gpt.state, "exhausted");
    assert.equal(state.families.gpt.reason, "unhealthy");
    assert.ok(
      mcpCalls.every((call) => call.name !== "schedule_task"),
      "a child never schedules a resume"
    );
  } finally {
    child.session.dispose();
  }
});

test("a delegated child with no brief still writes what it cost to the ledger", async () => {
  ownThread = "thread:delegated-task:plain-1";

  const child = await startSession({ name: "child-cost", root: temporary });

  try {
    await child.turn([], "Summarize the README.", "It explains the setup.");

    const ledger = await readFile(
      path.join(process.env.XDG_STATE_HOME, "pi-t3", "ledger.jsonl"),
      "utf-8"
    );

    const lines = ledger
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(lines.length, 1);
    assert.equal(lines[0].threadId, "thread:delegated-task:plain-1");
    assert.ok(Number.isFinite(lines[0].cost), JSON.stringify(lines[0]));
    assert.equal(lines[0].report, undefined);
  } finally {
    child.session.dispose();
  }
});

test("when the orchestrator runs out it schedules its own resume and removes it after", async () => {
  const { session, turn } = await parent("resume");

  try {
    await turn(
      [],
      "Keep going.",
      piAi.fauxAssistantMessage("", {
        errorMessage: "You have hit your usage limit. Try again in ~30 min.",
        stopReason: "error",
      })
    );

    const scheduled = mcpCalls.find((call) => call.name === "schedule_task");

    assert.ok(scheduled, JSON.stringify(mcpCalls));
    assert.equal(scheduled.arguments.schedule.type, "fixed_time");
    assert.match(scheduled.arguments.prompt, /pi-t3-resume/u);

    const state = await sharedState();

    assert.equal(state.families.claude.state, "exhausted");

    await turn([], scheduled.arguments.prompt);

    assert.ok(
      mcpCalls.some(
        (call) =>
          call.name === "delete_scheduled_task" &&
          call.arguments.scheduledTaskId === "sched-1"
      ),
      JSON.stringify(mcpCalls)
    );
  } finally {
    session.dispose();
  }
});

test("a dropped stream that Pi's retry recovers leaves the family open", async () => {
  const { faux, session } = await startSession({
    name: "retried",
    retry: { baseDelayMs: 1, enabled: true, maxRetries: 2 },
    root: temporary,
    world: newWorld(),
  });

  try {
    faux.setResponses([
      piAi.fauxAssistantMessage("", {
        errorMessage: "stream disconnected before completion",
        stopReason: "error",
      }),
      piAi.fauxAssistantMessage("Done."),
    ]);
    await session.prompt("Keep going.");

    assert.equal(
      session.messages.findLast((message) => message.role === "assistant")
        ?.stopReason,
      "stop",
      "Pi retried the dropped stream"
    );
    assert.ok(
      !mcpCalls.some((call) => call.name === "schedule_task"),
      JSON.stringify(mcpCalls)
    );

    const state = existsSync(
      path.join(process.env.XDG_STATE_HOME, "pi-t3", "accounts.json")
    )
      ? await sharedState()
      : { families: {} };

    assert.equal(state.families.claude, undefined, JSON.stringify(state));
  } finally {
    session.dispose();
  }
});

// Inside a child

test("a child writes only its listed files, inside a sandbox, and the code writes its report", async () => {
  const repo = await childRepo(temporary, "child-ok");

  const child = await startSession({
    cwd: repo,
    modelId: "gpt-6.1-sol",
    name: "child-ok",
    root: temporary,
  });

  try {
    const results = await child.turn(
      [
        [["write", { content: "done\n", path: "src/a.txt" }]],
        [["write", { content: "x\n", path: "other.txt" }]],
        [["bash", { command: `echo x > ${escapePath}` }]],
        [["bash", { command: "echo y > stray.txt" }]],
        [["bash", { command: "echo x > .git/hooks/pre-commit" }]],
        [["bash", { command: "git config core.hooksPath /tmp/x" }]],
      ],
      brief({
        accept: "grep -q done src/a.txt",
        files: ["src/a.txt"],
        job: "implement",
      }),
      "STATUS: PASS"
    );

    assert.equal(results[0].isError, false, results[0].text);
    assert.equal(results[1].isError, true);
    assert.match(results[1].text, /Files you may write/u);
    assert.equal(existsSync(escapePath), false, "the sandbox let a write out");
    assert.match(results[2].text, /not permitted|read-only file system/iu);
    assert.equal(
      existsSync(path.join(repo, ".git", "hooks", "pre-commit")),
      false,
      "the sandbox let a hook in"
    );
    assert.throws(
      () =>
        execFileSync("git", ["config", "--get", "core.hooksPath"], {
          cwd: repo,
        }),
      { status: 1 },
      "the sandbox let git config change core.hooksPath"
    );

    const report = child.lastAssistantText();

    assert.match(report, /Checked by pi-t3-bridge/u);
    assert.match(report, /SANDBOX: sandbox-exec|SANDBOX: bubblewrap/u);
    assert.match(report, /exit 0 \(before: exit [1-9]\)/u);
    assert.match(report, /stray\.txt/u);
    assert.match(report, /STATUS: ISSUES/u);

    const ledger = await readFile(
      path.join(process.env.XDG_STATE_HOME, "pi-t3", "ledger.jsonl"),
      "utf-8"
    );

    const line = JSON.parse(ledger.trim().split("\n").at(-1));

    assert.equal(line.job, "implement");
    assert.equal(line.exit, 0);
    assert.equal(line.status, "ISSUES");
  } finally {
    child.session.dispose();
    await rm(escapePath, { force: true });
  }
});

// mise and npm directories on PATH are writable inside the sandbox, so a
// child could leave a bwrap of its own there for its next command to run.
test("a bwrap found earlier on PATH does not run a child's commands", async () => {
  const bin = path.join(temporary, "fake-bwrap-bin");

  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, "bwrap"),
    '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
    { mode: 0o755 }
  );

  const previousPath = process.env.PATH;

  process.env.PATH = `${bin}:${previousPath}`;

  const child = await startSession({
    cwd: await childRepo(temporary, "child-fake-bwrap"),
    modelId: "gpt-6.1-sol",
    name: "child-fake-bwrap",
    root: temporary,
  });

  try {
    await child.turn(
      [[["bash", { command: `echo x > ${escapePath}` }]]],
      brief({ accept: "true", files: ["src/a.txt"], job: "check" }),
      "STATUS: PASS"
    );

    assert.equal(existsSync(escapePath), false, "a fake bwrap let a write out");
  } finally {
    child.session.dispose();
    process.env.PATH = previousPath;
    await rm(escapePath, { force: true });
  }
});

test("a child cannot create a missing hooks directory", async () => {
  const repo = await childRepo(temporary, "child-no-hooks");

  await rm(path.join(repo, ".git", "hooks"), { force: true, recursive: true });

  const child = await startSession({
    cwd: repo,
    modelId: "gpt-6.1-sol",
    name: "child-no-hooks",
    root: temporary,
  });

  try {
    await child.turn(
      [
        [
          [
            "bash",
            {
              command: "mkdir -p .git/hooks && echo x > .git/hooks/pre-commit",
            },
          ],
        ],
      ],
      brief({ accept: "true", files: ["src/a.txt"], job: "check" }),
      "STATUS: PASS"
    );

    assert.equal(
      existsSync(path.join(repo, ".git", "hooks", "pre-commit")),
      false,
      "the sandbox let a hook in"
    );
  } finally {
    child.session.dispose();
  }
});

test("a child with childSandbox off runs bash bare and its report says so", async () => {
  const repo = await childRepo(temporary, "child-sandbox-off");

  const configFile = path.join(
    process.env.XDG_CONFIG_HOME,
    "pi-t3",
    "config.json"
  );

  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({ childSandbox: "off" }));

  const child = await startSession({
    cwd: repo,
    modelId: "gpt-6.1-sol",
    name: "child-sandbox-off",
    root: temporary,
  });

  try {
    const [escaped] = await child.turn(
      [[["bash", { command: `echo x > ${escapePath}` }]]],
      brief({ accept: "true", files: ["src/a.txt"], job: "check" }),
      "STATUS: PASS"
    );

    assert.equal(escaped.isError, false, escaped.text);
    assert.equal(existsSync(escapePath), true);
    assert.match(child.lastAssistantText(), /SANDBOX: off/u);
  } finally {
    child.session.dispose();
    await rm(configFile, { force: true });
    await rm(escapePath, { force: true });
  }
});

test("an implementation child whose acceptance already passes is stopped as BLOCKED", async () => {
  const repo = await childRepo(temporary, "child-green");

  const child = await startSession({
    cwd: repo,
    modelId: "gpt-6.1-sol",
    name: "child-green",
    root: temporary,
  });

  try {
    const [blocked] = await child.turn(
      [[["write", { content: "x\n", path: "src/a.txt" }]]],
      brief({ accept: "true", files: ["src/a.txt"] })
    );

    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /already passes/u);

    const review = await startSession({
      cwd: repo,
      modelId: "claude-opus-5-5",
      name: "child-review",
      root: temporary,
    });

    const [read] = await review.turn(
      [[["bash", { command: "ls" }]]],
      brief({ accept: "true", files: ["review.md"], job: "review" })
    );

    assert.equal(read.isError, false, read.text);
    review.session.dispose();
  } finally {
    child.session.dispose();
  }
});

test("a child past its time limit or its disk limit can only report", async () => {
  const repo = await childRepo(temporary, "child-limits");

  const timed = await startSession({
    cwd: repo,
    modelId: "gpt-6-luna",
    name: "child-time",
    root: temporary,
  });

  try {
    const [slept, afterDeadline] = await timed.turn(
      [[["bash", { command: "sleep 10" }]], [["bash", { command: "ls" }]]],
      brief({ accept: "false", job: "check", minutes: 0.05 })
    );

    assert.equal(slept.isError, true, slept.text);
    assert.match(slept.text, /timed out|timeout/iu);
    assert.equal(afterDeadline.isError, true);
    assert.match(afterDeadline.text, /time limit/iu);
  } finally {
    timed.session.dispose();
  }

  const disk = await startSession({
    cwd: repo,
    modelId: "gpt-6-luna",
    name: "child-disk",
    root: temporary,
  });

  try {
    const [, afterFill] = await disk.turn(
      [
        [
          [
            "bash",
            { command: "dd if=/dev/zero of=big.bin bs=1048576 count=3" },
          ],
        ],
        [["bash", { command: "ls" }]],
      ],
      brief({ accept: "false", disk: 1, files: ["big.bin"], job: "check" })
    );

    assert.equal(afterFill.isError, true);
    assert.match(afterFill.text, /disk limit/iu);
  } finally {
    disk.session.dispose();
  }
});

// The disk check runs in the background after each bash call. A slow du must
// not let a later tool run past the time limit, or the report say PASS before
// the check has seen the workdir.
test("a slow disk check still stops a late tool call and an over-limit report", async () => {
  const bin = path.join(temporary, "slow-du-bin");
  const slow = path.join(temporary, "slow-du-on");

  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, "du"),
    `#!/bin/sh\nif [ -e "${slow}" ] && mkdir "${slow}.slept" 2>/dev/null; then sleep 4; fi\nexec /usr/bin/du "$@"\n`,
    { mode: 0o755 }
  );

  const previousPath = process.env.PATH;

  process.env.PATH = `${bin}:${previousPath}`;

  try {
    const timed = await startSession({
      cwd: await childRepo(temporary, "slow-du-time"),
      modelId: "gpt-6-luna",
      name: "slow-du-time",
      root: temporary,
    });

    try {
      const [, late] = await timed.turn(
        [
          [["bash", { command: `touch ${slow}` }]],
          [["bash", { command: "echo ran" }]],
        ],
        brief({ accept: "false", job: "check", minutes: 0.05 })
      );

      assert.equal(late.isError, true, late.text);
      assert.match(late.text, /time limit/iu);
    } finally {
      timed.session.dispose();
      await rm(slow, { force: true });
      await rm(`${slow}.slept`, { force: true, recursive: true });
    }

    const filled = await startSession({
      cwd: await childRepo(temporary, "slow-du-disk"),
      modelId: "gpt-6-luna",
      name: "slow-du-disk",
      root: temporary,
    });

    try {
      await filled.turn(
        [
          [
            [
              "bash",
              {
                command: `touch ${slow} && dd if=/dev/zero of=big.bin bs=1048576 count=3`,
              },
            ],
          ],
        ],
        brief({
          accept: "test -f big.bin",
          disk: 1,
          files: ["big.bin"],
          job: "implement",
        }),
        "STATUS: PASS"
      );

      const report = filled.lastAssistantText();

      assert.match(report, /Checked by pi-t3-bridge/u);
      assert.match(report, /STATUS: BLOCKED/u, report);
    } finally {
      filled.session.dispose();
      await rm(slow, { force: true });
      await rm(`${slow}.slept`, { force: true, recursive: true });
    }
  } finally {
    process.env.PATH = previousPath;
  }
});

test("a child that fills its disk with write and then reports is BLOCKED", async () => {
  const child = await startSession({
    cwd: await childRepo(temporary, "write-fill"),
    modelId: "gpt-6-luna",
    name: "write-fill",
    root: temporary,
  });

  try {
    await child.turn(
      [[["write", { content: "x".repeat(3 * 1024 * 1024), path: "big.bin" }]]],
      brief({
        accept: "test -f big.bin",
        disk: 1,
        files: ["big.bin"],
        job: "implement",
      }),
      "STATUS: PASS"
    );

    const report = child.lastAssistantText();

    assert.match(report, /DISK: \+3\.0 MB/u, report);
    assert.match(report, /STATUS: BLOCKED/u, report);
  } finally {
    child.session.dispose();
  }
});

test("a batch of parallel bash calls queues at most one extra disk scan", async () => {
  const bin = path.join(temporary, "count-du-bin");
  const log = path.join(temporary, "count-du.log");

  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, "du"),
    `#!/bin/sh\necho scan >> "${log}"\nsleep 0.3\nexec /usr/bin/du "$@"\n`,
    { mode: 0o755 }
  );

  const previousPath = process.env.PATH;

  process.env.PATH = `${bin}:${previousPath}`;

  const child = await startSession({
    cwd: await childRepo(temporary, "parallel-du"),
    modelId: "gpt-6-luna",
    name: "parallel-du",
    root: temporary,
  });

  try {
    await child.turn(
      [
        [["bash", { command: "true" }]],
        Array.from({ length: 6 }, () => ["bash", { command: "true" }]),
      ],
      brief({ accept: "false", job: "check" })
    );

    const scanLog = await readFile(log, "utf-8");
    const scans = scanLog.trim().split("\n").length;

    // One baseline, at most two for the first call and two for the batch of
    // six, and one for the report.
    assert.ok(scans <= 6, `${scans} du scans`);
  } finally {
    child.session.dispose();
    process.env.PATH = previousPath;
  }
});

// Pi chats that started before an update keep the old extension in memory but
// read models.json from disk on every call, so its old fields keep their shape.
test("models.json keeps the shape the previous release reads", async () => {
  const policy = JSON.parse(
    await readFile(
      path.join(import.meta.dirname, "..", "pstack", "models.json"),
      "utf-8"
    )
  );

  for (const entry of policy.routing.aboveHigh) {
    assert.ok(entry.level.length > 0);
    assert.ok(Array.isArray(entry.words) && entry.words.length > 0);
  }

  for (const entry of policy.routing.reserved) {
    assert.ok(Array.isArray(entry.words) && entry.words.length > 0);
  }
});

// Live check L2 showed T3 builds a task's result from the child's streamed
// text, so a block appended at message_end never reaches the parent. The
// child records the block with its own T3 thread ID, and the parent's
// task_status result gets it from there.
test("the parent's task_status result carries the block the child's code wrote", async () => {
  const repo = await childRepo(temporary, "child-report");

  const child = await startSession({
    cwd: repo,
    modelId: "gpt-6.1-sol",
    name: "child-report",
    root: temporary,
  });

  try {
    await child.turn(
      [[["write", { content: "done\n", path: "src/a.txt" }]]],
      brief({ accept: "grep -q done src/a.txt", files: ["src/a.txt"] }),
      "STATUS: PASS"
    );
  } finally {
    child.session.dispose();
  }

  const world = newWorld();

  world.taskStatus = {
    childThreadId: "child-thread-1",
    status: "completed",
    summary: "STATUS: PASS",
  };

  const { session, turn } = await parent("parent-report", world);

  try {
    const [status] = await turn([
      [["mcp__t3-code__task_status", { taskId: "task-1" }]],
    ]);

    assert.match(status.text, /Checked by pi-t3-bridge/u);
    assert.match(status.text, /STATUS: PASS/u);
    assert.match(status.text, /exit 0 \(before: exit [1-9]\)/u);
  } finally {
    session.dispose();
  }
});

test("a listed dir/** glob also covers the directory entry itself, such as a .venv symlink", async () => {
  const repo = await childRepo(temporary, "child-venv");

  const child = await startSession({
    cwd: repo,
    modelId: "gpt-6-luna",
    name: "child-venv",
    root: temporary,
  });

  try {
    await child.turn(
      [[["bash", { command: "ln -s /dev/null src/.venv" }]]],
      brief({ accept: "true", files: ["src/.venv/**"], job: "check" }),
      "STATUS: PASS"
    );

    assert.match(child.lastAssistantText(), /outside the list: none/u);
  } finally {
    child.session.dispose();
  }
});
