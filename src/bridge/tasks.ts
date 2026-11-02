import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

import {
  escapeHtml,
  frameHeight,
  pageHtml,
  renderInlineCard,
  wrappedLines,
} from "./cards.ts";

const TaskStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
]);

const TaskStepSchema = Type.Object({
  id: Type.String({
    description: "Stable ID for this step. Keep it the same across updates.",
    minLength: 1,
  }),
  status: TaskStatusSchema,
  text: Type.String({ description: "What the step does.", minLength: 1 }),
});

const TaskSnapshotSchema = Type.Object({
  explanation: Type.Optional(
    Type.String({ description: "Optional note about why the list changed." })
  ),
  steps: Type.Array(TaskStepSchema, {
    description:
      "The complete task list. Each call replaces the previous list.",
    minItems: 1,
  }),
});

type TaskStatus = Static<typeof TaskStatusSchema>;

type TaskSnapshot = Static<typeof TaskSnapshotSchema>;

interface TaskProgress {
  readonly completed: number;
  readonly total: number;
}

interface StatusPresentation {
  readonly label: string;
  readonly mark: string;
  readonly word: string;
}

const STATUS_PRESENTATION: Readonly<Record<TaskStatus, StatusPresentation>> = {
  completed: { label: "Completed", mark: "✓", word: "done" },
  in_progress: { label: "In progress", mark: "●", word: "doing" },
  pending: { label: "Pending", mark: "○", word: "todo" },
};

const checkSnapshot = (snapshot: TaskSnapshot): void => {
  const ids = new Set(snapshot.steps.map((step) => step.id));

  if (ids.size !== snapshot.steps.length) {
    throw new Error("Each task step needs a unique id.");
  }

  const running = snapshot.steps.filter(
    (step) => step.status === "in_progress"
  );

  if (running.length > 1) {
    throw new Error("Only one task step can be in_progress at a time.");
  }
};

const taskProgress = (snapshot: TaskSnapshot): TaskProgress => ({
  completed: snapshot.steps.filter((step) => step.status === "completed")
    .length,
  total: snapshot.steps.length,
});

const taskSummary = (snapshot: TaskSnapshot): string => {
  const progress = taskProgress(snapshot);

  const lines = snapshot.steps.map(
    (step) => `[${STATUS_PRESENTATION[step.status].word}] ${step.text}`
  );

  return [
    `Tasks: ${progress.completed} of ${progress.total} complete`,
    ...lines,
  ].join("\n");
};

const taskCardHtml = (snapshot: TaskSnapshot): string => {
  const progress = taskProgress(snapshot);

  const note =
    snapshot.explanation === undefined
      ? ""
      : `<p class="note">${escapeHtml(snapshot.explanation)}</p>`;

  const items = snapshot.steps
    .map(
      (step) =>
        `<li class="${step.status}"><span class="dot" aria-hidden="true">${STATUS_PRESENTATION[step.status].mark}</span><span class="text"><span class="sr-only">${STATUS_PRESENTATION[step.status].label}: </span>${escapeHtml(step.text)}</span></li>`
    )
    .join("");

  return pageHtml(
    "Tasks",
    `<main class="card"><div class="head"><h1>Tasks</h1><span class="muted">${progress.completed} of ${progress.total} complete</span></div>${note}<ol>${items}</ol></main>`
  );
};

const taskCardHeight = (snapshot: TaskSnapshot): number => {
  let height = 75;

  if (snapshot.explanation !== undefined) {
    height += wrappedLines(snapshot.explanation, 38) * 21 + 10;
  }

  for (const step of snapshot.steps) {
    height += wrappedLines(step.text, 38) * 21 + 8;
  }

  return height;
};

const TaskToolDetailsSchema = Type.Object({
  rendered: Type.Boolean(),
  snapshot: TaskSnapshotSchema,
});

type TaskToolDetails = Static<typeof TaskToolDetailsSchema>;

export const tasksTool = defineTool({
  annotations: { readOnlyHint: true },
  description:
    "Publish the current task list for this run. Send the complete list every time, with stable step ids and at most one step in_progress. T3 shows the list as a task card in the chat.",
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    checkSnapshot(params);

    const rendered = await renderInlineCard(ctx, {
      height: frameHeight(taskCardHeight(params)),
      html: taskCardHtml(params),
      title: "Tasks",
    });

    const details: TaskToolDetails = { rendered, snapshot: params };

    return {
      content: [{ text: taskSummary(params), type: "text" }],
      details,
      structuredContent: details,
    };
  },
  label: "Tasks",
  name: "tasks",
  outputSchema: TaskToolDetailsSchema,
  parameters: TaskSnapshotSchema,
  promptSnippet: "Publish the current task list as a card in the chat.",
});
