import {
  compile,
  nullable,
  num,
  obj,
  opt,
  str,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { appendLog, readLog } from "./state.ts";

// One line per delegated child, written by the child: its cost from
// usage.ts and, for a pstack brief, the report pstack/child.ts checked. A
// parent finds its children's lines by their T3 thread IDs.

const LEDGER = "ledger.jsonl";

const LedgerLineSchema = obj(
  {
    at: opt(str()),
    before: opt(nullable(num())),
    cacheRead: opt(num()),
    cacheWrite: opt(num()),
    cost: opt(num()),
    diskMb: opt(nullable(num())),
    exit: opt(num()),
    input: opt(num()),
    job: opt(nullable(str())),
    minutes: opt(num()),
    model: opt(nullable(str())),
    outside: opt(num()),
    report: opt(str()),
    size: opt(nullable(str())),
    status: opt(str()),
    threadId: opt(nullable(str())),
    tokens: opt(num()),
    workdir: opt(str()),
  },
  { open: true }
);

const ledgerLine = compile(LedgerLineSchema);

export type LedgerLine = Static<typeof LedgerLineSchema>;

export const appendLedger = (line: LedgerLine): void => {
  appendLog(LEDGER, line);
};

export const readLedger = (): LedgerLine[] => readLog(LEDGER, ledgerLine);
