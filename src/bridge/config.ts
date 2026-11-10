import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  compile,
  map,
  num,
  oneOf,
  str,
  unknown,
} from "@earendil-works/pi-schema";
import type { Static, Validator } from "@earendil-works/pi-schema";

// The bridge's settings, one JSON file per machine. Each key is checked on its
// own, so one bad value falls back to its default and leaves the rest alone.
// The file is read on every call, so an edit applies on the next prompt.
// mcpUrl is the exception: the MCP server registers it once per session.

const SteerSchema = oneOf(["on", "off", "shadow"]);

const ChildSandboxSchema = oneOf(["on", "off"]);

const configFile = compile(map(unknown()));

const fields = {
  bashTimeoutSeconds: compile(num({ exclusiveMinimum: 0 })),
  childSandbox: compile(ChildSandboxSchema),
  classifierModel: compile(str({ pattern: "^[^/\\s]+/.+$" })),
  mcpUrl: compile(str({ minLength: 1 })),
  steer: compile(SteerSchema),
};

interface Config {
  readonly bashTimeoutSeconds: number | undefined;
  readonly childSandbox: Static<typeof ChildSandboxSchema> | undefined;
  readonly classifierModel: string | undefined;
  readonly mcpUrl: string | undefined;
  readonly steer: Static<typeof SteerSchema> | undefined;
}

interface Loaded {
  readonly config: Config;
  readonly problems: readonly string[];
}

const EMPTY: Config = {
  bashTimeoutSeconds: undefined,
  childSandbox: undefined,
  classifierModel: undefined,
  mcpUrl: undefined,
  steer: undefined,
};

const configPath = (): string =>
  path.join(
    process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config"),
    "pi-t3",
    "config.json"
  );

const parse = (text: string): Loaded => {
  const file = configPath();
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: EMPTY, problems: [`${file} is not valid JSON.`] };
  }

  if (!configFile.check(parsed)) {
    return { config: EMPTY, problems: [`${file} is not a JSON object.`] };
  }

  const problems: string[] = [];

  const field = <T>(key: string, validator: Validator<T>): T | undefined => {
    const value = parsed[key];

    if (value === undefined || validator.check(value)) {
      return value;
    }

    problems.push(
      `"${key}" in ${file} has an invalid value, so its default applies.`
    );

    return undefined;
  };

  return {
    config: {
      bashTimeoutSeconds: field(
        "bashTimeoutSeconds",
        fields.bashTimeoutSeconds
      ),
      childSandbox: field("childSandbox", fields.childSandbox),
      classifierModel: field("classifierModel", fields.classifierModel),
      mcpUrl: field("mcpUrl", fields.mcpUrl),
      steer: field("steer", fields.steer),
    },
    problems,
  };
};

const load = (): Loaded => {
  try {
    return parse(readFileSync(configPath(), "utf-8"));
  } catch (error) {
    const missing =
      error instanceof Error && "code" in error && error.code === "ENOENT";

    return {
      config: EMPTY,
      problems: missing
        ? []
        : [`${configPath()} could not be read: ${String(error)}`],
    };
  }
};

export const readConfig = (): Config => load().config;

// A file the bridge cannot use is reported once per session, not per prompt.
export const registerConfig = (pi: ExtensionAPI): void => {
  let warned = false;

  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType !== "user" || warned || !ctx.hasUI) {
      return;
    }

    const { problems } = load();

    if (problems.length > 0) {
      warned = true;
      ctx.ui.notify(problems.join("\n"), "warning");
    }
  });
};
