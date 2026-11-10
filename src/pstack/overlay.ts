import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { arr, compile, map, num, obj, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { statePath } from "../bridge/state.ts";

interface Patch {
  readonly find: string;
  readonly replace: string;
}

const PatchSchema = obj({ find: str(), replace: str() }, { open: true });

const OverlayManifestSchema = obj(
  {
    files: map(arr(PatchSchema)),
    global: arr(PatchSchema),
    shared: arr(
      obj({ files: arr(str()), patches: arr(PatchSchema) }, { open: true })
    ),
    version: num(),
  },
  { open: true }
);

const isOverlayManifest = compile(OverlayManifestSchema).check;

type OverlayManifest = Static<typeof OverlayManifestSchema>;

const TEXT_SUFFIX = ".md";

// What the agent reads from upstream. Each entry also feeds the copy's hash.
const COPIED_ENTRIES = [
  "skills",
  "agents",
  "models.json",
  "hooks/session-start-context.md",
] as const;

export const overlayDir = (extensionDir: string): string =>
  path.join(extensionDir, "overlay");

export const loadManifest = (dir: string): OverlayManifest => {
  const manifestPath = path.join(dir, "overlay.json");
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));

  if (!isOverlayManifest(parsed)) {
    throw new Error(
      `overlay manifest ${manifestPath} does not match the overlay schema`
    );
  }

  return parsed;
};

const patchesFor = (
  manifest: OverlayManifest,
  relativePath: string
): readonly Patch[] => {
  const own = manifest.files[relativePath] ?? [];

  const shared = manifest.shared
    .filter((group) => group.files.includes(relativePath))
    .flatMap((group) => group.patches);

  return [...shared, ...own];
};

export const applyOverlay = (
  manifest: OverlayManifest,
  relativePath: string,
  text: string
): string => {
  let result = text;

  for (const patch of patchesFor(manifest, relativePath)) {
    if (!result.includes(patch.find)) {
      throw new Error(
        `overlay patch for ${relativePath} no longer matches upstream text: ${JSON.stringify(patch.find.slice(0, 120))}. Update overlay/overlay.json for the new upstream wording.`
      );
    }

    result = result.replaceAll(patch.find, patch.replace);
  }

  for (const patch of manifest.global) {
    result = result.replaceAll(patch.find, patch.replace);
  }

  return result;
};

const walkFiles = (root: string, base = root): string[] =>
  readdirSync(base, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(base, entry.name);

    if (entry.isDirectory()) {
      return walkFiles(root, full);
    }

    return entry.isFile() ? [path.relative(root, full)] : [];
  });

const fingerprint = (
  upstreamRoot: string,
  manifestText: string,
  extensionModules: string
): string => {
  const hash = createHash("sha256")
    .update(manifestText)
    .update(extensionModules);

  for (const entry of COPIED_ENTRIES) {
    const full = path.join(upstreamRoot, entry);

    if (!existsSync(full)) {
      continue;
    }

    if (!statSync(full).isDirectory()) {
      hash.update(entry).update(readFileSync(full));
      continue;
    }

    for (const relative of walkFiles(full).toSorted()) {
      hash
        .update(path.join(entry, relative))
        .update(readFileSync(path.join(full, relative)));
    }
  }

  return hash.digest("hex").slice(0, 16);
};

// The pstack the agent reads: upstream copied out of pstack/, with the
// overlay in overlay/ applied. A copy keyed by the hash of both inputs, so
// an upstream sync or an overlay edit builds a fresh copy and a stale one
// is never served. Nothing here writes into pstack/.
export const materializePstack = (
  upstreamRoot: string,
  dir: string,
  cacheRoot: string = statePath("pstack-overlay")
): string => {
  if (!existsSync(path.join(upstreamRoot, "skills"))) {
    return upstreamRoot;
  }

  const manifestText = readFileSync(path.join(dir, "overlay.json"), "utf-8");

  const extensionModules = path.resolve(
    path.dirname(upstreamRoot),
    "node_modules"
  );

  const target = path.join(
    cacheRoot,
    fingerprint(upstreamRoot, manifestText, extensionModules)
  );

  const usable = (): boolean =>
    existsSync(path.join(target, ".complete")) &&
    (!existsSync(extensionModules) ||
      existsSync(path.join(target, "node_modules")));

  if (usable()) {
    return target;
  }

  const manifest = loadManifest(dir);

  mkdirSync(cacheRoot, { recursive: true });

  const staging = `${target}.${process.pid}.tmp`;

  rmSync(staging, { force: true, recursive: true });

  try {
    for (const entry of COPIED_ENTRIES) {
      const from = path.join(upstreamRoot, entry);

      if (existsSync(from)) {
        cpSync(from, path.join(staging, entry), { recursive: true });
      }
    }

    // Scripts under skills/ import packages such as commander. Inside the
    // extension they resolve them from the extension's node_modules, so
    // the copy links that directory in instead of copying it.
    if (
      existsSync(extensionModules) &&
      !existsSync(path.join(staging, "node_modules"))
    ) {
      symlinkSync(extensionModules, path.join(staging, "node_modules"), "dir");
    }

    for (const relative of walkFiles(staging)) {
      if (!relative.endsWith(TEXT_SUFFIX)) {
        continue;
      }

      const filePath = path.join(staging, relative);

      writeFileSync(
        filePath,
        applyOverlay(manifest, relative, readFileSync(filePath, "utf-8"))
      );
    }

    writeFileSync(path.join(staging, ".complete"), "");

    // A usable copy is never removed, because other Pi processes may serve
    // it. An unusable one is moved aside first, so its removal can't race a
    // copy another process renames into place.
    if (existsSync(target) && !usable()) {
      const stale = `${target}.${process.pid}.stale`;

      renameSync(target, stale);
      rmSync(stale, { force: true, recursive: true });
    }

    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });

    // Another Pi process that started at the same time renamed the same copy
    // into place first. Its copy is identical, so use it.
    if (usable()) {
      return target;
    }

    throw error;
  }

  return target;
};
