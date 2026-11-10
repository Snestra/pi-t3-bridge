import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
  arr,
  bool,
  compile,
  lit,
  map,
  nullable,
  obj,
  oneOf,
  opt,
  str,
  union,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import {
  parseEntry,
  parseSheet,
} from "../../pstack/skills/setup-pstack/scripts/t3-sheet.mjs";
import {
  ACCOUNT_COMMAND,
  family,
  familyOpen,
  readFamilies,
  settleChildren,
} from "../bridge/accounts.ts";
import { t3Json, t3Text } from "../bridge/t3-json.ts";
import { findT3Tool, isT3Tool } from "../bridge/t3-tasks.ts";
import type { Size } from "./brief.ts";
import { readPolicy } from "./resources.ts";
import type { Policy } from "./resources.ts";
import { readSheet } from "./sheet.ts";

const OptionValueSchema = union([str(), bool()]);

const CatalogOptionSchema = obj(
  { id: str(), values: arr(OptionValueSchema) },
  { open: true }
);

const CatalogModelSchema = obj(
  { id: str(), options: opt(arr(CatalogOptionSchema)) },
  { open: true }
);

const CatalogProviderSchema = obj(
  {
    canRunChildTask: bool(),
    canRunCrossProviderChildTask: opt(bool()),
    models: arr(CatalogModelSchema),
    providerInstanceId: str(),
  },
  { open: true }
);

const CatalogSchema = obj(
  {
    inheritedModel: nullable(str()),
    inheritedProviderInstanceId: nullable(str()),
    providers: arr(CatalogProviderSchema),
  },
  { open: true }
);

const catalogValidator = compile(CatalogSchema);

const ComplexitySchema = oneOf(["groundwork", "bounded", "general"]);

const isBoolean = compile(bool()).check;

const isThreadSend = compile(obj({ message: str() }, { open: true })).check;

type CatalogOption = Static<typeof CatalogOptionSchema>;

type CatalogModel = Static<typeof CatalogModelSchema>;

type CatalogProvider = Static<typeof CatalogProviderSchema>;

type Catalog = Static<typeof CatalogSchema>;

type Complexity = Static<typeof ComplexitySchema>;

type Role = Policy["roles"][number];

type OptionValue = Static<typeof OptionValueSchema>;

type TargetOptions = Readonly<Record<string, OptionValue>>;

const TargetSchema = obj(
  { model: str(), options: map(OptionValueSchema), providerInstanceId: str() },
  { open: true }
);

type Target = Static<typeof TargetSchema>;

type Entry = Target | null;

interface ResolveContext {
  readonly available: (modelFamily: string) => boolean;
  readonly catalog: Catalog;
  readonly notes: string[];
  readonly policy: Policy;
}

const ResolutionSchema = union([
  obj(
    {
      kind: lit("targets"),
      notes: arr(str()),
      role: str(),
      targets: arr(TargetSchema),
    },
    { open: true }
  ),
  obj(
    { kind: lit("inherit-parent"), notes: arr(str()), role: str() },
    { open: true }
  ),
  obj(
    { kind: lit("blocked"), notes: arr(str()), reason: str(), role: str() },
    { open: true }
  ),
]);

type Resolution = Static<typeof ResolutionSchema>;

const SIZE_FALLBACK: Readonly<Record<Complexity, readonly Complexity[]>> = {
  bounded: ["bounded", "groundwork", "general"],
  general: ["general", "bounded", "groundwork"],
  groundwork: ["groundwork", "bounded", "general"],
};

const lastSegment = (model: string): string => model.split("/").pop() ?? model;

const describe = (target: Target): string => {
  const options = Object.entries(target.options)
    .map(([id, value]) => ` ${id}=${value}`)
    .join("");

  return `${target.providerInstanceId}/${target.model}${options}`;
};

const runnableProviders = (catalog: Catalog): CatalogProvider[] => {
  const runnable = catalog.providers.filter(
    (provider) =>
      provider.canRunChildTask &&
      (provider.canRunCrossProviderChildTask !== false ||
        provider.providerInstanceId === catalog.inheritedProviderInstanceId)
  );

  const rank = (provider: CatalogProvider): number =>
    provider.providerInstanceId === catalog.inheritedProviderInstanceId ? 0 : 1;

  return runnable.toSorted((left, right) => rank(left) - rank(right));
};

const optionValues = (option: CatalogOption): readonly string[] =>
  option.values.map(String);

const isSwitch = (option: CatalogOption): boolean =>
  option.values.every((value) => isBoolean(value));

const translateOptions = (
  wanted: TargetOptions,
  model: CatalogModel,
  notes: string[]
): TargetOptions => {
  const known = model.options ?? [];
  const translated = new Map<string, OptionValue>();

  for (const [id, wantedValue] of Object.entries(wanted)) {
    const value = String(wantedValue);

    const sameId = known.find(
      (option) => option.id === id && optionValues(option).includes(value)
    );

    const sameValue = known.find(
      (option) => !isSwitch(option) && optionValues(option).includes(value)
    );

    const match = sameId ?? sameValue;

    if (match === undefined) {
      notes.push(`${model.id} has no option that accepts ${id}=${value}`);
    } else {
      translated.set(
        match.id,
        match.values.find((choice) => String(choice) === value) ?? value
      );
    }
  }

  return Object.fromEntries(translated);
};

const placeEntry = (
  entry: Target,
  catalog: Catalog,
  notes: string[]
): Target | undefined => {
  const providers = runnableProviders(catalog);

  const exact = providers.find(
    (provider) => provider.providerInstanceId === entry.providerInstanceId
  );

  const ordered = exact === undefined ? providers : [exact, ...providers];

  for (const provider of ordered) {
    const model =
      provider.models.find((candidate) => candidate.id === entry.model) ??
      provider.models.find(
        (candidate) => lastSegment(candidate.id) === lastSegment(entry.model)
      );

    if (model !== undefined) {
      return {
        model: model.id,
        options: translateOptions(entry.options, model, notes),
        providerInstanceId: provider.providerInstanceId,
      };
    }
  }

  return undefined;
};

// A routed model, preferring the parent's own provider.
const placeModel = (
  model: string,
  reasoning: string,
  catalog: Catalog,
  notes: string[]
): Target | undefined =>
  placeEntry(
    {
      model,
      options: { reasoning },
      providerInstanceId: catalog.inheritedProviderInstanceId ?? "",
    },
    catalog,
    notes
  );

const placeRouted = (
  modelFamily: string,
  complexity: Complexity,
  {
    catalog,
    notes,
    policy,
  }: { catalog: Catalog; notes: string[]; policy: Policy }
): Target | undefined => {
  const sizes = policy.routing.families[modelFamily];

  if (sizes === undefined) {
    return undefined;
  }

  for (const size of SIZE_FALLBACK[complexity]) {
    const placed = placeModel(
      sizes[size],
      policy.routing.reasoning[complexity],
      catalog,
      notes
    );

    if (placed !== undefined) {
      if (size !== complexity) {
        notes.push(
          `${sizes[complexity]} cannot run here, so ${modelFamily} ${complexity} work uses ${placed.model}`
        );
      }

      return placed;
    }
  }

  notes.push(`no ${modelFamily} model can run here`);

  return undefined;
};

const withJobReasoning = (
  entry: Target,
  complexity: Complexity,
  policy: Policy
): Target => ({
  ...entry,
  options: {
    reasoning: policy.routing.reasoning[complexity],
    ...entry.options,
  },
});

const sheetEntries = (sheet: string, role: Role): Entry[] | undefined => {
  const value = parseSheet(sheet).find(
    (line: { key?: string }) =>
      line.key === role.role || line.key === role.alias
  )?.value;

  return value === undefined
    ? undefined
    : String(value).split(",").map(parseEntry);
};

const resolveSingle = (
  role: Role,
  explicit: Entry,
  complexity: Complexity,
  { available, catalog, notes, policy }: ResolveContext
): Resolution => {
  if (explicit !== null && !available(family(explicit.model))) {
    notes.push(
      `${describe(explicit)} from the model sheet is on an exhausted account`
    );
  }

  if (explicit !== null && available(family(explicit.model))) {
    const placed = placeEntry(
      withJobReasoning(explicit, complexity, policy),
      catalog,
      notes
    );

    if (placed !== undefined) {
      notes.push("the model sheet names this target");

      return { kind: "targets", notes, role: role.role, targets: [placed] };
    }

    notes.push(`${describe(explicit)} from the model sheet cannot run here`);
  }

  if (catalog.inheritedModel === null) {
    return { kind: "inherit-parent", notes, role: role.role };
  }

  const parentFamily = family(catalog.inheritedModel);

  const familyOrder = [
    parentFamily,
    ...policy.routing.panel.filter((name) => name !== parentFamily),
  ].filter((name) => {
    const open = available(name);

    if (!open) {
      notes.push(`${name} is on an exhausted account`);
    }

    return open;
  });

  const routed = familyOrder
    .values()
    .map((name) => placeRouted(name, complexity, { catalog, notes, policy }))
    .find((target) => target !== undefined);

  if (routed === undefined && !available(parentFamily)) {
    return {
      kind: "blocked",
      notes,
      reason: `Every model family that can run here is on an exhausted account. Wait for a reset or for /t3-recovered.`,
      role: role.role,
    };
  }

  if (routed === undefined) {
    notes.push("the role runs on the parent model");

    return { kind: "inherit-parent", notes, role: role.role };
  }

  return { kind: "targets", notes, role: role.role, targets: [routed] };
};

const resolvePanel = (
  role: Role,
  explicit: readonly Entry[],
  complexity: Complexity,
  { available, catalog, notes, policy }: ResolveContext
): Resolution => {
  const targets: Target[] = [];

  const families = (): Set<string> =>
    new Set(targets.map((target) => family(target.model)));

  const seat = (target: Target | undefined): void => {
    if (
      target !== undefined &&
      !targets.some((seated) => describe(seated) === describe(target))
    ) {
      targets.push(target);
    }
  };

  for (const entry of explicit) {
    seat(
      entry === null || !available(family(entry.model))
        ? undefined
        : placeEntry(
            withJobReasoning(entry, complexity, policy),
            catalog,
            notes
          )
    );
  }

  for (const modelFamily of policy.routing.panel.filter(available)) {
    if (explicit.length === 0 || families().size < 2) {
      const placed = families().has(modelFamily)
        ? undefined
        : placeRouted(modelFamily, complexity, { catalog, notes, policy });

      seat(placed);
    }
  }

  if (families().size < 2) {
    return {
      kind: "blocked",
      notes,
      reason: `BLOCKED: independent review. The panel needs two model families that can run on this T3, and found ${[...families()].join(", ") || "none"}.`,
      role: role.role,
    };
  }

  return { kind: "targets", notes, role: role.role, targets };
};

const findRole = (policy: Policy, roleName: string): Role => {
  const role = policy.roles.find(
    (candidate) => candidate.role === roleName || candidate.alias === roleName
  );

  if (role === undefined) {
    throw new Error(
      `"${roleName}" is not a pstack role. Roles: ${policy.roles.map((candidate) => candidate.role).join("; ")}.`
    );
  }

  return role;
};

const tierOf = (policy: Policy, model: string): Complexity | undefined => {
  const sizes = policy.routing.families[family(model)];

  // SAFETY: SIZE_FALLBACK is keyed by every Complexity value.
  return (Object.keys(SIZE_FALLBACK) as Complexity[]).find(
    (size) => sizes?.[size] === model
  );
};

const jobSpec = (policy: Policy, job: string) => {
  const spec = policy.jobs[job];

  if (spec === undefined) {
    throw new Error(
      `"${job}" is not a job type. Jobs: ${Object.keys(policy.jobs).join(", ")}.`
    );
  }

  return spec;
};

const resolvePanelJob = (
  role: Role,
  job: string,
  panel: readonly { model: string; reasoning: string }[],
  { available, catalog, notes }: ResolveContext
): Resolution => {
  const targets: Target[] = [];

  for (const seat of panel) {
    if (available(family(seat.model))) {
      const placed = placeModel(seat.model, seat.reasoning, catalog, notes);

      if (placed !== undefined) {
        targets.push(placed);
      }
    } else {
      notes.push(`${family(seat.model)} is on an exhausted account`);
    }
  }

  if (new Set(targets.map((target) => family(target.model))).size < 2) {
    return {
      kind: "blocked",
      notes,
      reason: `BLOCKED: independent review. The ${job} panel needs two model families that can run here.`,
      role: role.role,
    };
  }

  return { kind: "targets", notes, role: role.role, targets };
};

// The routing table: a job type and size pick the tier, model and reasoning.
// When that model's family is out, the same tier in the next family takes it,
// except that GPT only ever takes size S work.
const resolveJob = (
  role: Role,
  job: string,
  size: Size | undefined,
  explicit: readonly Entry[],
  { available, catalog, notes, policy }: ResolveContext
): Resolution => {
  const spec = jobSpec(policy, job);

  if ("panel" in spec) {
    if (explicit.some((entry) => entry !== null)) {
      return resolvePanel(role, explicit, "general", {
        available,
        catalog,
        notes,
        policy,
      });
    }

    return resolvePanelJob(role, job, spec.panel, {
      available,
      catalog,
      notes,
      policy,
    });
  }

  if (size === "L") {
    throw new Error(
      "Size L is too large to delegate: split the job into S or M tasks, or do it yourself."
    );
  }

  if (size === undefined) {
    throw new Error(`Job "${job}" needs a size: S or M.`);
  }

  const wanted = spec[size];
  const sheetEntry = explicit[0] ?? null;

  if (sheetEntry !== null && available(family(sheetEntry.model))) {
    const placed = placeEntry(
      {
        ...sheetEntry,
        options: { reasoning: wanted.reasoning, ...sheetEntry.options },
      },
      catalog,
      notes
    );

    if (placed !== undefined) {
      notes.push("the model sheet names this target");

      return { kind: "targets", notes, role: role.role, targets: [placed] };
    }
  }

  const wantedFamily = family(wanted.model);
  const tier = tierOf(policy, wanted.model) ?? "bounded";
  const { gpt } = policy.briefs;

  const families = [
    wantedFamily,
    ...policy.routing.panel.filter((name) => name !== wantedFamily),
  ].filter((name) => name !== gpt.family || size === gpt.size);

  for (const name of families) {
    if (available(name)) {
      const model =
        name === wantedFamily
          ? wanted.model
          : policy.routing.families[name]?.[tier];

      const placed =
        model === undefined
          ? undefined
          : placeModel(model, wanted.reasoning, catalog, notes);

      if (placed !== undefined) {
        if (name !== wantedFamily) {
          notes.push(
            `${wanted.model} is unavailable, so this ${job} ${size} job runs on ${placed.model}`
          );
        }

        return { kind: "targets", notes, role: role.role, targets: [placed] };
      }
    } else {
      notes.push(`${name} is on an exhausted account`);
    }
  }

  return {
    kind: "blocked",
    notes,
    reason: `No family that can take ${job} ${size} work is available. Wait for a reset or for /t3-recovered.`,
    role: role.role,
  };
};

const resolveRole = (
  roleName: string,
  complexity: Complexity,
  {
    available,
    catalog,
    job,
    policy,
    sheet,
    size,
  }: {
    available: (modelFamily: string) => boolean;
    catalog: Catalog;
    job?: string | undefined;
    policy: Policy;
    sheet: string;
    size?: Size | undefined;
  }
): Resolution => {
  const role = findRole(policy, roleName);
  const notes: string[] = [];
  const configured = sheetEntries(sheet, role) ?? [];
  const context = { available, catalog, notes, policy };

  if (job !== undefined) {
    return resolveJob(role, job, size, configured, context);
  }

  if (role.tier === "panel") {
    return resolvePanel(role, configured, complexity, context);
  }

  return resolveSingle(role, configured[0] ?? null, complexity, context);
};

const readCatalog = async (ctx: ExtensionToolContext): Promise<Catalog> => {
  const name = findT3Tool(ctx.tools, "orchestrator_capabilities");

  if (name === undefined) {
    throw new Error(
      "T3's orchestrator_capabilities tool is not available in this session."
    );
  }

  const outcome = await ctx.executeTool(name, {});

  if (outcome.isError) {
    throw new TypeError(
      `orchestrator_capabilities failed: ${t3Text(outcome.result)}`
    );
  }

  const catalog = t3Json(catalogValidator, outcome.result);

  if (catalog === undefined) {
    throw new TypeError(
      "orchestrator_capabilities did not return the expected shape."
    );
  }

  return catalog;
};

const ComplexityOrJob = obj(
  {
    complexity: opt(ComplexitySchema),
    job: opt(
      str({
        description:
          "The job type from the routing table: mechanical, check, research, implement, hard, review, or design.",
      })
    ),
    role: str({ description: "The pstack role name.", minLength: 1 }),
    size: opt(
      oneOf(["S", "M", "L"], {
        description:
          "S: 30 min or less and 5 files or fewer. M: 90 min or less and 15 files or fewer. L is refused: split it.",
      })
    ),
  },
  { open: true }
);

const modelTool = (pi: ExtensionAPI) =>
  defineTool({
    annotations: { readOnlyHint: true },
    description:
      "Resolve the delegate_task target for a pstack role. Pass the role name with the job and size from the routing table, or the complexity when there is no job. Pass each returned target as delegate_task's target. kind inherit-parent means omit target, and kind blocked means the role cannot run.",
    execute: async (
      _toolCallId,
      params: Static<typeof ComplexityOrJob>,
      _signal,
      _onUpdate,
      ctx
    ) => {
      await settleChildren(pi, ctx);

      const families = readFamilies();

      const resolution = resolveRole(
        params.role,
        params.complexity ?? "general",
        {
          available: (modelFamily) => familyOpen(families[modelFamily]),
          catalog: await readCatalog(ctx),
          job: params.job,
          policy: readPolicy(),
          sheet: readSheet(),
          size: params.size,
        }
      );

      return {
        content: [{ text: JSON.stringify(resolution, null, 2), type: "text" }],
        details: resolution,
        structuredContent: resolution,
      };
    },
    label: "Pstack model",
    name: "pstack_model",
    outputSchema: ResolutionSchema,
    parameters: ComplexityOrJob,
    promptSnippet: "Resolve the delegate_task target for a pstack role.",
  });

export const registerModelRouting = (pi: ExtensionAPI): void => {
  pi.registerTool(modelTool(pi));

  pi.on("tool_call", (event) => {
    if (
      isT3Tool(event.toolName, "t3_thread_send") &&
      isThreadSend(event.input) &&
      ACCOUNT_COMMAND.test(event.input.message)
    ) {
      return {
        block: true,
        reason:
          "A message to a child cannot contain /t3-exhausted or /t3-recovered. Account state is shared, so the child already sees it.",
      };
    }
  });
};
