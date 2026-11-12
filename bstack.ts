import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// bstack is tstack's full-send cut down to one lead model that commits to the
// default branch. Like tstack.ts, it imports nothing from src/bridge or
// src/pstack, so its skill stays available when either extension is off.
const bstackExtension = (pi: ExtensionAPI): void => {
  const skillsDir = path.join(import.meta.dirname, "bstack", "skills");

  pi.on("resources_discover", () => ({ skillPaths: [skillsDir] }));
};

export default bstackExtension;
