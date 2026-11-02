import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

const ResultEnvelopeSchema = Type.Object({
  structuredContent: Type.Unknown(),
});

const TextPartSchema = Type.Object({ text: Type.String() });

export interface ToolOutput {
  readonly content: readonly unknown[];
  readonly structuredContent?: unknown;
}

const textOf = (content: readonly unknown[]): string =>
  content
    .map((part) => (Value.Check(TextPartSchema, part) ? part.text : ""))
    .join("");

// T3's in-thread bridge passes the whole MCP result as structuredContent,
// a direct MCP client passes the server's structuredContent itself, and
// some results carry their data only as JSON text.
export const t3Json = <S extends TSchema>(
  schema: S,
  output: ToolOutput
): Static<S> | undefined => {
  const structured = output.structuredContent;

  const fromStructured = [
    Value.Check(ResultEnvelopeSchema, structured)
      ? structured.structuredContent
      : undefined,
    structured,
  ].find((candidate) => Value.Check(schema, candidate));

  if (Value.Check(schema, fromStructured)) {
    return fromStructured;
  }

  try {
    const parsed = JSON.parse(textOf(output.content));

    return Value.Check(schema, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const t3Text = (output: ToolOutput): string => textOf(output.content);
