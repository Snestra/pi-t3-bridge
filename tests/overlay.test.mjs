import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { applyOverlay, materializePstack } from "../src/pstack/overlay.ts";

const extensionDir = path.dirname(import.meta.dirname);
const upstreamRoot = path.join(extensionDir, "pstack");

test("the served pstack is upstream with only the overlay applied", async () => {
  const cache = await mkdtemp(path.join(tmpdir(), "pi-t3-overlay-"));

  try {
    const effective = materializePstack(
      upstreamRoot,
      path.join(extensionDir, "overlay"),
      cache
    );

    assert.equal(
      materializePstack(
        upstreamRoot,
        path.join(extensionDir, "overlay"),
        cache
      ),
      effective,
      "a second load reuses the hashed copy"
    );

    const served = await readFile(
      path.join(effective, "skills", "poteto-mode", "SKILL.md"),
      "utf-8"
    );

    const upstream = await readFile(
      path.join(upstreamRoot, "skills", "poteto-mode", "SKILL.md"),
      "utf-8"
    );

    assert.match(served, /~\/\.config\/pi-t3-bridge\/models\.md/u);
    assert.doesNotMatch(served, /extension blocks a `delegate_task`/u);
    assert.doesNotMatch(served, /On Codex, read this file whole/u);
    assert.match(
      upstream,
      /~\/\.config\/t3-pstack\/models\.md/u,
      "pstack/ on disk stays upstream"
    );
    assert.notEqual(served, upstream);

    const hook = await readFile(
      path.join(effective, "hooks", "session-start-context.md"),
      "utf-8"
    );

    assert.match(hook, /You have pi-t3-bridge,/u);
    assert.doesNotMatch(hook, /t3-pstack:poteto-mode|t3-pstack-models/u);

    assert.ok(
      await readFile(
        path.join(effective, "node_modules", "commander", "package.json"),
        "utf-8"
      ).then(
        () => true,
        () => false
      ),
      "scripts in the copy resolve the extension's node_modules"
    );

    const brief = await readFile(
      path.join(effective, "skills", "poteto-mode", "brief.md"),
      "utf-8"
    );

    assert.match(brief, /~\/\.local\/state\/pi-t3\/ledger\.jsonl/u);
    assert.doesNotMatch(brief, /extension refuses a brief/u);
  } finally {
    await rm(cache, { force: true, recursive: true });
  }
});

test("a hook-only upstream change builds a fresh copy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-t3-overlay-hook-"));
  const upstream = path.join(root, "ext", "pstack");
  const overlayDirPath = path.join(root, "overlay");
  const cache = path.join(root, "cache");

  try {
    await mkdir(path.join(upstream, "skills", "x"), { recursive: true });
    await mkdir(path.join(upstream, "hooks"), { recursive: true });
    await mkdir(overlayDirPath, { recursive: true });
    await writeFile(path.join(upstream, "skills", "x", "SKILL.md"), "# x\n");
    await writeFile(
      path.join(upstream, "hooks", "session-start-context.md"),
      "hook one\n"
    );
    await writeFile(
      path.join(overlayDirPath, "overlay.json"),
      JSON.stringify({ files: {}, global: [], shared: [], version: 1 })
    );

    const first = materializePstack(upstream, overlayDirPath, cache);

    await writeFile(
      path.join(upstream, "hooks", "session-start-context.md"),
      "hook two\n"
    );

    const second = materializePstack(upstream, overlayDirPath, cache);

    assert.notEqual(second, first);
    assert.match(
      await readFile(
        path.join(second, "hooks", "session-start-context.md"),
        "utf-8"
      ),
      /hook two/u
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("two installs with the same upstream text keep their own dependencies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-t3-overlay-installs-"));
  const overlayDirPath = path.join(root, "overlay");
  const cache = path.join(root, "cache");

  const install = async (name, marker) => {
    const ext = path.join(root, name);
    const upstream = path.join(ext, "pstack");

    await mkdir(path.join(upstream, "skills", "x"), { recursive: true });
    await mkdir(path.join(ext, "node_modules", "commander"), {
      recursive: true,
    });
    await writeFile(path.join(upstream, "skills", "x", "SKILL.md"), "# x\n");
    await writeFile(
      path.join(ext, "node_modules", "commander", "package.json"),
      JSON.stringify({ name: marker })
    );

    return upstream;
  };

  try {
    await mkdir(overlayDirPath, { recursive: true });
    await writeFile(
      path.join(overlayDirPath, "overlay.json"),
      JSON.stringify({ files: {}, global: [], shared: [], version: 1 })
    );

    const first = materializePstack(
      await install("one", "one"),
      overlayDirPath,
      cache
    );

    const second = materializePstack(
      await install("two", "two"),
      overlayDirPath,
      cache
    );

    assert.notEqual(second, first);
    assert.match(
      await readFile(
        path.join(second, "node_modules", "commander", "package.json"),
        "utf-8"
      ),
      /"two"/u
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a patch whose anchor upstream reworded fails with its file", () => {
  assert.throws(
    () =>
      applyOverlay(
        {
          files: { "skills/x/SKILL.md": [{ find: "gone", replace: "" }] },
          global: [],
          shared: [],
          version: 1,
        },
        "skills/x/SKILL.md",
        "present"
      ),
    /overlay patch for skills\/x\/SKILL\.md no longer matches/u
  );
});
