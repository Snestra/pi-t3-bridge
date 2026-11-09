import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { obj, opt, str } from "@earendil-works/pi-schema";
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

const PLAN_GATE_ENTRY = "pi-t3-plan-gate";

const PLAN_CHOICES = ["Approve", "Revise", "Cancel"] as const;

type PlanChoice = (typeof PLAN_CHOICES)[number];

type PlanGate =
  | { readonly state: "open" }
  | { readonly state: "planning" }
  | { readonly planId: string; readonly state: "awaiting" }
  | { readonly planId: string; readonly state: "revising" }
  | { readonly planId: string; readonly state: "approved" }
  | { readonly planId: string; readonly state: "cancelled" };

const OPEN_GATE: PlanGate = { state: "open" };

const BLOCK_REASONS: Readonly<Partial<Record<PlanGate["state"], string>>> = {
  awaiting:
    "A proposed plan is waiting for the user's approval. Only read-only tools run until the user approves it.",
  cancelled:
    "The user cancelled the plan. Only read-only tools run until the user sends a new message.",
  planning:
    "T3 is in Plan mode. Only read-only tools run. Propose the plan with the `plan` tool; the user approves it from the plan card.",
  revising:
    "The user asked for a revised plan. Only read-only tools run until the user approves a plan through the `plan` tool.",
};

// Codemode runs each nested tool call through tool_call handlers, so the
// calls it makes are checked one by one.
const ALWAYS_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "codemode",
  "find",
  "grep",
  "ls",
  "mcp__t3-code__html_preview",
  "mcp__t3-code__html_render",
  "mcp__t3-code__orchestrator_capabilities",
  "mcp__t3-code__t3_thread_read",
  "mcp__t3__orchestrator_capabilities",
  "mcp__t3__t3_thread_read",
  "read",
  "tool_search",
]);

const isPlanGate = (data: unknown): data is PlanGate => {
  if (data === null || typeof data !== "object" || !("state" in data)) {
    return false;
  }

  return [
    "open",
    "planning",
    "awaiting",
    "revising",
    "approved",
    "cancelled",
  ].includes(String(data.state));
};

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
    ALWAYS_ALLOWED_TOOLS.has(toolName) ||
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
    if (currentGate(ctx).state === "planning") {
      event.systemPromptOptions.sections.t3_plan_mode =
        "T3 Code is in Plan mode for this message. Investigate with read-only tools only; writes, shell commands and delegation are blocked. When the plan is decision complete, call the `plan` tool with it and stop. The user approves it from the plan card.";
    }

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

        const rendered = await renderInlineCard(ctx, {
          ...planCard(title, params.plan),
          title,
        });

        const question = rendered
          ? `Approve "${title}" shown above?`
          : `Approve this plan?\n\n${params.plan}`;

        const answer = await ctx.ui.select(question, [...PLAN_CHOICES]);
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
