import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { readLedger } from "../bridge/state.ts";
import { t3Json } from "../bridge/t3-json.ts";

// T3 builds a delegated task's result from the child's streamed text, so the
// block the child's extension writes after its last message never reaches the
// parent through T3. The child also records that block in the ledger with its
// own thread ID, and this adds it to the parent's task_status result.

const STATUS_TOOLS: ReadonlySet<string> = new Set([
  "mcp__t3-code__task_status",
  "mcp__t3__task_status",
]);

const StatusSchema = Type.Object({
  childThreadId: Type.String(),
});

export const registerResults = (pi: ExtensionAPI): void => {
  pi.on("tool_result", (event) => {
    if (!STATUS_TOOLS.has(event.toolName) || event.isError) {
      return;
    }

    const status = t3Json(StatusSchema, event);

    if (status === undefined) {
      return;
    }

    const line = readLedger().findLast(
      (entry) => entry.threadId === status.childThreadId && entry.report
    );

    if (line?.report === undefined) {
      return;
    }

    const content = [
      ...event.content,
      { text: line.report, type: "text" as const },
    ];

    return Value.Check(Type.Undefined(), event.structuredContent)
      ? { content }
      : { content, structuredContent: event.structuredContent };
  });
};
