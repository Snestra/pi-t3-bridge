import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Theo Browne's tstack skills, vendored under tstack/. This extension only
// serves their skill directory. It imports nothing from src/bridge or
// src/pstack, so the skills stay available when either extension is off.
const tstackExtension = (pi: ExtensionAPI): void => {
  const skillsDir = path.join(import.meta.dirname, "tstack", "skills");

  pi.on("resources_discover", () => ({ skillPaths: [skillsDir] }));
};

export default tstackExtension;
