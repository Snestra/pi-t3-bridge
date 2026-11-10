import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as piSdk from "@earendil-works/pi-coding-agent";

import { createSession } from "./harness.mjs";

const piRoot = path.dirname(
  path.dirname(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))
  )
);

const { McpOAuthCredentialStore } = await import(
  pathToFileURL(path.join(piRoot, "dist/extensions/mcp/oauth.js"))
);

const { InMemoryAuthStorageBackend } = await import(
  pathToFileURL(path.join(piRoot, "dist/core/auth-storage.js"))
);

const temporary = await mkdtemp(path.join(tmpdir(), "pi-t3-bridge-mcp-"));

const savedEnv = new Map(
  ["T3_MCP_URL", "XDG_CONFIG_HOME"].map((key) => [key, process.env[key]])
);

process.env.XDG_CONFIG_HOME = path.join(temporary, "config");

// Points the bridge at a stand-in T3 the way a user would, in its config.
const useMcpUrl = async (url) => {
  const configDir = path.join(process.env.XDG_CONFIG_HOME, "pi-t3");

  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ mcpUrl: url })
  );
};

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

const readBody = async (request) => {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return chunks.length === 0
    ? null
    : JSON.parse(Buffer.concat(chunks).toString());
};

const reply = (response, status, body, headers = {}) => {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(body === undefined ? "" : JSON.stringify(body));
};

const mcpResult = (message) => {
  switch (message.method) {
    case "initialize": {
      return {
        capabilities: { tools: {} },
        protocolVersion: message.params.protocolVersion,
        serverInfo: { name: "fake-t3", version: "1.0.0" },
      };
    }

    case "tools/list": {
      return {
        tools: [
          "orchestrator_capabilities",
          "t3_thread_launch",
          "delegate_task",
          "preview_open",
          "task_status",
        ].map((name) => ({
          description: `Fake ${name}.`,
          inputSchema: { properties: {}, type: "object" },
          name,
        })),
      };
    }

    default: {
      return {};
    }
  }
};

const startFakeT3 = async ({ signedIn }) => {
  const server = createServer(async (request, response) => {
    const origin = `http://${request.headers.host}`;

    if (request.url === "/.well-known/oauth-protected-resource") {
      reply(response, 200, {
        authorization_servers: [origin],
        resource: `${origin}/mcp`,
      });

      return;
    }

    if (request.url !== "/mcp") {
      reply(response, 404, { error: "not_found" });

      return;
    }

    if (request.method !== "POST") {
      reply(response, 405);

      return;
    }

    if (!signedIn) {
      reply(
        response,
        401,
        { error: "invalid_token" },
        {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        }
      );

      return;
    }

    const message = await readBody(request);

    if (message?.id === undefined) {
      response.writeHead(202);
      response.end();

      return;
    }

    reply(response, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: mcpResult(message),
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    close: async () => {
      server.close();
      await once(server, "close");
    },
    url: `http://127.0.0.1:${server.address().port}/mcp`,
  };
};

const statusRecorder = () => {
  const statuses = [];

  const ui = new Proxy(
    {
      notify: () => {},
      setStatus: (key, value) => statuses.push({ key, value }),
    },
    { get: (target, key) => target[key] ?? (() => {}) }
  );

  return { statuses, ui };
};

const startSession = async ({ name, ui }) => {
  const root = path.join(temporary, name);

  const mcpExtension = piSdk.createMcpExtension({
    credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
    loadConfig: () => ({ errors: [], servers: [] }),
    logPath: path.join(root, "mcp.log"),
    openUrl: () => {},
  });

  const { loader, session } = await createSession({
    extensionFactories: [mcpExtension],
    jev: false,
    name,
    root: temporary,
  });

  assert.deepEqual(loader.getExtensions().errors, []);

  const errors = [];

  await session.bindExtensions({
    mode: "tui",
    onError: (error) => errors.push(error),
    uiContext: ui,
  });

  return { errors, session };
};

const latestT3Status = (statuses) =>
  statuses.findLast((entry) => entry.key === "t3-mcp")?.value;

const waitForStatus = async (statuses, pattern, attemptsLeft = 40) => {
  const status = latestT3Status(statuses);

  if (attemptsLeft === 0 || pattern.test(status ?? "")) {
    return status;
  }

  await delay(250);

  return waitForStatus(statuses, pattern, attemptsLeft - 1);
};

test("terminal Pi connects to T3 and shows it in the status line", async () => {
  delete process.env.T3_MCP_URL;

  const t3 = await startFakeT3({ signedIn: true });

  await useMcpUrl(t3.url);

  const { statuses, ui } = statusRecorder();
  const { errors, session } = await startSession({ name: "connected", ui });

  try {
    const status = await waitForStatus(statuses, /connected/u);

    assert.equal(status, "T3 MCP ● connected, 2 tools");

    const exposure = new Map(
      session.extensionRunner
        .getAllRegisteredTools()
        .map((tool) => [tool.definition.name, tool.definition.exposure])
    );

    assert.notEqual(
      exposure.get("mcp__t3__orchestrator_capabilities"),
      "hidden"
    );
    assert.notEqual(exposure.get("mcp__t3__t3_thread_launch"), "hidden");

    for (const threadOnly of ["delegate_task", "preview_open", "task_status"]) {
      assert.equal(
        exposure.get(`mcp__t3__${threadOnly}`),
        "hidden",
        threadOnly
      );
    }

    assert.deepEqual(errors, []);
  } finally {
    session.dispose();
    await t3.close();
  }
});

test("the status line asks for sign-in when T3 rejects the credential", async () => {
  delete process.env.T3_MCP_URL;

  const t3 = await startFakeT3({ signedIn: false });

  await useMcpUrl(t3.url);

  const { statuses, ui } = statusRecorder();
  const { session } = await startSession({ name: "sign-in", ui });

  try {
    assert.equal(
      await waitForStatus(statuses, /not signed in/u),
      "T3 MCP ○ not signed in, run /mcp login t3"
    );
    assert.equal(statuses[0]?.value, "T3 MCP ○ connecting");
    assert.equal(
      session.extensionRunner.getToolDefinition(
        "mcp__t3__orchestrator_capabilities"
      ),
      undefined
    );
  } finally {
    session.dispose();
    await t3.close();
  }
});

test("the status line shows T3 offline when nothing answers", async () => {
  delete process.env.T3_MCP_URL;

  const t3 = await startFakeT3({ signedIn: true });

  await useMcpUrl(t3.url);
  await t3.close();

  const { statuses, ui } = statusRecorder();
  const { session } = await startSession({ name: "offline", ui });

  try {
    assert.equal(
      await waitForStatus(statuses, /offline/u),
      "T3 MCP ○ offline, start T3 Code"
    );
  } finally {
    session.dispose();
  }
});

test("inside a T3 thread the extension leaves T3's own bridge alone", async () => {
  process.env.T3_MCP_URL = "http://127.0.0.1:9/mcp";

  const { statuses, ui } = statusRecorder();
  const { errors, session } = await startSession({ name: "inside", ui });

  try {
    await delay(300);

    assert.equal(latestT3Status(statuses), undefined);
    assert.equal(
      session.extensionRunner.getToolDefinition(
        "mcp__t3__orchestrator_capabilities"
      ),
      undefined
    );
    assert.deepEqual(errors, []);
  } finally {
    session.dispose();
    delete process.env.T3_MCP_URL;
  }
});
