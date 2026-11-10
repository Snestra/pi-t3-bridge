import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

// Reading the session branch: the entries an extension saved, and where the
// current prompt starts.

// The data of every entry of `type` on the branch that has the owner's shape,
// oldest first.
export const savedEntries = <T>(
  ctx: ExtensionContext,
  type: string,
  check: (data: unknown) => data is T
): T[] =>
  ctx.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === type && check(entry.data)
        ? [entry.data]
        : []
    );

export const isUser = (entry: SessionEntry): boolean =>
  entry.type === "message" && entry.message.role === "user";

// The entries after the last user message. Notes are custom messages, so
// they never start a new prompt.
export const sincePrompt = (
  branch: readonly SessionEntry[]
): readonly SessionEntry[] => branch.slice(branch.findLastIndex(isUser) + 1);
