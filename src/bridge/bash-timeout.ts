import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  compile,
  num,
  obj,
  opt,
  str,
  unknown,
} from "@earendil-works/pi-schema";

import { readConfig } from "./config.ts";

const isBashInput = compile(
  obj({ command: str(), timeout: opt(unknown()) }, { open: true })
).check;

const isNumber = compile(num()).check;

const TIMED_OUT = /Command timed out after \d+ seconds/u;

export const registerBashTimeout = (pi: ExtensionAPI): void => {
  pi.on("tool_call", (event) => {
    const { input } = event;

    if (event.toolName !== "bash" || !isBashInput(input)) {
      return;
    }

    const cap = readConfig().bashTimeoutSeconds;

    input.timeout =
      isNumber(input.timeout) && input.timeout > 0
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
          text: `Shell commands stop after at most ${readConfig().bashTimeoutSeconds} seconds. Do not retry with a longer timeout. For a job that needs longer, start it in the background with its output in a log file (nohup <cmd> > "$TMPDIR/job.log" 2>&1 &), then check the log with short commands.`,
          type: "text",
        },
      ],
    };
  });
};
