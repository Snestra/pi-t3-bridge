import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

// Machine-wide bridge state, shared by every Pi session: which model families
// are out of usage, and one ledger line per delegated brief.

const stateHome = (): string =>
  process.env.XDG_STATE_HOME?.trim() || path.join(homedir(), ".local", "state");

const stateDir = (): string => path.join(stateHome(), "pi-t3");

// Releases before the bridge had its own name kept this state under
// t3-pstack. The first load after the rename moves it once, so out-of-usage
// marks and the cost ledger carry over. A failed move leaves both alone.
export const moveOldState = (): void => {
  const old = path.join(stateHome(), "t3-pstack");

  if (existsSync(stateDir()) || !existsSync(old)) {
    return;
  }

  try {
    renameSync(old, stateDir());
  } catch {
    // The bridge starts with empty state instead.
  }
};

const FamilyRecordSchema = Type.Union([
  Type.Object({
    reason: Type.Union([Type.Literal("exhausted"), Type.Literal("unhealthy")]),
    resetAt: Type.Optional(Type.String()),
    since: Type.String(),
    source: Type.Union([Type.Literal("delegate"), Type.Literal("user")]),
    state: Type.Literal("exhausted"),
  }),
  Type.Object({
    childThreadId: Type.String(),
    since: Type.String(),
    state: Type.Literal("probing"),
  }),
]);

const AccountsFileSchema = Type.Object({
  families: Type.Record(Type.String(), FamilyRecordSchema),
});

export type FamilyRecord = Static<typeof FamilyRecordSchema>;

type AccountsFile = Static<typeof AccountsFileSchema>;

const accountsPath = (): string => path.join(stateDir(), "accounts.json");

export const readFamilies = (): AccountsFile["families"] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(accountsPath(), "utf-8"));

    return Value.Check(AccountsFileSchema, parsed) ? parsed.families : {};
  } catch {
    return {};
  }
};

// Write to a temporary file and rename it over the old one, so a session
// reading at the same time sees the old state or the new one, never half.
export const updateFamily = (family: string, record?: FamilyRecord): void => {
  const families = Object.fromEntries(
    Object.entries(readFamilies()).filter(([name]) => name !== family)
  );

  if (record !== undefined) {
    families[family] = record;
  }

  mkdirSync(stateDir(), { recursive: true });

  const target = accountsPath();
  const temporary = `${target}.${process.pid}.tmp`;

  writeFileSync(temporary, `${JSON.stringify({ families }, null, 2)}\n`);
  renameSync(temporary, target);
};

export const appendLedger = (
  line: Record<string, string | number | null>
): void => {
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(
    path.join(stateDir(), "ledger.jsonl"),
    `${JSON.stringify(line)}\n`
  );
};

// One line per steer check, beside the ledger. It holds the verdict and never
// transcript text. A log that cannot be written must not break a session.
export const appendSteerLog = (line: {
  readonly error?: string;
  readonly fired?: readonly string[];
  readonly kind: string;
  readonly mode: string;
  readonly model: string;
  readonly nudged: boolean;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly session: string;
  readonly turn?: number;
  readonly verdict?: {
    readonly handoffMissing?: number | undefined;
    readonly kind: string;
    readonly unfinished: number;
  };
}): void => {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(
      path.join(stateDir(), "steer.jsonl"),
      `${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`
    );
  } catch {
    // Nothing to do: the check already ran.
  }
};

const LedgerLineSchema = Type.Object({
  cacheRead: Type.Optional(Type.Number()),
  cacheWrite: Type.Optional(Type.Number()),
  cost: Type.Optional(Type.Number()),
  input: Type.Optional(Type.Number()),
  job: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  minutes: Type.Optional(Type.Number()),
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  report: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  threadId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  tokens: Type.Optional(Type.Number()),
});

export type LedgerLine = Static<typeof LedgerLineSchema>;

export const readLedger = (): LedgerLine[] => {
  try {
    return readFileSync(path.join(stateDir(), "ledger.jsonl"), "utf-8")
      .split("\n")
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);

          return Value.Check(LedgerLineSchema, parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};
