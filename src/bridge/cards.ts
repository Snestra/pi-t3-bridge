import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Marked } from "marked";
import { render } from "pele";

import type { GoalAcceptanceSnapshot } from "./goal.ts";
import { findT3Tool } from "./t3-tasks.ts";
import type { GoalExecutionState } from "./t3-tasks.ts";
import { workflowAccepted } from "./workflow.ts";
import type { Workflow } from "./workflow.ts";

const MIN_FRAME_HEIGHT = 80;
const MAX_FRAME_HEIGHT = 2000;

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const STYLE = `
body{margin:0;font-family:var(--font-sans);color:var(--foreground);font-size:0.875rem;line-height:1.5}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px}
.head h1{font-weight:600;font-size:inherit;margin:0}.muted{color:var(--muted-foreground)}
.head h1,.note,.text{min-width:0;overflow-wrap:break-word}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.card>ol{list-style:none;margin:0;padding:0}.card>ol>li{display:flex;gap:10px;padding:4px 0}
.dot{width:16px;flex:none;text-align:center;color:var(--muted-foreground)}
.completed .dot{color:var(--success)}.completed .text{color:var(--muted-foreground);text-decoration:line-through}
.in_progress .dot{color:var(--info)}.in_progress .text{font-weight:600}
.note{margin:0 0 10px;color:var(--muted-foreground)}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--font-mono);font-size:0.875rem;background:var(--code-background);color:var(--code-foreground);border-radius:var(--radius);padding:12px}
.md{min-width:0;overflow-wrap:break-word}.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md p,.md ol,.md ul,.md pre,.md blockquote,.md table{margin:0 0 10px}.md ol,.md ul{padding-left:20px}
.md code{font-family:var(--font-mono);background:var(--code-background);border-radius:4px;padding:1px 4px}
.md pre code{padding:0;background:none}.md a{color:var(--primary)}
.diagram{margin:0 0 10px;display:flex;justify-content:center}
.pele{--pele-bg:var(--card);--pele-fg:var(--foreground);--pele-muted:var(--muted-foreground);--pele-line:var(--muted-foreground);--pele-surface:var(--secondary);--pele-surface-alt:var(--accent);--pele-border:color-mix(in srgb,var(--foreground) 28%,transparent);--pele-accent:var(--primary);--pele-font:var(--font-sans)}
.diagram-error p{color:var(--destructive);margin:0 0 6px}
*{box-sizing:border-box}.head{flex-wrap:wrap}.snapshot p{white-space:pre-wrap;overflow-wrap:anywhere}.snapshot details{border-top:1px solid var(--border);margin-top:12px;padding-top:8px}.snapshot summary{cursor:pointer;padding:8px 0;overflow-wrap:anywhere}.snapshot summary:focus-visible,.snapshot a:focus-visible{outline:2px solid var(--ring);outline-offset:3px}.snapshot h2{font-size:inherit;margin:16px 0 8px}.snapshot code{font-family:var(--font-mono);overflow-wrap:anywhere}.snapshot a{color:var(--primary)}.snapshot ul{padding-inline-start:20px}.snapshot li{margin:8px 0;overflow-wrap:anywhere}.snapshot .metadata{font-size:0.8rem;color:var(--muted-foreground)}.snapshot .attention{border-inline-start:3px solid var(--warning);padding-inline-start:12px}.snapshot pre{margin:8px 0}.snapshot .md p{white-space:normal}
`;

// Height estimates follow STYLE: 21 px per line of text at 0.875rem and 1.5
// line height, with the card padding and heading on top.
const LINE_PX = 21;

const wrappedLines = (text: string, charsPerLine: number): number =>
  text
    .split("\n")
    .reduce(
      (lines, segment) =>
        lines + Math.max(1, Math.ceil(segment.length / charsPerLine)),
      0
    );

const DIAGRAM_MARGIN = 10;
const WEB_LINK = /^(?:https?:\/\/|t3-thread:\/\/v2\/)/iu;

interface MarkdownResult {
  readonly diagramHeight: number;
  readonly html: string;
  readonly prose: string;
}

const markdownHtml = (markdown: string): MarkdownResult => {
  let diagramHeight = 0;
  let prose = markdown;

  const marked = new Marked({
    renderer: {
      code(token) {
        if (token.lang !== "mermaid") {
          return `<pre><code>${escapeHtml(token.text)}</code></pre>`;
        }

        try {
          const drawn = render(token.text, {
            autoDirection: false,
            images: false,
            links: false,
          });

          diagramHeight += drawn.height + DIAGRAM_MARGIN;
          prose = prose.replace(token.raw, "");

          return `<figure class="diagram">${drawn.svg}</figure>`;
        } catch (error) {
          const reason =
            error instanceof Error ? error.message.split("\n")[0] : "";

          return `<div class="diagram-error"><p>The diagram could not be drawn: ${escapeHtml(reason ?? "")}</p><pre>${escapeHtml(token.text)}</pre></div>`;
        }
      },
      html: (token) => escapeHtml(token.text),
      image: (token) => escapeHtml(token.text),
      link(token) {
        const text = this.parser.parseInline(token.tokens);

        return WEB_LINK.test(token.href)
          ? `<a href="${escapeHtml(token.href)}">${text}</a>`
          : text;
      },
      text: (token) =>
        "escaped" in token && token.escaped ? escapeHtml(token.text) : false,
    },
  });

  const html = marked.parse(markdown, { async: false });

  return { diagramHeight, html, prose };
};

const pageHtml = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

const frameHeight = (estimate: number): number =>
  Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(estimate)));

interface InlineCard {
  readonly height: number;
  readonly html: string;
  readonly title: string;
}

export const planCard = (title: string, plan: string): InlineCard => {
  const { diagramHeight, html, prose } = markdownHtml(plan);

  return {
    height: frameHeight(
      70 +
        wrappedLines(title, 40) * LINE_PX +
        wrappedLines(prose, 30) * LINE_PX +
        diagramHeight
    ),
    html: pageHtml(
      title,
      `<main class="card"><div class="head"><h1>${escapeHtml(title)}</h1></div><div class="md">${html}</div></main>`
    ),
    title,
  };
};

// The step classes are the task statuses STYLE colors.
type StepStatus = "completed" | "in_progress" | "pending";

const STEP_LOOK: Readonly<
  Record<StepStatus, { readonly label: string; readonly mark: string }>
> = {
  completed: { label: "Completed", mark: "✓" },
  in_progress: { label: "In progress", mark: "●" },
  pending: { label: "Pending", mark: "○" },
};

export const taskCard = (list: {
  readonly explanation?: string | undefined;
  readonly progress: string;
  readonly steps: readonly {
    readonly status: StepStatus;
    readonly text: string;
  }[];
}): InlineCard => {
  const note =
    list.explanation === undefined
      ? ""
      : `<p class="note">${escapeHtml(list.explanation)}</p>`;

  const items = list.steps
    .map(
      (step) =>
        `<li class="${step.status}"><span class="dot" aria-hidden="true">${STEP_LOOK[step.status].mark}</span><span class="text"><span class="sr-only">${STEP_LOOK[step.status].label}: </span>${escapeHtml(step.text)}</span></li>`
    )
    .join("");

  const height =
    75 +
    (list.explanation === undefined
      ? 0
      : wrappedLines(list.explanation, 38) * LINE_PX + 10) +
    list.steps.reduce(
      (sum, step) => sum + wrappedLines(step.text, 38) * LINE_PX + 8,
      0
    );

  return {
    height: frameHeight(height),
    html: pageHtml(
      "Tasks",
      `<main class="card"><div class="head"><h1>Tasks</h1><span class="muted">${escapeHtml(list.progress)}</span></div>${note}<ol>${items}</ol></main>`
    ),
    title: "Tasks",
  };
};

export const goalCard = (goal: {
  readonly acceptance?: GoalAcceptanceSnapshot;
  readonly objective: string;
  readonly status: string;
  readonly revision: number;
  readonly reason: string | null;
  readonly nextAction: {
    readonly tool: string;
    readonly instruction: string;
  } | null;
  readonly noProgressCycles: number;
  readonly conditions: readonly {
    readonly id: string;
    readonly text: string;
  }[];
  readonly execution: GoalExecutionState;
  readonly evidence: readonly {
    readonly requirement: string;
    readonly kind: string;
    readonly source: string;
    readonly result: string;
    readonly observedAt: number;
    readonly revision: number;
  }[];
}): InlineCard => {
  const rows = [
    `Status: ${goal.status}. Revision ${goal.revision}. No-progress cycles ${goal.noProgressCycles}.`,
    `Full user objective\n${goal.objective}`,
    "Agent-proposed acceptance conditions (additional to the objective)",
    ...goal.conditions.map((condition) => `${condition.id}: ${condition.text}`),
    ...goal.evidence.map(
      (item) =>
        `${item.requirement} [${item.kind}] ${item.source}, revision ${item.revision}, ${new Date(item.observedAt).toISOString()}\n${item.result}`
    ),
    ...goal.execution.children.map(
      (child) =>
        `Child ${child.taskId ?? child.requestId}: ${child.cancellationPending ? "cancellation pending" : child.disposition}${child.task?.link ? ` ${child.task.link}` : ""}`
    ),
    goal.execution.reconciliationRequired
      ? "Child state needs reconciliation."
      : "",
    `Next action: ${goal.nextAction ? `${goal.nextAction.tool}: ${goal.nextAction.instruction}` : "None"}`,
    goal.reason ?? "",
  ];

  const text = rows.join("\n\n");

  return {
    height: frameHeight(80 + wrappedLines(text, 38) * LINE_PX),
    html: pageHtml(
      "Goal",
      `<main class="card snapshot"><div class="head"><h1>Goal</h1><span>${escapeHtml(goal.status)}</span></div>
      <p class="metadata">Snapshot · Revision ${goal.revision} · No-progress cycles ${goal.noProgressCycles}</p>
      <p>${escapeHtml(goal.objective)}</p>
      ${goal.reason ? `<p class="attention">${escapeHtml(goal.reason)}</p>` : ""}
      <p>Next action: ${escapeHtml(goal.nextAction ? `${goal.nextAction.tool}: ${goal.nextAction.instruction}` : "None")}</p>
      <details><summary>Acceptance conditions (${goal.conditions.length})</summary>
      <p>${goal.acceptance ? `Criteria revision ${goal.acceptance.criteriaRevision}. ${goal.acceptance.approved ? "Mapping approved by user." : "Mapping needs approval."}` : "Mapping approval not supplied."}</p>
      <p class="metadata">Approval covers the mapping from the original objective to these conditions. Evidence must still satisfy each condition.</p>
      <ul>${goal.conditions.map((condition) => `<li><code>${escapeHtml(condition.id)}</code><p>${escapeHtml(condition.text)}</p></li>`).join("")}</ul>
      ${goal.acceptance ? `<pre>${escapeHtml(JSON.stringify(goal.acceptance.conditions, null, 2))}</pre>` : ""}</details>
      <details><summary>Linked evidence (${goal.evidence.length})</summary>
      <p class="metadata">These are recorded evidence entries, not a claim that every condition has passed.</p>
      ${goal.evidence.map((item) => `<details><summary>${escapeHtml(item.requirement)} · ${escapeHtml(item.kind)}</summary><p class="metadata">Revision ${item.revision} · ${escapeHtml(new Date(item.observedAt).toISOString())}</p><p>${escapeHtml(item.source)}</p><pre>${escapeHtml(item.result)}</pre></details>`).join("")}</details>
      <details${goal.execution.pending || goal.execution.reconciliationRequired ? " open" : ""}><summary>Children (${goal.execution.children.length})</summary>
      ${goal.execution.reconciliationRequired ? '<p class="attention">Child state needs reconciliation.</p>' : ""}
      ${goal.execution.children.map((child) => `<details><summary>${escapeHtml(child.stepId)} · ${child.cancellationPending ? "Cancellation pending" : escapeHtml(child.disposition)}</summary><p class="metadata">Workflow ${escapeHtml(child.workflowId)} · ${escapeHtml(child.taskId ?? child.requestId)}</p><p>${escapeHtml([child.task?.providerInstanceId, child.task?.model, child.task?.workState].filter(Boolean).join(" · "))}</p>${child.needsStatus ? "<p>Completion wake needs reconciliation.</p>" : ""}<div class="md">${markdownHtml(child.task?.link ?? "").html}</div>${child.task?.summary ? `<pre>${escapeHtml(child.task.summary)}</pre>` : ""}</details>`).join("")}</details>
      </main>`
    ),
    title: "Goal",
  };
};

export const workflowCard = (workflow: Workflow): InlineCard => {
  const steps = workflow.steps
    .map((step) => {
      const attempt = step.attempts.at(-1);
      const result = attempt?.result;

      return `<details><summary>${escapeHtml(step.purpose)} · ${escapeHtml(step.state)}</summary>
      <p class="metadata">Step ${escapeHtml(step.id)} · ${escapeHtml(step.executor.kind)} · ${escapeHtml(step.executor.isolation)}</p>
      <p>Dependencies: ${escapeHtml(step.dependencies.join(", ") || "None")}</p>
      ${step.blocked ? `<p class="attention">Blocked by ${escapeHtml(step.blocked.kind)}: ${escapeHtml(step.blocked.id)}</p>` : ""}
      <p>Acceptance conditions: ${escapeHtml(step.acceptance.join(", "))}</p>
      <p>Attempts: ${step.attempts.length}${attempt ? ` · ${escapeHtml(attempt.launch)}` : ""}</p>
      ${attempt?.cancellationPending ? '<p class="attention">Cancellation pending</p>' : ""}
      <div class="md">${markdownHtml(attempt?.task?.link ?? result?.childLink ?? "").html}</div>
      ${result ? `<pre>${escapeHtml(result.summary)}</pre><p>Integration: ${escapeHtml(result.integration)}</p><details><summary>Evidence and artifacts</summary><pre>${escapeHtml(JSON.stringify({ artifacts: result.artifacts, checkout: result.checkout, evidence: result.evidence, integrationEvidence: result.integrationEvidence }, null, 2))}</pre></details>` : ""}
      <details><summary>Attempt history</summary><pre>${escapeHtml(JSON.stringify(step.attempts, null, 2))}</pre></details>
      </details>`;
    })
    .join("");

  return {
    height: frameHeight(180 + workflow.steps.length * 60),
    html: pageHtml(
      "Workflow",
      `<main class="card snapshot"><div class="head"><h1>Workflow</h1><span>${workflowAccepted(workflow) ? "Accepted" : "Acceptance pending"}</span></div><p class="metadata">Snapshot · ${escapeHtml(workflow.id)} · Revision ${workflow.revision}</p>${steps}</main>`
    ),
    title: "Workflow",
  };
};

export const renderInlineCard = async (
  ctx: ExtensionToolContext,
  card: InlineCard
): Promise<boolean> => {
  const tool = findT3Tool(ctx.tools, "html_render");

  if (tool === undefined) {
    return false;
  }

  const outcome = await ctx.executeTool(tool, card);

  return !outcome.isError;
};
