import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerChild } from "./src/pstack/child.ts";
import { registerModelRouting } from "./src/pstack/models.ts";
import { pstackPaths } from "./src/pstack/resources.ts";
import { registerResults } from "./src/pstack/results.ts";
import {
  moveOldSheet,
  sessionGuidance,
  sessionHookEnabled,
} from "./src/pstack/session.ts";

// pstack's skills on top of the bridge in bridge.ts: their catalog and session
// guidance, model routing, and the rules for a delegated brief.
const pstackExtension = (pi: ExtensionAPI): void => {
  moveOldSheet();
  const paths = pstackPaths();

  pi.on("resources_discover", () => ({ skillPaths: [paths.skillsDir] }));

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user" || !sessionHookEnabled()) {
      return;
    }

    event.systemPromptOptions.sections.pi_t3_bridge = sessionGuidance(paths);
  });

  registerModelRouting(pi);
  registerChild(pi);
  registerResults(pi);
};

export default pstackExtension;
