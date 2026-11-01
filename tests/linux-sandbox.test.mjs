import assert from "node:assert/strict";
import path from "node:path";
import { before, test } from "node:test";

import { GenericContainer, getContainerRuntimeClient } from "testcontainers";

// The first build pulls the base image and runs npm ci.
const BUILD_TIMEOUT_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 5 * 60_000;

const repoRoot = path.dirname(import.meta.dirname);

let image;

before(
  async () => {
    try {
      await getContainerRuntimeClient();
    } catch (error) {
      throw new Error(
        "Docker is unreachable, and this test needs it to run a Linux container. Start Docker (or OrbStack), or point DOCKER_HOST at a running daemon.",
        { cause: error }
      );
    }

    image = await GenericContainer.fromDockerfile(
      repoRoot,
      "tests/linux/Dockerfile"
    ).build("pi-t3-bridge-linux-test", { deleteOnExit: false });
  },
  { timeout: BUILD_TIMEOUT_MS }
);

test(
  "on Linux with no usable sandbox, a child's bash is blocked",
  { timeout: RUN_TIMEOUT_MS },
  async () => {
    // Docker's default seccomp: no security options.
    const container = await image
      .withUser("node")
      .withCommand(["sleep", "infinity"])
      .start();

    try {
      const { exitCode, output } = await container.exec([
        "node",
        "--test",
        "tests/linux/no-sandbox.mjs",
      ]);

      assert.equal(exitCode, 0, output);
    } finally {
      await container.stop();
    }
  }
);

test(
  "on Linux with bubblewrap, every child rule holds",
  { timeout: RUN_TIMEOUT_MS },
  async () => {
    // bwrap needs a user namespace, which Docker's default seccomp and
    // AppArmor profiles refuse.
    const container = await image
      .withUser("node")
      .withSecurityOpt("seccomp=unconfined", "apparmor=unconfined")
      .withCommand(["sleep", "infinity"])
      .start();

    try {
      const { exitCode, output } = await container.exec([
        "node",
        "--test",
        "tests/orchestration.test.mjs",
      ]);

      assert.equal(exitCode, 0, output);
    } finally {
      await container.stop();
    }
  }
);
