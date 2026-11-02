import { Type } from "typebox";
import { Value } from "typebox/value";

import { callT3Tool, insideT3 } from "./t3-http.ts";

const CapabilitiesSchema = Type.Object({ parentThreadId: Type.String() });

// T3 gives each delegated task's thread an ID with this prefix.
const DELEGATED_THREAD = "thread:delegated-task:";

// orchestrator_capabilities names the calling thread as its parent, so a
// session learns its own T3 thread ID from it. A parent finds a child's ledger
// lines by that ID.
export const ownThreadId = async (): Promise<string | null> => {
  if (!insideT3()) {
    return null;
  }

  try {
    const result = await callT3Tool("orchestrator_capabilities", {});

    return Value.Check(CapabilitiesSchema, result)
      ? result.parentThreadId
      : null;
  } catch {
    return null;
  }
};

export const isDelegated = (threadId: string): boolean =>
  threadId.startsWith(DELEGATED_THREAD);

// Whether this session runs a task another T3 thread delegated to it.
export const isDelegatedChild = async (): Promise<boolean> => {
  const threadId = await ownThreadId();

  return threadId !== null && isDelegated(threadId);
};
