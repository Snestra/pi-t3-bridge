import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  compile,
  lit,
  map,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { lock } from "proper-lockfile";

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

const FamilyRecordSchema = union([
  obj(
    {
      reason: oneOf(["exhausted", "unhealthy"]),
      resetAt: opt(str()),
      since: str(),
      source: oneOf(["delegate", "user"]),
      state: lit("exhausted"),
    },
    { open: true }
  ),
  obj(
    { childThreadId: str(), since: str(), state: lit("probing") },
    { open: true }
  ),
]);

const AccountsFileSchema = obj(
  { families: map(FamilyRecordSchema) },
  { open: true }
);

const isAccountsFile = compile(AccountsFileSchema).check;

export type FamilyRecord = Static<typeof FamilyRecordSchema>;

type AccountsFile = Static<typeof AccountsFileSchema>;

const accountsPath = (): string => path.join(stateDir(), "accounts.json");

export const readFamilies = (): AccountsFile["families"] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(accountsPath(), "utf-8"));

    return isAccountsFile(parsed) ? parsed.families : {};
  } catch {
    return {};
  }
};

// Every Pi session on the machine writes this file, so the read, the change
// and the write happen under one lock, and no session drops another's mark.
// The write goes to a temporary file renamed over the old one, so a reader
// without the lock sees the old state or the new one, never half.
export const updateFamily = async (
  family: string,
  record?: FamilyRecord
): Promise<void> => {
  mkdirSync(stateDir(), { recursive: true });

  const target = accountsPath();

  const release = await lock(target, {
    lockfilePath: `${target}.lock`,
    realpath: false,
    retries: { maxTimeout: 200, minTimeout: 20, retries: 50 },
  });

  try {
    const families = Object.fromEntries(
      Object.entries(readFamilies()).filter(([name]) => name !== family)
    );

    if (record !== undefined) {
      families[family] = record;
    }

    const temporary = `${target}.${process.pid}.tmp`;

    writeFileSync(temporary, `${JSON.stringify({ families }, null, 2)}\n`);
    renameSync(temporary, target);
  } finally {
    await release();
  }
};

// Each log keeps its newest lines in <name> and the lines before them in
// <name>.1, so one log never holds more than about twice this much.
const LOG_LIMIT_BYTES = 10 * 1024 * 1024;

const appendLog = (name: string, text: string): void => {
  mkdirSync(stateDir(), { recursive: true });

  const file = path.join(stateDir(), name);

  try {
    if (statSync(file).size >= LOG_LIMIT_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    // No log yet.
  }

  appendFileSync(file, text);
};

export const appendLedger = (
  line: Record<string, string | number | null>
): void => {
  appendLog("ledger.jsonl", `${JSON.stringify(line)}\n`);
};

// One line per steer check, beside the ledger. It holds the verdict and never
// transcript text. A log that cannot be written must not break a session.
export const appendSteerLog = (line: {
  readonly capped?: boolean;
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
    appendLog(
      "steer.jsonl",
      `${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`
    );
  } catch {
    // Nothing to do: the check already ran.
  }
};

// The bearer token the bridge signed in to T3's MCP server with. Only this
// user may read the file, because the token can launch full-access threads.
const T3CredentialSchema = obj(
  { expiresAt: num(), token: str({ minLength: 1 }), url: str() },
  { open: true }
);

const isT3Credential = compile(T3CredentialSchema).check;

export type T3Credential = Static<typeof T3CredentialSchema>;

const t3CredentialPath = (): string => path.join(stateDir(), "t3-mcp.json");

export const readT3Credential = (url: string): T3Credential | undefined => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(t3CredentialPath(), "utf-8")
    );

    return isT3Credential(parsed) && parsed.url === url ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const writeT3Credential = (credential: T3Credential): void => {
  mkdirSync(stateDir(), { recursive: true });

  const target = t3CredentialPath();
  const temporary = `${target}.${process.pid}.tmp`;

  writeFileSync(temporary, `${JSON.stringify(credential)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
};

const LedgerLineSchema = obj(
  {
    cacheRead: opt(num()),
    cacheWrite: opt(num()),
    cost: opt(num()),
    input: opt(num()),
    job: opt(nullable(str())),
    minutes: opt(num()),
    model: opt(nullable(str())),
    report: opt(str()),
    status: opt(str()),
    threadId: opt(nullable(str())),
    tokens: opt(num()),
  },
  { open: true }
);

const isLedgerLine = compile(LedgerLineSchema).check;

export type LedgerLine = Static<typeof LedgerLineSchema>;

const readLines = (file: string): string[] => {
  try {
    return readFileSync(file, "utf-8").split("\n");
  } catch {
    return [];
  }
};

// The older file first, so a later line still wins over an earlier one.
export const readLedger = (): LedgerLine[] => {
  const file = path.join(stateDir(), "ledger.jsonl");

  return [...readLines(`${file}.1`), ...readLines(file)].flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);

      return isLedgerLine(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
};
