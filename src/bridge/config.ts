import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

// The bridge's settings, one JSON file per machine. Each key is checked on its
// own, so one bad value falls back to its default and leaves the rest alone.
// The file is read on every call, so an edit applies on the next prompt.

const SteerSchema = Type.Union([
  Type.Literal("on"),
  Type.Literal("off"),
  Type.Literal("shadow"),
]);

const ChildSandboxSchema = Type.Union([
  Type.Literal("on"),
  Type.Literal("off"),
]);

export interface Config {
  readonly bashTimeoutSeconds: number | undefined;
  readonly childSandbox: Static<typeof ChildSandboxSchema> | undefined;
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
  mcpUrl: undefined,
  steer: undefined,
};

export const configPath = (): string =>
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

  if (!Value.Check(Type.Record(Type.String(), Type.Unknown()), parsed)) {
    return { config: EMPTY, problems: [`${file} is not a JSON object.`] };
  }

  const problems: string[] = [];

  const field = <S extends TSchema>(
    key: string,
    schema: S
  ): Static<S> | undefined => {
    const value = parsed[key];

    if (value === undefined || Value.Check(schema, value)) {
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
        Type.Number({ exclusiveMinimum: 0 })
      ),
      childSandbox: field("childSandbox", ChildSandboxSchema),
      mcpUrl: field("mcpUrl", Type.String({ minLength: 1 })),
      steer: field("steer", SteerSchema),
    },
    problems,
  };
};

const load = (): Loaded => {
  try {
    return parse(readFileSync(configPath(), "utf-8"));
  } catch {
    return { config: EMPTY, problems: [] };
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
