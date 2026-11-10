import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { readConfig } from "./config.ts";
import { insideT3 } from "./t3-http.ts";
import { savedCredential, signInLocally, tokenRejected } from "./t3-sign-in.ts";

const SERVER_NAME = "t3";
const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;
const STATUS_KEY = "t3-mcp";
const DEFAULT_URL = "http://127.0.0.1:3773/mcp";
const PROBE_TIMEOUT_MS = 1500;
const REFRESH_INTERVAL_MS = 3000;

// Pi reports T3's 401 with the first text, and T3's body holds the second.
// Wider words such as "authorize" also appear in ordinary tool errors, and
// each match starts a sign-in that mints a new T3 session.
const AUTH_FAILURE = /requires authentication|invalid_mcp_credential/iu;

// Sign in again a day before the token expires, so a session never starts
// with a token that dies halfway through.
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

// T3 refuses these outside a T3 thread because they act as the calling thread.
// Hiding them keeps the model from choosing a tool that cannot work here.
const THREAD_ONLY_TOOLS = [
  "create_threads",
  "delegate_task",
  "device_*",
  "html_*",
  "preview_*",
  "request_secret",
  "t3_preview_*",
  "t3_worktree_handoff",
  "t3_worktree_status",
  "task_cancel",
  "task_status",
] as const;

const hiddenThreadOnlyTools = Object.fromEntries(
  THREAD_ONLY_TOOLS.map((pattern) => [pattern, "hidden" as const])
);

type T3McpState =
  | { readonly kind: "connecting" }
  | { readonly kind: "offline" }
  | { readonly kind: "sign-in"; readonly failure: string | undefined }
  | { readonly kind: "connected"; readonly tools: number };

interface T3McpObservation {
  readonly authFailed: boolean;
  readonly signInFailure: string | undefined;
  readonly firstCheck: boolean;
  readonly liveTools: number;
  readonly reachable: boolean;
}

const deriveState = (observation: T3McpObservation): T3McpState => {
  if (!observation.reachable) {
    return { kind: "offline" };
  }

  if (observation.liveTools === 0 && observation.firstCheck) {
    return { kind: "connecting" };
  }

  if (observation.authFailed || observation.liveTools === 0) {
    return { failure: observation.signInFailure, kind: "sign-in" };
  }

  return { kind: "connected", tools: observation.liveTools };
};

const statusText = (state: T3McpState): string => {
  switch (state.kind) {
    case "connected": {
      return `T3 MCP ● connected, ${state.tools} ${state.tools === 1 ? "tool" : "tools"}`;
    }

    case "connecting": {
      return "T3 MCP ○ connecting";
    }

    case "offline": {
      return "T3 MCP ○ offline, start T3 Code";
    }

    default: {
      return state.failure === undefined
        ? `T3 MCP ○ not signed in, run /mcp login ${SERVER_NAME}`
        : `T3 MCP ○ sign-in failed: ${state.failure}`;
    }
  }
};

const serverUrl = (): string => readConfig().mcpUrl ?? DEFAULT_URL;

const metadataUrl = (url: string): string =>
  new URL("/.well-known/oauth-protected-resource", url).href;

const probeReachable = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(metadataUrl(url), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    await response.body?.cancel();

    return response.ok;
  } catch {
    return false;
  }
};

const textOf = (content: readonly (TextContent | ImageContent)[]): string =>
  content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

export const registerT3Mcp = (pi: ExtensionAPI): void => {
  if (insideT3()) {
    return;
  }

  const url = serverUrl();

  // An Authorization header makes pi skip its browser OAuth. Without a token,
  // as for a T3 server on another machine, pi falls back to that OAuth.
  let registeredToken: string | undefined;
  let registered = false;

  const register = (token?: string): void => {
    registeredToken = token;
    pi.registerMcpServer(SERVER_NAME, {
      description:
        "T3 Code app tools: launch, steer, and wait on T3 threads (t3_thread_launch, t3_thread_send, t3_thread_wait), schedules, projects, queues, and pull request watching. Outside a T3 thread, list tools need a projectId from t3_project_list.",
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      toolExposure: hiddenThreadOnlyTools,
      url,
    });
    registered = true;
  };

  let authFailed = false;
  let signInFailure: string | undefined;
  let signingIn: Promise<void> | undefined;
  let needsLocalDiscovery = false;

  const signInOnce = async (): Promise<void> => {
    let token: string | undefined;

    try {
      const credential = await signInLocally(url);

      signInFailure = undefined;
      needsLocalDiscovery = credential === undefined;

      if (
        credential === undefined &&
        registered &&
        registeredToken === undefined
      ) {
        return;
      }

      if (credential !== undefined) {
        authFailed = false;
        ({ token } = credential);
      }
    } catch (error) {
      needsLocalDiscovery = false;
      signInFailure = error instanceof Error ? error.message : String(error);
    } finally {
      signingIn = undefined;
    }

    // Pi drops this copy of the extension on /reload or /new, and a dropped
    // copy throws on register. The live copy signs in on its own
    // session_start and reads the saved token, so nothing is lost.
    try {
      register(token);
    } catch {
      // Nothing to do in a dropped copy.
    }
  };

  // Tool calls that fail at the same moment share one sign-in.
  const signIn = (): Promise<void> => {
    signingIn ??= signInOnce();

    return signingIn;
  };

  const savedToken = (): string | undefined => {
    const saved = savedCredential(url);

    return saved !== undefined && saved.expiresAt - Date.now() > RENEW_BEFORE_MS
      ? saved.token
      : undefined;
  };

  // Pi may load this extension more than once and drop the earlier copies, so
  // the sign-in runs inside session_start, where this copy is the live one.
  // Another session may have renewed the token since, so read it each time.
  const connect = async (): Promise<void> => {
    const token = savedToken();

    if (token === undefined || (await tokenRejected(url, token))) {
      await signIn();
    } else if (token !== registeredToken) {
      register(token);
    }
  };

  const initialToken = savedToken();

  if (initialToken !== undefined) {
    register(initialToken);
  }

  let firstCheck = true;
  let wasReachable = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const liveTools = (): number =>
    pi
      .getAllTools()
      .filter(
        (tool) =>
          tool.name.startsWith(TOOL_PREFIX) && tool.exposure !== "hidden"
      ).length;

  const refreshOnce = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      return;
    }

    const reachable = await probeReachable(url);

    const cameOnline = reachable && !wasReachable;

    const reconnectSavedToken =
      cameOnline && registeredToken !== undefined && liveTools() === 0;

    if (reconnectSavedToken) {
      const token = registeredToken;

      await connect();

      if (registeredToken === token) {
        pi.unregisterMcpServer(SERVER_NAME);
        register(token);
      }
    }

    if (
      reachable &&
      (needsLocalDiscovery ||
        (cameOnline && !reconnectSavedToken && signInFailure !== undefined))
    ) {
      await signIn();
    }

    wasReachable = reachable;

    const state = deriveState({
      authFailed,
      firstCheck: firstCheck || cameOnline,
      liveTools: liveTools(),
      reachable,
      signInFailure,
    });

    firstCheck = false;

    ctx.ui.setStatus(STATUS_KEY, statusText(state));
  };

  // A probe can take longer than the timer interval, so a tick that finds a
  // refresh running joins it instead of starting a second reconnect.
  let refreshing: Promise<void> | undefined;

  const runRefresh = async (ctx: ExtensionContext): Promise<void> => {
    try {
      await refreshOnce(ctx);
    } finally {
      refreshing = undefined;
    }
  };

  const refresh = (ctx: ExtensionContext): Promise<void> => {
    refreshing ??= runRefresh(ctx);

    return refreshing;
  };

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    stopTimer();
    firstCheck = true;
    wasReachable = ctx.hasUI && (await probeReachable(url));
    await connect();
    await refresh(ctx);

    if (ctx.mode === "tui") {
      timer = setInterval(async () => {
        try {
          await refresh(ctx);
        } catch {
          stopTimer();
        }
      }, REFRESH_INTERVAL_MS);
      timer.unref();
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!event.toolName.startsWith(TOOL_PREFIX)) {
      return;
    }

    authFailed = event.isError && AUTH_FAILURE.test(textOf(event.content));

    if (authFailed) {
      await signIn();
    }

    await refresh(ctx);
  });

  pi.on("session_shutdown", stopTimer);
};
