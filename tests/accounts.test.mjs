import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  brief,
  liveCatalog,
  newWorld,
  onPi,
  startSession,
} from "./harness.mjs";

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

// Each test gets its own state folder, so marks from one don't reach another.
const open = async (name, world) => {
  process.env.XDG_STATE_HOME = path.join(temporary, name, "state");

  // A session model outside every routed family, so its own turns never
  // count as a family recovering.
  const { session, turn } = await startSession({
    modelId: "faux-1",
    name,
    root: temporary,
    world,
  });

  return {
    session,
    turn: (calls) => turn(calls.map((call) => [call])),
  };
};

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

const onHigh = (id) => onPi(id, "high");

test("an ordinary provider error does not exclude the family", async () => {
  const world = newWorld(claudeParent);
  const { session, turn } = await open("provider-error", world);

  try {
    await turn([model("bug-fix"), delegate(onHigh("claude-opus-5-5"))]);
    world.outcomes.set("child-task-1", {
      error: "x",
      status: "failed",
      title: "Provider error",
    });

    const [again, started] = await turn([
      model("bug-fix"),
      delegate(onHigh("claude-opus-5-5")),
    ]);

    assert.deepEqual(again.details.targets, [onHigh("claude-opus-5-5")]);
    assert.equal(started.isError, false, started.text);
  } finally {
    session.dispose();
  }
});

test("a finished delegate is read once, with truncated text so its delivery stays intact", async () => {
  const world = newWorld(claudeParent);
  const { session, turn } = await open("read-once", world);

  try {
    await turn([model("bug-fix"), delegate(onHigh("claude-opus-5-5"))]);
    world.outcomes.set("child-task-1", { status: "completed" });
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
  const world = newWorld(claudeParent);
  const { session, turn } = await open("panel", world);

  try {
    await session.prompt("/t3-exhausted claude");

    const [twoLeft] = await turn([model("interrogate reviewers")]);

    assert.deepEqual(twoLeft.details.targets, [
      onHigh("gpt-6-astra"),
      onHigh("muse-wonder-full-1.0"),
    ]);

    await session.prompt("/t3-exhausted gpt");

    const [oneLeft] = await turn([model("interrogate reviewers")]);

    assert.equal(oneLeft.details.kind, "blocked");
  } finally {
    session.dispose();
  }
});
