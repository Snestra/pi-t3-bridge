import { compile, obj, str } from "@earendil-works/pi-schema";

import { callT3Tool, insideT3 } from "./t3-http.ts";

const isCapabilities = compile(
  obj({ parentThreadId: str() }, { open: true })
).check;

// T3 gives each delegated task's thread an ID with this prefix.
const DELEGATED_THREAD = "thread:delegated-task:";

// The T3 thread a Pi process serves never changes, so the first answer is
// kept. A failed lookup is not kept, and the next call asks T3 again.
let knownThreadId: string | undefined;

// orchestrator_capabilities names the calling thread as its parent, so a
// session learns its own T3 thread ID from it. A parent finds a child's ledger
// lines by that ID.
export const ownThreadId = async (): Promise<string | null> => {
  if (knownThreadId !== undefined) {
    return knownThreadId;
  }

  if (!insideT3()) {
    return null;
  }

  try {
    const result = await callT3Tool("orchestrator_capabilities", {});

    if (!isCapabilities(result)) {
      return null;
    }

    knownThreadId = result.parentThreadId;

    return knownThreadId;
  } catch {
    return null;
  }
};

const isDelegated = (threadId: string): boolean =>
  threadId.startsWith(DELEGATED_THREAD);

// Whether this session runs a task another T3 thread delegated to it.
export const isDelegatedChild = async (): Promise<boolean> => {
  const threadId = await ownThreadId();

  return threadId !== null && isDelegated(threadId);
};
