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
import type { Validator } from "@earendil-works/pi-schema";

// The bridge's settings, one JSON file per machine. Each key is checked on its
// own, so one bad value falls back to its default and leaves the rest alone.
// The file is read on every call, so an edit applies on the next prompt,
// except mcpUrl, which the MCP server registers once per session.

interface Field<T, D> {
  readonly fallback?: D;
  readonly validator: Validator<T>;
}

const field = <T, D extends T | undefined = undefined>(
  validator: Validator<T>,
  fallback?: D
): Field<T, D> => ({ fallback, validator });

const FIELDS = {
  // Every shell command in every session, parent or child, gets a timeout of
  // at most this many seconds. A command with no timeout gets exactly this
  // one, so a hung test suite or a long `sleep` poll stalls a chat for
  // minutes, not for a quarter of an hour or forever.
  bashTimeoutSeconds: field(compile(num({ exclusiveMinimum: 0 })), 300),
  childSandbox: field(compile(oneOf(["on", "off"])), "on"),
  classifierModel: field(compile(str({ pattern: "^[^/\\s]+/.+$" }))),
  mcpUrl: field(compile(str({ minLength: 1 })), "http://127.0.0.1:3773/mcp"),
  // Shadow judges and logs but never changes the session.
  steer: field(compile(oneOf(["on", "off", "shadow"])), "on"),
};

type Fields = typeof FIELDS;

type Config = {
  readonly [K in keyof Fields]: Fields[K] extends Field<infer T, infer D>
    ? T | D
    : never;
};

interface Loaded {
  readonly config: Config;
  readonly problems: readonly string[];
}

export const configHome = (): string =>
  process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");

export const configPath = (): string =>
  path.join(configHome(), "pi-t3", "config.json");

const configFile = compile(map(unknown()));

const defaults = (): Config =>
  // SAFETY: each key gets its own field's fallback.
  Object.fromEntries(
    Object.entries(FIELDS).map(([key, { fallback }]) => [key, fallback])
  ) as Config;

const parse = (text: string, file: string): Loaded => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: defaults(), problems: [`${file} is not valid JSON.`] };
  }

  if (!configFile.check(parsed)) {
    return { config: defaults(), problems: [`${file} is not a JSON object.`] };
  }

  const problems: string[] = [];

  const entries = Object.entries(FIELDS).map(
    ([key, { fallback, validator }]) => {
      const value = parsed[key];

      if (value === undefined) {
        return [key, fallback];
      }

      if (validator.check(value)) {
        return [key, value];
      }

      problems.push(
        `"${key}" in ${file} has an invalid value, so its default applies.`
      );

      return [key, fallback];
    }
  );

  // SAFETY: each key holds a value its own validator accepted, or its fallback.
  return { config: Object.fromEntries(entries) as Config, problems };
};

const load = (): Loaded => {
  const file = configPath();

  try {
    return parse(readFileSync(file, "utf-8"), file);
  } catch (error) {
    const missing =
      error instanceof Error && "code" in error && error.code === "ENOENT";

    return {
      config: defaults(),
      problems: missing ? [] : [`${file} could not be read: ${String(error)}`],
    };
  }
};

export const readConfig = (): Config => load().config;

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
