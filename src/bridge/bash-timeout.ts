import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { readConfig } from "./config.ts";

// Every shell command in every session, parent or child, gets a timeout of at
// most this many seconds. A command with no timeout gets exactly this one, so
// a hung test suite or a long `sleep` poll stalls a chat for minutes, not for
// a quarter of an hour or forever. bashTimeoutSeconds in the config overrides it.
const DEFAULT_SECONDS = 300;

export const bashTimeoutSeconds = (): number =>
  readConfig().bashTimeoutSeconds ?? DEFAULT_SECONDS;

const BashInputSchema = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Unknown()),
});

const TIMED_OUT = /Command timed out after \d+ seconds/u;

export const registerBashTimeout = (pi: ExtensionAPI): void => {
  pi.on("tool_call", (event) => {
    const { input } = event;

    if (event.toolName !== "bash" || !Value.Check(BashInputSchema, input)) {
      return;
    }

    const cap = bashTimeoutSeconds();

    input.timeout =
      Value.Check(Type.Number(), input.timeout) && input.timeout > 0
        ? Math.min(input.timeout, cap)
        : cap;
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") {
      return;
    }

    const timedOut = event.content.some(
      (part) => part.type === "text" && TIMED_OUT.test(part.text)
    );

    if (!timedOut) {
      return;
    }

    return {
      content: [
        ...event.content,
        {
          text: `Shell commands stop after at most ${bashTimeoutSeconds()} seconds. Do not retry with a longer timeout. For a job that needs longer, start it in the background with its output in a log file (nohup <cmd> > "$TMPDIR/job.log" 2>&1 &), then check the log with short commands.`,
          type: "text",
        },
      ],
    };
  });
};
