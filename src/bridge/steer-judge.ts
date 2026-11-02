import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  ClassifierBoolQuestion,
  ClassifierContext,
  JsonObject,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { MastExcerpt, StopInput } from "./steer-transcript.ts";

// Asks TypeSafe's Jev how a run ended. The classifier call follows
// pi-mast-steer's src/judge.ts (MIT, github.com/dbreunig/pi-mast-steer): any
// failure becomes an error value, so a judge that is down never blocks a
// session.

const StopKindSchema = Type.Union([
  Type.Literal("done"),
  Type.Literal("blocked"),
  Type.Literal("asked_permission"),
  Type.Literal("gave_up_midway"),
]);

export type StopKind = Static<typeof StopKindSchema>;

export type StopVerdict =
  | {
      readonly kind: StopKind;
      readonly unfinished: number;
      readonly handoffMissing: number | undefined;
    }
  | { readonly error: string };

const BoolQuestionSchema = Type.Object({
  criteria: Type.Object({ false: Type.String(), true: Type.String() }),
  instructions: Type.String(),
  type: Type.Literal("bool"),
});

const QuestionsFileSchema = Type.Object({
  instructions: Type.String(),
  questions: Type.Object({
    handoff_missing: BoolQuestionSchema,
    stop_kind: Type.Object({
      criteria: Type.Record(Type.String(), Type.String()),
      instructions: Type.String(),
      type: Type.Literal("choice"),
    }),
    unfinished: BoolQuestionSchema,
  }),
  thresholds: Type.Object({
    handoff: Type.Number(),
    unfinished: Type.Number(),
  }),
});

const BoolAnswerSchema = Type.Object({
  probability: Type.Number(),
  type: Type.Literal("bool"),
});

const AnswersSchema = Type.Object({
  handoff_missing: Type.Optional(BoolAnswerSchema),
  stop_kind: Type.Object({
    choice: StopKindSchema,
    type: Type.Literal("choice"),
  }),
  unfinished: BoolAnswerSchema,
});

const readQuestions = (): Static<typeof QuestionsFileSchema> => {
  const questions: unknown = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "steer-questions.json"),
      "utf-8"
    )
  );

  if (!Value.Check(QuestionsFileSchema, questions)) {
    throw new TypeError(
      "steer-questions.json does not have the expected shape."
    );
  }

  return questions;
};

// Fitted on the user's own labelled stops. See the stop-steer outline, phase 6.
export const stopThresholds = () => readQuestions().thresholds;

// Jev's failures are values. Nothing here throws on a classifier that is down.
const askJev = async (
  ctx: ExtensionContext,
  context: ClassifierContext,
  signal: AbortSignal
): Promise<{ readonly answers: unknown } | { readonly error: string }> => {
  const jev = ctx.modelRegistry.findOfType(
    "classifier",
    "typesafe",
    "jev-latest"
  );

  if (jev === undefined) {
    return { error: "typesafe/jev-latest is not in the model catalog" };
  }

  const result = await ctx.modelRegistry.classify(jev, context, { signal });

  return result.stopReason === "stop"
    ? { answers: result.answers }
    : { error: result.errorMessage ?? result.stopReason };
};

export const judgeStop = async (
  ctx: ExtensionContext,
  input: StopInput,
  signal: AbortSignal
): Promise<StopVerdict> => {
  const { instructions, questions } = readQuestions();

  // Without the user's rule there is nothing to measure the ending against,
  // so the handoff question is not asked. The caller leaves the rule out for a
  // delegated child, which reports to its parent, not to the user.
  const rules = input.userRules;

  const state: JsonObject = {
    final_message: input.finalMessage,
    instructions,
    recent_work: input.recentWork,
    task: input.task,
  };

  const asked: ClassifierContext["questions"] = {
    stop_kind: questions.stop_kind,
    unfinished: questions.unfinished,
  };

  if (rules !== undefined) {
    state.user_rules = rules;
    asked.handoff_missing = questions.handoff_missing;
  }

  const result = await askJev(ctx, { questions: asked, state }, signal);

  if ("error" in result) {
    return result;
  }

  const { answers } = result;

  if (!Value.Check(AnswersSchema, answers)) {
    return { error: "the classifier did not answer the stop questions" };
  }

  if (rules !== undefined && answers.handoff_missing === undefined) {
    return { error: "the classifier did not answer handoff_missing" };
  }

  return {
    handoffMissing: answers.handoff_missing?.probability,
    kind: answers.stop_kind.choice,
    unfinished: answers.unfinished.probability,
  };
};

// The five MAST questions, ported from pi-mast-steer
// (MIT, github.com/dbreunig/pi-mast-steer, fixtures/dspy-request.json and
// src/modes.ts). The questions and criteria are copied as they are, because
// the thresholds were calibrated on them.
const MastModeSchema = Type.Object({
  code: Type.String(),
  field: Type.String(),
  label: Type.String(),
  note: Type.String(),
  threshold: Type.Number(),
});

export type MastMode = Static<typeof MastModeSchema>;

const MastFileSchema = Type.Object({
  every: Type.Integer({ minimum: 1 }),
  input_fields: Type.String(),
  instructions: Type.String(),
  modes: Type.Array(MastModeSchema),
  questions: Type.Record(
    Type.String(),
    Type.Object({
      // The DSPy criteria are nested objects, which TypeSafe accepts. The
      // classifier types only describe the plain-text form.
      criteria: Type.Unsafe<ClassifierBoolQuestion["criteria"]>(
        Type.Object({}, { additionalProperties: true })
      ),
      instructions: Type.String(),
    })
  ),
});

const readMast = (): Static<typeof MastFileSchema> => {
  const mast: unknown = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "steer-mast.json"), "utf-8")
  );

  if (
    !Value.Check(MastFileSchema, mast) ||
    mast.modes.some((mode) => mast.questions[mode.field] === undefined)
  ) {
    throw new TypeError("steer-mast.json does not have the expected shape.");
  }

  return mast;
};

export const mastModes = (): readonly MastMode[] => readMast().modes;

// Completed turns between MAST checks.
export const mastEvery = (): number => readMast().every;

export type MastVerdict =
  | { readonly probabilities: Readonly<Record<string, number>> }
  | { readonly error: string };

export const judgeMast = async (
  ctx: ExtensionContext,
  excerpt: MastExcerpt,
  signal: AbortSignal
): Promise<MastVerdict> => {
  const mast = readMast();

  const result = await askJev(
    ctx,
    {
      // Pi sends `bool` questions to TypeSafe as `noul`, the type DSPy sends.
      questions: Object.fromEntries(
        mast.modes.map((mode) => [
          mode.field,
          { ...mast.questions[mode.field], type: "bool" as const },
        ])
      ),
      state: {
        input_fields: mast.input_fields,
        inputs: {
          task: excerpt.task,
          trace_window: excerpt.window,
          window_position: excerpt.position,
        },
        instructions: mast.instructions,
      },
    },
    signal
  );

  if ("error" in result) {
    return result;
  }

  const { answers } = result;

  if (!Value.Check(Type.Record(Type.String(), Type.Unknown()), answers)) {
    return { error: "the classifier did not answer the MAST questions" };
  }

  const probabilities: Record<string, number> = {};

  for (const mode of mast.modes) {
    const answer = answers[mode.field];

    if (!Value.Check(BoolAnswerSchema, answer)) {
      return { error: `no answer for ${mode.code}` };
    }

    probabilities[mode.code] = answer.probability;
  }

  return { probabilities };
};
