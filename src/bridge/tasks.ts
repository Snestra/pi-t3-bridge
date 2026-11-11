import { defineTool } from "@earendil-works/pi-coding-agent";
import { arr, bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { renderInlineCard, taskCard, workflowCard } from "./cards.ts";
import { readWorkflow } from "./workflow-store.ts";
import type { Workflow } from "./workflow.ts";

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

const TaskInputSchema = obj({
  explanation: opt(str()),
  steps: opt(arr(TaskStepSchema, { minItems: 1 })),
  workflowId: opt(str({ minLength: 1 })),
});

export const projectWorkflow = (workflow: Workflow): TaskSnapshot => ({
  steps: workflow.steps.map((step) => {
    const integration = step.attempts.at(-1)?.result?.integration;

    const details = [
      step.blocked && `blocked: ${step.blocked.kind} ${step.blocked.id}`,
      integration && `integration: ${integration}`,
    ].filter(Boolean);

    let status: TaskStatus = "pending";

    if (step.state === "succeeded") {
      status = "completed";
    } else if (
      ["running", "waiting_for_user", "waiting_for_child"].includes(step.state)
    ) {
      status = "in_progress";
    }

    return {
      id: step.id,
      status,
      text: `${step.purpose}${details.length ? ` (${details.join(", ")})` : ""}`,
    };
  }),
});

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
    params: Static<typeof TaskInputSchema>,
    _signal,
    _onUpdate,
    ctx
  ) => {
    const workflow = params.workflowId
      ? readWorkflow(ctx, params.workflowId)
      : undefined;

    if (params.workflowId && !workflow) {
      throw new Error("Unknown workflow");
    }

    if (!workflow && !params.steps) {
      throw new Error("Steps are required");
    }

    const snapshot: TaskSnapshot = workflow
      ? projectWorkflow(workflow)
      : { explanation: params.explanation, steps: params.steps ?? [] };

    if (!workflow) {
      checkSnapshot(snapshot);
    }

    const rendered = await renderInlineCard(
      ctx,
      workflow
        ? workflowCard(workflow)
        : taskCard({ ...snapshot, progress: progress(snapshot) })
    );

    const details: TaskToolDetails = { rendered, snapshot };

    return {
      content: [{ text: taskSummary(snapshot), type: "text" }],
      details,
      structuredContent: details,
    };
  },
  label: "Tasks",
  name: "tasks",
  outputSchema: TaskToolDetailsSchema,
  parameters: TaskInputSchema,
  promptSnippet: "Publish the current task list as a card in the chat.",
});
