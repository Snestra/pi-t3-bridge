// The commands that change the machine-wide account state. accounts.ts
// registers them, and pstack keeps them out of what a child is told.
export const EXHAUSTED_COMMAND = "t3-exhausted";

export const RECOVERED_COMMAND = "t3-recovered";

// Either command as it appears in text: at the start of a line, or after a
// space, quote or bracket. Inside a path such as notes/t3-exhausted.md the
// slash follows a name, so it is not one.
export const ACCOUNT_COMMAND = new RegExp(
  String.raw`(?<![\w.~/-])\/(?:${EXHAUSTED_COMMAND}|${RECOVERED_COMMAND})\b`,
  "u"
);
