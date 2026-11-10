import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { compile, num, obj, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { readState, writeState } from "./state.ts";

// Signs pi in to the T3 Code server on this machine with no browser. The T3
// CLI mints a one-time pairing code, and T3's own OAuth endpoints accept that
// code in place of a browser approval. Anyone who can run the CLI already
// owns the server, so the token grants the same full access a browser
// approval would.

const ACCESS = "full-access";

const ACCESS_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "source-control:write",
];

// T3 checks that this is a loopback address and never opens it.
const REDIRECT_URI = "http://127.0.0.1/callback";

const REQUEST_TIMEOUT_MS = 10_000;

const run = promisify(execFile);

const isRuntime = compile(
  obj({ origin: str(), serverVersion: str() }, { open: true })
).check;

const isRegistration = compile(obj({ client_id: str() }, { open: true })).check;

const isPairing = compile(obj({ credential: str() }, { open: true })).check;

const isDecision = compile(obj({ redirectTo: str() }, { open: true })).check;

// The bearer token pi signed in to T3's MCP server with. Only this user may
// read the file, because the token can launch full-access threads.
const CREDENTIAL = "t3-mcp.json";

const T3CredentialSchema = obj(
  { expiresAt: num(), token: str({ minLength: 1 }), url: str() },
  { open: true }
);

const t3Credential = compile(T3CredentialSchema);

type T3Credential = Static<typeof T3CredentialSchema>;

export const savedCredential = (url: string): T3Credential | undefined => {
  const saved = readState(CREDENTIAL, t3Credential);

  return saved?.url === url ? saved : undefined;
};

const isToken = compile(
  obj({ access_token: str(), expires_in: num() }, { open: true })
).check;

const t3Home = (): string =>
  process.env.T3CODE_HOME?.trim() || path.join(homedir(), ".t3");

// Error messages reach the status line, and the text can hold a token or a
// pairing code, so they never quote it. JSON.parse errors quote their input.
const parse = <T>(
  text: string,
  check: (value: unknown) => value is T,
  what: string
): T => {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${what} is not JSON.`);
  }

  if (!check(value)) {
    throw new Error(`${what} has an unexpected shape.`);
  }

  return value;
};

const isRefusal = compile(
  obj(
    {
      error: opt(str()),
      error_description: opt(str()),
      message: opt(str()),
    },
    { open: true }
  )
).check;

// T3 explains a refusal in one of these fields. An error body holds no
// secret, but an HTML page would flood the status line, so take the field.
const refusalReason = (text: string): string => {
  try {
    const body: unknown = JSON.parse(text);

    if (isRefusal(body)) {
      return body.error_description ?? body.message ?? body.error ?? "";
    }
  } catch {
    // Not JSON, so there is no reason to show.
  }

  return "";
};

// The CLI must match the running server, so take the binary of the version
// the server recorded, not whatever `t3` is on PATH. No T3 server on this
// machine, or one at another address, means the CLI can't sign in to `url`.
const localCli = (url: string): string | undefined => {
  const runtimeFile = path.join(t3Home(), "userdata", "server-runtime.json");

  let text: string;

  try {
    text = readFileSync(runtimeFile, "utf-8");
  } catch {
    return undefined;
  }

  const runtime = parse(text, isRuntime, runtimeFile);

  if (runtime.origin !== new URL(url).origin) {
    return undefined;
  }

  return path.join(
    t3Home(),
    "runtime",
    "versions",
    runtime.serverVersion,
    "t3"
  );
};

const request = async <T>(
  url: string,
  init: RequestInit,
  check: (value: unknown) => value is T,
  step: string
): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();

  if (!response.ok) {
    const reason = refusalReason(text);

    throw new Error(
      `T3 refused ${step} (${response.status})${reason === "" ? "." : `: ${reason}`}`
    );
  }

  return parse(text, check, `T3's answer to ${step}`);
};

const postJson = (body: string): RequestInit => ({
  body,
  headers: { "content-type": "application/json" },
});

// T3 can revoke a token before it expires. Only a 401 counts as rejected, so
// a server that is down keeps the token for when it comes back.
export const tokenRejected = async (
  url: string,
  token: string
): Promise<boolean> => {
  try {
    const response = await fetch(url, {
      body: JSON.stringify({ id: 0, jsonrpc: "2.0", method: "ping" }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    await response.body?.cancel();

    return response.status === 401;
  } catch {
    return false;
  }
};

// Saves the new credential. Resolves to undefined when only a browser
// sign-in can reach `url`.
export const signInLocally = async (
  url: string
): Promise<T3Credential | undefined> => {
  const cli = localCli(url);

  if (cli === undefined) {
    return undefined;
  }

  const { origin } = new URL(url);
  const label = `pi on ${hostname()}`;

  const registration = await request(
    `${origin}/oauth/mcp/register`,
    postJson(
      JSON.stringify({ client_name: label, redirect_uris: [REDIRECT_URI] })
    ),
    isRegistration,
    "client registration"
  );

  const { stdout } = await run(
    cli,
    [
      "auth",
      "pairing",
      "create",
      "--ttl",
      "2m",
      "--label",
      label,
      ...ACCESS_SCOPES.flatMap((scope) => ["--scope", scope]),
      "--json",
    ],
    { timeout: REQUEST_TIMEOUT_MS }
  );

  const pairing = parse(stdout, isPairing, "t3 auth pairing create");

  const verifier = randomBytes(32).toString("base64url");

  const authorization = {
    client_id: registration.client_id,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    resource: url,
    response_type: "code",
    state: randomBytes(16).toString("base64url"),
  };

  const decision = await request(
    `${origin}/oauth/mcp/decision`,
    postJson(
      JSON.stringify({
        authorization,
        decision: {
          _tag: "pairing-code",
          access: ACCESS,
          code: pairing.credential,
        },
      })
    ),
    isDecision,
    "the pairing code"
  );

  const code = new URL(decision.redirectTo).searchParams.get("code");

  if (code === null) {
    throw new Error(
      `T3 approved the sign-in but sent no code: ${decision.redirectTo}`
    );
  }

  const issuedAt = Date.now();

  const token = await request(
    `${origin}/oauth/mcp/token`,
    {
      body: new URLSearchParams({
        client_id: registration.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        resource: url,
      }),
    },
    isToken,
    "the token exchange"
  );

  const credential = {
    expiresAt: issuedAt + token.expires_in * 1000,
    token: token.access_token,
    url,
  };

  writeState(CREDENTIAL, credential, 0o600);

  return credential;
};
