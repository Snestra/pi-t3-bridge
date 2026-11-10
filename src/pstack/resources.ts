import { readFileSync } from "node:fs";
import path from "node:path";

import {
  arr,
  compile,
  map,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { materializePstack } from "./overlay.ts";

export interface PstackPaths {
  readonly extensionDir: string;
  readonly pstackRoot: string;
  readonly skillsDir: string;
  readonly upstreamRoot: string;
}

let cached: PstackPaths | undefined;

export const pstackPaths = (): PstackPaths => {
  if (cached) {
    return cached;
  }

  const extensionDir = path.resolve(import.meta.dirname, "../..");
  const upstreamRoot = path.join(extensionDir, "pstack");

  const pstackRoot = materializePstack(
    upstreamRoot,
    path.join(extensionDir, "overlay")
  );

  cached = {
    extensionDir,
    pstackRoot,
    skillsDir: path.join(pstackRoot, "skills"),
    upstreamRoot,
  };

  return cached;
};

const policyPath = (): string =>
  path.join(pstackPaths().pstackRoot, "models.json");

const SizesSchema = obj(
  { bounded: str(), general: str(), groundwork: str() },
  { open: true }
);

const JobTargetSchema = obj({ model: str(), reasoning: str() }, { open: true });

const JobSchema = union([
  obj({ M: JobTargetSchema, S: JobTargetSchema }, { open: true }),
  obj({ panel: arr(JobTargetSchema, { minItems: 2 }) }, { open: true }),
]);

const PolicySchema = obj(
  {
    briefs: obj(
      {
        gpt: obj({ family: str(), size: str() }, { open: true }),
        noWrites: arr(str()),
        redBeforeGreen: arr(str()),
        sizes: map(obj({ files: num(), minutes: num() }, { open: true })),
      },
      { open: true }
    ),
    jobs: map(JobSchema),
    roles: arr(
      obj(
        {
          alias: opt(str()),
          role: str(),
          skill: str(),
          tier: oneOf(["single", "panel"]),
        },
        { open: true }
      )
    ),
    routing: obj(
      {
        families: map(SizesSchema),
        panel: arr(str(), { minItems: 2 }),
        reasoning: SizesSchema,
      },
      { open: true }
    ),
  },
  { open: true }
);

const isPolicy = compile(PolicySchema).check;

export type Policy = Static<typeof PolicySchema>;

// models.json ships with the package and never changes while Pi runs.
let policy: Policy | undefined;

export const readPolicy = (): Policy => {
  if (policy !== undefined) {
    return policy;
  }

  const parsed: unknown = JSON.parse(readFileSync(policyPath(), "utf-8"));

  if (!isPolicy(parsed)) {
    throw new TypeError("models.json does not have the expected shape.");
  }

  policy = parsed;

  return policy;
};
