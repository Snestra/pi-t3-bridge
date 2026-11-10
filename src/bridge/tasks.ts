import { defineTool } from "@earendil-works/pi-coding-agent";
import { arr, bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { renderInlineCard, taskCard } from "./cards.ts";

const TaskStatusSchema = oneOf(["pending", "in_progress", "completed"]);

const TaskStepSchema = obj(
  {
    id: str({
      description: "Stable ID for this step. Keep it the same across updates.",
      minLength: 1,
    }),
    status: TaskStatusSchema,
    text: str({ description: "What the step does.", minLength: 1 }),
  },
  { open: true }
);

const TaskSnapshotSchema = obj(
  {
    explanation: opt(
      str({ description: "Optional note about why the list changed." })
    ),
    steps: arr(TaskStepSchema, {
      description:
        "The complete task list. Each call replaces the previous list.",
      minItems: 1,
    }),
  },
  { open: true }
);

type TaskStatus = Static<typeof TaskStatusSchema>;

type TaskSnapshot = Static<typeof TaskSnapshotSchema>;

const WORDS: Readonly<Record<TaskStatus, string>> = {
  completed: "done",
  in_progress: "doing",
  pending: "todo",
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

const progress = (snapshot: TaskSnapshot): string =>
  `${snapshot.steps.filter((step) => step.status === "completed").length} of ${snapshot.steps.length} complete`;

const taskSummary = (snapshot: TaskSnapshot): string =>
  [
    `Tasks: ${progress(snapshot)}`,
    ...snapshot.steps.map((step) => `[${WORDS[step.status]}] ${step.text}`),
  ].join("\n");

const TaskToolDetailsSchema = obj(
  { rendered: bool(), snapshot: TaskSnapshotSchema },
  { open: true }
);

type TaskToolDetails = Static<typeof TaskToolDetailsSchema>;

export const tasksTool = defineTool({
  annotations: { readOnlyHint: true },
  description:
    "Publish the current task list for this run. Send the complete list every time, with stable step ids and at most one step in_progress. T3 shows the list as a task card in the chat.",
  execute: async (
    _toolCallId,
    params: Static<typeof TaskSnapshotSchema>,
    _signal,
    _onUpdate,
    ctx
  ) => {
    checkSnapshot(params);

    const rendered = await renderInlineCard(
      ctx,
      taskCard({ ...params, progress: progress(params) })
    );

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
