---
name: setup-pstack
description: Configure which T3 provider and model pstack uses per role and at what reasoning budget. Detects the models T3 can run and writes the model sheet that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write the model sheet, `~/.config/t3-pstack/models.md` (`$XDG_CONFIG_HOME/t3-pstack/models.md` when that is set), one per machine. It sets pstack's T3 provider and model per role, and every pstack skill reads it before it dispatches.

## Steps

### 1. Detect available models

Call `orchestrator_capabilities`, or `acp-mcp-call orchestrator_capabilities '{}'` where the T3 tools are not exposed. Its provider instances and their models are the dependable source. A target is valid only when its provider instance can run a child task and lists the model. Note each provider's own option IDs and values, such as `effort` on Claude and `reasoningEffort` on Codex and Grok. Never write a target you have not seen there. The aliases `inherit-parent` and `auto` are always valid.

### 2. Load current state

The default role-to-target mapping is the sheet shape in step 5 below. If the sheet already exists, read it and treat its `# budget` line and its role values as the current choices. If it does not, read `t3-pstack-models.md` in the host's config directory (`$CLAUDE_CONFIG_DIR` or `~/.claude` on Claude Code, `$CODEX_HOME` or `~/.codex` on Codex), where releases before 2.0.0-rc.3 kept the sheet, the same way. Otherwise start from those defaults. A line whose role is not in step 5, such as `how critics`, is from a retired role. Drop it. Carry a `strongest judgment` value over to `hardest tasks`, its new name. Also drop any value that is not a T3 entry, such as a bare family name, a `claude-` slug, or an `@<level>` suffix, and a `default effort` line.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Ask a structured multiple-choice question (`AskUserQuestion` on Claude Code, numbered options in plain text elsewhere). Offer these four options with these exact labels, and name the current budget when the sheet records one. With no sheet, say that `large` matches the skill defaults.

- `unlimited - max reasoning`
- `large - xhigh reasoning`
- `medium - high reasoning`
- `small - medium reasoning`

**(b) Apply it.** Build the working table from the defaults, and on a re-run keep any role you changed by provider, list, or alias (`inherit-parent`, `auto`). `unlimited`, `large`, `medium`, and `small` set the reasoning option of every entry, panel entries included, to `max`, `xhigh`, `high`, or `medium`. Use the option ID that provider lists. If the provider does not offer that value, use its highest value at or below the target, else mark the role as needing a choice. So Grok, whose reasoning tops out at `xhigh`, stays at `xhigh` under `unlimited`. `inherit-parent` and `auto` do not change.

**(c) Show the roles and confirm.** Show every role with its entry, marking any target not in the detected set as needing a choice. Also list each line step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected targets plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat's model) as the options. For panel roles (`arena runners`, `architect runners`, `interrogate reviewers`) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. A panel needs at least two model families among its targets. A model's family is the first segment of its ID's last `/` part, such as `claude`, `gpt`, or `grok`. `arena cross-judge pool` is also a list, but Arena runs one judge. It tries only values from a family other than the parent's. Among those it tries first the ones whose model ran fewer candidates, and list order decides among values that ran as many, so order it by preference. An `inherit-parent` or `auto` value never judges. `swarm workers` is the default target for every worker unless a race or comparison assigns another per arm.

**(d) Ask about the session-start hook.** Ask whether t3-pstack's session-start hook should keep telling new chats when to enter `/poteto-mode`. Write `session hook: on` or `session hook: off`.

### 4. Validate

Write the candidate to a temp file. Call `orchestrator_capabilities` again and save its result to a temp file as `{"providers": [...]}`, copying verbatim the entry of every provider instance the candidate or the defaults name. Run `node <plugin root>/skills/setup-pstack/scripts/t3-sheet.mjs <candidate> <catalog.json>`, where `<plugin root>` is the directory that holds this plugin's `skills/`, and fix every line it prints. If `node` is missing, check each entry against the catalog by reading, and say so. A role with no line runs on its default, so add a line for any role whose default this machine cannot run.

### 5. Write the sheet

Overwrite the sheet with the candidate, creating its directory and writing through any symlink at its path (resolve it with `realpath`). If a different file is already there, run the checker on it and ask before you replace it. Overwrite the whole file so re-runs stay idempotent. Then replace `t3-pstack-models.md` in the host's config directory with a link to the sheet (`ln -sf`), so an older t3-pstack reads the same sheet. Step 2 already read what it held. On Codex, remove any pstack model rows an earlier setup pasted into `<codex-home>/AGENTS.md`. With every default kept, the sheet reads:

```markdown
# pstack model configuration (T3). One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto` as a value: the role runs on the parent chat's model (`delegate_task` omits `target`). Alias entries in a panel list still count toward its fan-out.
# budget: large (xhigh)
feature, refactoring: claudeAgent/claude-opus-5-5 effort=xhigh
bug-fix: claudeAgent/claude-fable-5-1 effort=xhigh
perf-issue: claudeAgent/claude-fable-5-1 effort=xhigh
hillclimb: claudeAgent/claude-fable-5-1 effort=xhigh
judgment and prose: claudeAgent/claude-opus-5-5 effort=xhigh
hardest tasks: claudeAgent/claude-fable-5-1 effort=xhigh
how explorer: claudeAgent/claude-opus-5-5 effort=xhigh
how explainer: claudeAgent/claude-opus-5-5 effort=xhigh
why investigators: claudeAgent/claude-opus-5-5 effort=xhigh
why synthesizer: claudeAgent/claude-opus-5-5 effort=xhigh
reflect tooling: claudeAgent/claude-opus-5-5 effort=xhigh
reflect judgment, divergent, synthesizer: claudeAgent/claude-opus-5-5 effort=xhigh
arena runners: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh, grok/grok-4.7 reasoningEffort=xhigh
arena cross-judge pool: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh, grok/grok-4.7 reasoningEffort=xhigh
swarm workers: claudeAgent/claude-opus-5-5 effort=xhigh
architect runners: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh, grok/grok-4.7 reasoningEffort=xhigh
interrogate reviewers: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh, grok/grok-4.7 reasoningEffort=xhigh
session hook: on
```

### 6. Confirm

Tell the user the sheet was written and that it applies to new sessions. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, read [`../create-verification-skill/SKILL.md`](../create-verification-skill/SKILL.md) from this file and follow it. Do not call the Skill tool for it, since that tool refuses a skill only the user may invoke. On no, move on without pushing.

### 8. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, a proof, or another verifier against the code). If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with /create-formal-verification-skill." On yes, read [`../create-formal-verification-skill/SKILL.md`](../create-formal-verification-skill/SKILL.md) from this file and follow it. Do not call the Skill tool for it, since that tool refuses a skill only the user may invoke. On no, move on without pushing.
