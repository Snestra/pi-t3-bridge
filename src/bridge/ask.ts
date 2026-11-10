import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import {
  arr,
  compile,
  int,
  lit,
  obj,
  oneOf,
  opt,
  str,
  union,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { registerUnlessTaken } from "./claim.ts";
import { insideT3 } from "./t3-http.ts";

const OWN_ANSWER = "Type my own answer";

const ChoiceSchema = obj({
  description: opt(
    str({
      description: "Why to pick it, shown under the question.",
      minLength: 1,
    })
  ),
  label: str({ description: "The choice.", minLength: 1 }),
});

const QuestionSchema = obj({
  body: opt(
    str({
      description: "More context, shown under the title.",
      minLength: 1,
    })
  ),
  choices: opt(
    arr(ChoiceSchema, {
      description: "Choices to pick from. Leave out for free text.",
      minItems: 1,
    })
  ),
  title: str({ description: "The question.", minLength: 1 }),
});

const AskInputSchema = obj({
  questions: arr(QuestionSchema, {
    description: "Questions to ask in order, one card each.",
    minItems: 1,
  }),
  timeoutSeconds: opt(
    int({
      description: "Seconds to wait for all answers before giving up.",
      minimum: 10,
    })
  ),
});

const AnswerSchema = union([
  obj({ index: int(), kind: lit("chose"), label: str(), question: int() }),
  obj({ kind: lit("typed"), question: int(), text: str() }),
  obj({ kind: lit("rephrase"), question: int() }),
]);

const StopKindSchema = oneOf(["dismissed", "timed_out"]);

const StopSchema = obj({
  kind: StopKindSchema,
  question: int(),
  unasked: int(),
});

const AskDetailsSchema = obj({
  answers: arr(AnswerSchema),
  stop: opt(StopSchema),
});

type Question = Static<typeof QuestionSchema>;

type AskInput = Static<typeof AskInputSchema>;

type Answer = Static<typeof AnswerSchema>;

type Stop = Static<typeof StopSchema>;

type AskDetails = Static<typeof AskDetailsSchema>;

type Surface = "t3" | "terminal";

// The call as the model sent it, before AskInputSchema rejects extra fields.
const RawChoiceSchema = obj({}, { open: true });

const RawQuestionSchema = obj(
  { choices: opt(arr(RawChoiceSchema)) },
  { open: true }
);

const RawAskSchema = obj(
  { questions: opt(arr(RawQuestionSchema)) },
  { open: true }
);

const isRawAsk = compile(RawAskSchema).check;

type RawCall =
  | Static<typeof RawAskSchema>
  | Static<typeof RawQuestionSchema>
  | Static<typeof RawChoiceSchema>;

const FIELDS = {
  choice: new Set(["description", "label"]),
  input: new Set(["questions", "timeoutSeconds"]),
  question: new Set(["body", "choices", "title"]),
};

const FIELD_FIXES = new Map([
  [
    "comment",
    'ask has no "comment": the user can type their own answer on any card',
  ],
  [
    "delivery",
    'ask has no "delivery": every question is asked now and awaited',
  ],
  ["handoff", 'ask has no "handoff": act on the answers after ask returns'],
  ["help", 'ask has no "help": the tool description is the help'],
  [
    "multiple",
    'ask has no "multiple": say in body that the user may pick several',
  ],
  ["prompts", 'Unknown field "prompts": use "questions"'],
]);

const unknownFields = (value: RawCall, known: ReadonlySet<string>): string[] =>
  Object.keys(value).filter((field) => !known.has(field));

// Runs before schema validation so the model gets the fix, not a generic schema error.
const checkFields = (call: Static<typeof RawAskSchema>): void => {
  const [field] = [
    ...unknownFields(call, FIELDS.input),
    ...(call.questions ?? []).flatMap((question) => [
      ...unknownFields(question, FIELDS.question),
      ...(question.choices ?? []).flatMap((choice) =>
        unknownFields(choice, FIELDS.choice)
      ),
    ]),
  ];

  if (field !== undefined) {
    throw new Error(FIELD_FIXES.get(field) ?? `Unknown field "${field}"`);
  }
};

const checkLabels = (questions: readonly Question[]): void => {
  for (const [index, question] of questions.entries()) {
    const labels = (question.choices ?? []).map((choice) =>
      choice.label.trim()
    );

    if (new Set(labels).size !== labels.length) {
      throw new Error(
        `Question ${index + 1} has duplicate choice labels. Give each choice its own label.`
      );
    }

    if (labels.includes(OWN_ANSWER)) {
      throw new Error(
        `Question ${index + 1} uses the reserved label "${OWN_ANSWER}". The user can always type their own answer, so leave that choice out.`
      );
    }
  }
};

const questionText = (question: Question): string => {
  const described = (question.choices ?? []).flatMap((choice) =>
    choice.description === undefined
      ? []
      : [`- **${choice.label}**: ${choice.description}`]
  );

  return [
    question.title,
    ...(question.body === undefined ? [] : [question.body]),
    ...(described.length === 0 ? [] : [described.join("\n")]),
  ].join("\n\n");
};

const labelsOf = (question: Question): string[] =>
  (question.choices ?? []).map((choice) => choice.label);

type Dialog = (
  ui: ExtensionUIContext,
  question: Question,
  options: () => ExtensionUIDialogOptions
) => Promise<string | undefined>;

const DIALOGS: Readonly<Record<Surface, Dialog>> = {
  t3: (ui, question, options) =>
    question.choices === undefined
      ? ui.input(question.title, questionText(question), options())
      : ui.select(questionText(question), labelsOf(question), options()),
  terminal: async (ui, question, options) => {
    if (question.choices === undefined) {
      return ui.input(questionText(question), undefined, options());
    }

    const picked = await ui.select(
      questionText(question),
      [...labelsOf(question), OWN_ANSWER],
      options()
    );

    return picked === OWN_ANSWER
      ? ui.input(question.title, undefined, options())
      : picked;
  },
};

const classify = (reply: string, question: Question, index: number): Answer => {
  const trimmed = reply.trim();

  if (trimmed === "") {
    return { kind: "rephrase", question: index };
  }

  const choice = labelsOf(question).findIndex(
    (label) => label.trim() === trimmed
  );

  if (choice !== -1) {
    return {
      index: choice,
      kind: "chose",
      label: labelsOf(question)[choice] ?? trimmed,
      question: index,
    };
  }

  return { kind: "typed", question: index, text: reply.trimEnd() };
};

const answerLine = (questions: readonly Question[], answer: Answer): string => {
  const question = questions[answer.question];
  const prefix = `${answer.question + 1}. ${question?.title ?? ""}:`;

  if (answer.kind === "chose") {
    return `${prefix} ${answer.label}`;
  }

  if (answer.kind === "rephrase") {
    return `${prefix} empty answer. Rephrase or split the question, then ask again.`;
  }

  return question?.choices === undefined
    ? `${prefix} ${answer.text}`
    : `${prefix} the user typed "${answer.text}" instead of picking. If it is a question or pushback, answer it before you act.`;
};

const stopLine = (stop: Stop, timeoutSeconds: number | undefined): string => {
  const unasked =
    stop.unasked > 0
      ? ` ${stop.unasked} later ${stop.unasked === 1 ? "question was" : "questions were"} not asked.`
      : "";

  return stop.kind === "dismissed"
    ? `The user dismissed question ${stop.question + 1}.${unasked} Stop and wait for their next message.`
    : `No answer to question ${stop.question + 1} within ${timeoutSeconds ?? 0} s.${unasked} Use the default you planned and tell the user which one you used.`;
};

const askTool = defineTool({
  annotations: { readOnlyHint: true },
  description:
    'Ask the user and wait for the answer. Each question becomes one card, asked in order. Put your recommendation first and mark it in the label, e.g. "SQLite (recommended)". Put the reason in `description`, which is shown under the question. The user can always type their own answer instead of picking. To let them pick several, say so in `body`. They will type something like "1 and 3" or "all". Leave out `choices` for free text. If a typed answer is a question or pushback, reply to it before you act. If the user dismisses a card, stop and wait for their next message.',
  execute: async (_toolCallId, params: AskInput, signal, _onUpdate, ctx) => {
    if (!ctx.hasUI) {
      throw new Error(
        "ask needs an interactive client, such as T3 Code or the Pi terminal."
      );
    }

    checkLabels(params.questions);

    const surface: Surface =
      ctx.mode === "rpc" && insideT3() ? "t3" : "terminal";

    const deadline =
      params.timeoutSeconds === undefined
        ? undefined
        : Date.now() + params.timeoutSeconds * 1000;

    // Pi treats a zero timeout as none, so a spent deadline still gets 1 ms.
    const options = (): ExtensionUIDialogOptions =>
      deadline === undefined
        ? { signal }
        : { signal, timeout: Math.max(1, deadline - Date.now()) };

    const askFrom = async (
      index: number,
      answers: readonly Answer[]
    ): Promise<AskDetails> => {
      const question = params.questions[index];

      if (question === undefined) {
        return { answers: [...answers] };
      }

      const reply = await DIALOGS[surface](ctx.ui, question, options);

      // A T3 card has no dismiss button, so the stop button is how a user
      // declines it. Keep the answers given before the stop.
      if (reply === undefined || signal?.aborted) {
        return {
          answers: [...answers],
          stop: {
            kind:
              !signal?.aborted &&
              deadline !== undefined &&
              Date.now() >= deadline - 1000
                ? "timed_out"
                : "dismissed",
            question: index,
            unasked: params.questions.length - index - 1,
          },
        };
      }

      return askFrom(index + 1, [...answers, classify(reply, question, index)]);
    };

    const details = await askFrom(0, []);

    const lines = details.answers.map((answer) =>
      answerLine(params.questions, answer)
    );

    if (details.stop !== undefined) {
      lines.push(stopLine(details.stop, params.timeoutSeconds));
    }

    return {
      content: [{ text: lines.join("\n"), type: "text" }],
      details,
      structuredContent: details,
      terminate: details.stop?.kind === "dismissed",
    };
  },
  executionMode: "sequential",
  label: "Ask",
  name: "ask",
  outputSchema: AskDetailsSchema,
  parameters: AskInputSchema,
  prepareArguments: (args) => {
    if (isRawAsk(args)) {
      checkFields(args);
    }

    // SAFETY: Pi validates the returned arguments against AskInputSchema next.
    return args as AskInput;
  },
  promptGuidelines: [
    "Use ask for every question to the user, including a request for a decision or an approval. Never end a reply with a question in plain text, because nobody answers it there.",
  ],
  promptSnippet:
    "Ask the user for a decision or input and wait for the answer.",
});

export const registerAsk = (pi: ExtensionAPI): void => {
  registerUnlessTaken(pi, askTool);
};

// Only the stop's kind matters here, so another package's ask with more or
// fewer fields on its stop still counts.
const stopped = compile(
  obj({ stop: obj({ kind: StopKindSchema }, { open: true }) }, { open: true })
);

// Whether a call to an `ask` tool, this one or another package's with the
// same result shape, ended without the user's answer.
export const askStopped = (result: {
  readonly details?: unknown;
  readonly structuredContent?: unknown;
  readonly toolName: string;
}): boolean =>
  /(?:^|__)ask$/u.test(result.toolName) &&
  (stopped.check(result.structuredContent) || stopped.check(result.details));
