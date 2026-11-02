import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

import { registerUnlessTaken } from "./claim.ts";

export const TranscriptSchema = Type.Object({
  branchEntryIds: Type.Array(Type.String()),
  sessionFile: Type.Optional(Type.String()),
  sessionId: Type.String(),
});

export type Transcript = Static<typeof TranscriptSchema>;

export const transcriptRef = (ctx: ExtensionContext): Transcript => ({
  branchEntryIds: ctx.sessionManager.getBranch().map((entry) => entry.id),
  sessionFile: ctx.sessionManager.getSessionFile(),
  sessionId: ctx.sessionManager.getSessionId(),
});

const transcriptTool = defineTool({
  annotations: { readOnlyHint: true },
  description:
    "Return the active Pi session file, session ID, and active branch entry IDs for workflows that read the session transcript, such as reflect.",
  execute: (_toolCallId, _params, _signal, _onUpdate, ctx) => {
    const transcript = transcriptRef(ctx);

    return Promise.resolve({
      content: [{ text: JSON.stringify(transcript), type: "text" }],
      details: transcript,
      structuredContent: transcript,
    });
  },
  label: "Transcript",
  name: "transcript",
  outputSchema: TranscriptSchema,
  parameters: Type.Object({}),
});

export const registerTranscript = (pi: ExtensionAPI): void => {
  registerUnlessTaken(pi, transcriptTool);

  pi.registerCommand("t3-transcript", {
    description:
      "Record the active Pi transcript reference for workflows that read it.",
    handler: async (_args, ctx) => {
      const transcript = transcriptRef(ctx);

      pi.appendEntry("pi-t3-transcript", transcript);

      if (ctx.hasUI) {
        ctx.ui.notify(
          transcript.sessionFile
            ? `Session file: ${transcript.sessionFile}`
            : "Pi did not provide a session file for this session.",
          "info"
        );
      }
    },
  });
};
