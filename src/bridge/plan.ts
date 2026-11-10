import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  compile,
  lit,
  obj,
  oneOf,
  opt,
  str,
  union,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import {
  escapeHtml,
  frameHeight,
  markdownHtml,
  pageHtml,
  renderInlineCard,
  wrappedLines,
} from "./cards.ts";
import { registerUnlessTaken } from "./claim.ts";
import { isT3Tool } from "./t3-tasks.ts";

const PLAN_GATE_ENTRY = "pi-t3-plan-gate";

const PLAN_CHOICES = ["Approve", "Revise", "Cancel"] as const;

type PlanChoice = (typeof PLAN_CHOICES)[number];

const PlanGateSchema = union([
  obj({ state: lit("open") }, { open: true }),
  obj(
    {
      planId: str(),
      state: oneOf(["awaiting", "revising", "approved", "cancelled"]),
    },
    { open: true }
  ),
]);

type PlanGate = Static<typeof PlanGateSchema>;

const isPlanGate = compile(PlanGateSchema).check;

const OPEN_GATE: PlanGate = { state: "open" };

const BLOCK_REASONS: Readonly<Partial<Record<PlanGate["state"], string>>> = {
  awaiting:
    "A proposed plan is waiting for the user's approval. Only read-only tools run until the user approves it.",
  cancelled:
    "The user cancelled the plan. Only read-only tools run until the user sends a new message.",
  revising:
    "The user asked for a revised plan. Only read-only tools run until the user approves a plan through the `plan` tool.",
};

// Tools Pi or T3 declare without a readOnlyHint that change no files.
// Codemode runs each nested tool call through tool_call handlers, so the
// calls it makes are checked one by one.
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "codemode",
  "find",
  "grep",
  "ls",
  "read",
  "tool_search",
]);

const READ_ONLY_T3_TOOLS = [
  "html_preview",
  "html_render",
  "orchestrator_capabilities",
  "t3_thread_read",
];

const currentGate = (ctx: ExtensionContext): PlanGate => {
  const entries = ctx.sessionManager.getBranch();

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (
      entry?.type === "custom" &&
      entry.customType === PLAN_GATE_ENTRY &&
      isPlanGate(entry.data)
    ) {
      return entry.data;
    }
  }

  return OPEN_GATE;
};

export const planBlocked = (ctx: ExtensionContext): boolean =>
  BLOCK_REASONS[currentGate(ctx).state] !== undefined;

const isPlanChoice = (value: string | undefined): value is PlanChoice =>
  PLAN_CHOICES.some((choice) => choice === value);

interface PlanCard {
  readonly height: number;
  readonly html: string;
}

const planCard = (title: string, plan: string): PlanCard => {
  const { diagramHeight, html, prose } = markdownHtml(plan);

  return {
    height: frameHeight(
      70 +
        wrappedLines(title, 40) * 21 +
        wrappedLines(prose, 30) * 21 +
        diagramHeight
    ),
    html: pageHtml(
      title,
      `<main class="card"><div class="head"><h1>${escapeHtml(title)}</h1></div><div class="md">${html}</div></main>`
    ),
  };
};

const PlanSchema = obj(
  {
    plan: str({
      description: "The plan in Markdown, as numbered steps.",
      minLength: 1,
    }),
    title: opt(str({ description: "Short plan title.", minLength: 1 })),
  },
  { open: true }
);

interface PlanToolDetails {
  readonly choice: PlanChoice | "dismissed";
  readonly feedback?: string;
  readonly planId: string;
}

export const registerPlanGate = (pi: ExtensionAPI): void => {
  const setGate = (gate: PlanGate): void => {
    pi.appendEntry(PLAN_GATE_ENTRY, gate);
  };

  const readOnly = (toolName: string): boolean =>
    READ_ONLY_TOOLS.has(toolName) ||
    READ_ONLY_T3_TOOLS.some((name) => isT3Tool(toolName, name)) ||
    pi
      .getAllTools()
      .some(
        (tool) =>
          tool.name === toolName && tool.annotations?.readOnlyHint === true
      );

  pi.on("tool_call", (event, ctx) => {
    const reason = BLOCK_REASONS[currentGate(ctx).state];

    if (reason === undefined || readOnly(event.toolName)) {
      return;
    }

    return { block: true, reason };
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (
      event.messageType === "user" &&
      currentGate(ctx).state === "cancelled"
    ) {
      setGate(OPEN_GATE);
    }
  });

  registerUnlessTaken(
    pi,
    defineTool({
      annotations: { readOnlyHint: true },
      description:
        "Ask the user to approve a plan before any file changes. Until the user approves, only read-only tools run. On Revise, change the plan and call this tool again. On Cancel, stop: only read-only tools run until the user's next message.",
      execute: async (
        toolCallId,
        params: Static<typeof PlanSchema>,
        _signal,
        _onUpdate,
        ctx
      ) => {
        if (!ctx.hasUI) {
          throw new Error(
            "Plan approval needs an interactive client, such as T3 Code or the Pi terminal."
          );
        }

        const title = params.title ?? "Proposed plan";

        setGate({ planId: toolCallId, state: "awaiting" });

        let answer: string | undefined;

        try {
          const rendered = await renderInlineCard(ctx, {
            ...planCard(title, params.plan),
            title,
          });

          const question = rendered
            ? `Approve "${title}" shown above?`
            : `Approve this plan?\n\n${params.plan}`;

          answer = await ctx.ui.select(question, [...PLAN_CHOICES]);
        } catch (error) {
          // No card is waiting for the user, so nothing may stay blocked.
          setGate(OPEN_GATE);
          throw error;
        }

        const choice = isPlanChoice(answer) ? answer : "Cancel";

        if (choice === "Approve") {
          setGate({ planId: toolCallId, state: "approved" });

          const details: PlanToolDetails = { choice, planId: toolCallId };

          return {
            content: [
              {
                text: "The user approved the plan. Carry it out now.",
                type: "text",
              },
            ],
            details,
          };
        }

        if (choice === "Revise") {
          const feedback =
            (await ctx.ui.input("What should change in the plan?")) ?? "";

          setGate({ planId: toolCallId, state: "revising" });

          const details: PlanToolDetails = {
            choice,
            feedback,
            planId: toolCallId,
          };

          return {
            content: [
              {
                text: `The user asked for a revised plan. Feedback: ${feedback.length > 0 ? feedback : "none given"}. Revise the plan and call the \`plan\` tool again. Only read-only tools run until the user approves.`,
                type: "text",
              },
            ],
            details,
          };
        }

        setGate({ planId: toolCallId, state: "cancelled" });

        const details: PlanToolDetails = {
          choice: answer === undefined ? "dismissed" : choice,
          planId: toolCallId,
        };

        return {
          content: [
            {
              text: "The user cancelled the plan. Stop and wait for the user's next message.",
              type: "text",
            },
          ],
          details,
          terminate: true,
        };
      },
      executionMode: "sequential",
      label: "Plan",
      name: "plan",
      parameters: PlanSchema,
      promptSnippet: "Ask the user to approve a plan before changing files.",
    })
  );
};
