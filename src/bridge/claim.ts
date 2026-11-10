import type { ExtensionAPI, SourceInfo } from "@earendil-works/pi-coding-agent";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

// Pi runs the first extension that registered a name, and another package,
// such as pi-ask, registers at load after this extension. So the check waits
// for session_start, when every extension has registered its tools. When
// another package holds the name, the bridge's feature stays off and the
// user hears so once. Returns whether the name is taken.
export const claimName = (
  pi: ExtensionAPI,
  name: string,
  feature: string,
  onFree?: () => void
): (() => boolean) => {
  let claimed = false;
  let conflict: SourceInfo | undefined;
  let warned = false;

  pi.on("session_start", () => {
    if (claimed) {
      return;
    }

    conflict = pi.getAllTools().find((tool) => tool.name === name)?.sourceInfo;

    // Once free, the name is this extension's, so later sessions find its
    // own tool under it.
    if (conflict === undefined) {
      claimed = true;
      onFree?.();
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (
      event.messageType !== "user" ||
      conflict === undefined ||
      warned ||
      !ctx.hasUI
    ) {
      return;
    }

    warned = true;

    const source = conflict.source || conflict.path;

    ctx.ui.notify(
      `${feature} is off because ${source} provides ${name}. Remove ${source} from ~/.pi/agent/settings.json packages to switch.`,
      "warning"
    );
  });

  return () => conflict !== undefined;
};

export const registerUnlessTaken = (pi: ExtensionAPI, tool: Tool): void => {
  claimName(pi, tool.name, `pi-t3's ${tool.name}`, () => pi.registerTool(tool));
};
