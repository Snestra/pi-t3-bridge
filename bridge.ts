import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerAccounts } from "./src/bridge/accounts.ts";
import { registerAsk } from "./src/bridge/ask.ts";
import { registerBashTimeout } from "./src/bridge/bash-timeout.ts";
import { registerUnlessTaken } from "./src/bridge/claim.ts";
import { registerConfig } from "./src/bridge/config.ts";
import {
  goalAllowsExecution,
  readGoal,
  registerGoal,
} from "./src/bridge/goal.ts";
import { registerPlanGate } from "./src/bridge/plan.ts";
import { registerReplyCheck } from "./src/bridge/reply-check.ts";
import { registerResume } from "./src/bridge/resume.ts";
import { registerSkills } from "./src/bridge/skills.ts";
import { moveOldState } from "./src/bridge/state.ts";
import { createT3Execution } from "./src/bridge/t3-execution.ts";
import { registerT3Mcp } from "./src/bridge/t3-mcp.ts";
import { registerTaskOutcomes } from "./src/bridge/t3-tasks.ts";
import { tasksTool } from "./src/bridge/tasks.ts";
import { registerTranscript } from "./src/bridge/transcript.ts";
import { registerUsage } from "./src/bridge/usage.ts";
import { createWorkflowStore } from "./src/bridge/workflow-store.ts";
import { registerWorkflowTools } from "./src/bridge/workflow-tools.ts";

// The Pi to T3 bridge. It imports only src/bridge and npm packages, so it runs
// on its own when the other extension in this package is turned off.
const piT3Bridge = (pi: ExtensionAPI): void => {
  moveOldState();
  registerConfig(pi);
  registerTranscript(pi);
  registerUnlessTaken(pi, tasksTool);
  registerTaskOutcomes(pi);
  const workflowStore = createWorkflowStore(pi);

  const execution = createT3Execution(pi, workflowStore, {
    allows: goalAllowsExecution,
    read: readGoal,
  });

  registerWorkflowTools(pi, workflowStore, execution.authorize);
  registerBashTimeout(pi);
  registerSkills(pi);
  registerPlanGate(pi);
  registerAsk(pi);
  registerT3Mcp(pi);
  registerUsage(pi);

  const goal = registerGoal(pi, execution);

  registerResume(pi, goal.recover);

  const accounts = registerAccounts(pi, goal.identity);

  // A failed run schedules its resume before the goal settles, so the goal
  // waits for the resume instead of reporting the failure as a blocker.
  pi.on("agent_settled", async (event, ctx) => {
    await accounts.settle(event, ctx);
    goal.settle(event, ctx);
  });

  registerReplyCheck(pi);
};

export default piT3Bridge;
