import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isDelegatedChild } from "./thread.ts";

// T3 registers its MCP tools in a Pi thread with `deferred` exposure, so the
// model sees request_secret only after a tool_search. A model that needs a
// login or a token then writes "send me the token" or waits for the user
// instead. Declaring the tool keeps it one call away, the same as ask.

const REQUEST_SECRET = /(?:^|__)request_secret$/u;

// The tool's name in this session, or undefined when no package offers it,
// as outside T3, where the bridge hides it because T3 refuses it there.
export const requestSecretTool = (pi: ExtensionAPI): string | undefined =>
  pi
    .getAllTools()
    .find(
      (tool) => REQUEST_SECRET.test(tool.name) && tool.exposure !== "hidden"
    )?.name;

export const registerRequestSecret = (pi: ExtensionAPI): void => {
  pi.on("before_agent_start", async (_event, ctx) => {
    // A delegated child has nobody watching its thread to answer the card.
    if (!ctx.hasUI || (await isDelegatedChild())) {
      return;
    }

    const name = requestSecretTool(pi);
    const active = pi.getActiveTools();

    if (name !== undefined && !active.includes(name)) {
      pi.setActiveTools([...active, name]);
    }
  });
};
