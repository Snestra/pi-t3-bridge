import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compile, obj, str } from "@earendil-works/pi-schema";

import { readLedger } from "../bridge/ledger.ts";
import { t3Json } from "../bridge/t3-json.ts";
import { isT3Tool } from "../bridge/t3-tasks.ts";

// T3 builds a delegated task's result from the child's streamed text, so the
// block the child's extension writes after its last message never reaches the
// parent through T3. The child also records that block in the ledger with its
// own thread ID, and this adds it to the parent's task_status result.

const taskStatus = compile(obj({ childThreadId: str() }, { open: true }));

export const registerResults = (pi: ExtensionAPI): void => {
  pi.on("tool_result", (event) => {
    if (!isT3Tool(event.toolName, "task_status") || event.isError) {
      return;
    }

    const status = t3Json(taskStatus, event);

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

    return event.structuredContent === undefined
      ? { content }
      : { content, structuredContent: event.structuredContent };
  });
};
