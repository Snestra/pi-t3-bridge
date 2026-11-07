---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Open a todolist with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners. Use the `arena runners` line in the model sheet. If the sheet or that line is missing, run one each on the defaults in [Models](#models). An `auto` or `inherit-parent` entry in this line means the parent model, so omit `target` for it. If `delegate_task` rejects a configured entry, run that seat on another target of the same family from `orchestrator_capabilities` and say so. A model's family is the first segment of its ID's last `/` part, such as `claude`, `gpt`, or `grok`, whatever provider instance serves it. If the family has no other target, or `delegate_task` rejects that one too, drop the seat and say so. If dropped seats leave fewer than two runners, add runners until there are two, or one when the line has one entry. Run each added runner on a remaining runner's model, or omit `target` so it runs on the parent model when none remain, and say so. Spawn more runners when the arena covers multiple design directions. Use the same model N times when the work is generation-bound rather than judgment-sensitive. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.
4. Give each candidate its own output location (a git worktree where possible, otherwise `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill. On T3 that worktree comes from `isolation: "worktree"`, or from `git worktree add` where poteto-mode's Dispatch on T3 says so.

## Phase B: Fan out

Spawn all N subagents in one message with `mode: "async"`, each with the task, the path to the shared grounding, its own output path, and instructions to produce the artifact and a short rationale naming the alternatives it considered and what it rejected.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, choose one model from the `arena cross-judge pool` line in the model sheet. If the sheet or that line is missing, choose from the `arena cross-judge pool` defaults in [Models](#models). Spawn one judge subagent, briefed to inspect only and change no file. The judge is never from the parent's family, as Phase A step 3 defines families. Try only the entries from another family, in pool order. An `auto` or `inherit-parent` entry is the parent model, so it never judges. Among the entries from another family, try first those whose model ran fewer candidates, so no model scores its own work when another can judge. Pool order decides among entries that ran as many, and the reply says when the judge ran a candidate. With the default runners and pool in [Models](#models), a Claude parent skips the Claude entry and gets the next one, and a parent from any other family gets the Claude entry first. If `delegate_task` rejects an entry, use the same model at the closest reasoning level or speed that `orchestrator_capabilities` lists for it, under any provider instance, or move to the next entry when there is none. If no entry from another family runs, try the default pool's entries from another family the same way. If none of those runs, skip the judge, pick the base alone in Phase D, and say so. If `orchestrator_capabilities` names no `inheritedModel`, try the pool's targets in pool order and say that the family check did not run. The judge sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with your reading in Phase D. Don't spawn it while candidates are still writing.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge when Phase C ran one. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle skill, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict or that Phase C skipped the judge, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.

## Models

Role defaults on T3, stamped from `plugins/pstack/models.json`. A role line in the model sheet overrides each one. The sheet is `~/.config/t3-pstack/models.md` (`$XDG_CONFIG_HOME/t3-pstack/models.md` when that is set), one per machine, and `/setup-pstack` writes it. When it is missing, read `t3-pstack-models.md` in the host's config directory (`$CLAUDE_CONFIG_DIR` or `~/.claude` on Claude Code, `$CODEX_HOME` or `~/.codex` on Codex). An entry is `<providerInstanceId>/<modelId>` plus `<optionId>=<value>` pairs, and it maps onto `delegate_task`'s `target`, with the provider instance as `providerInstanceId`, the model as `model`, and the pairs as `options`. It splits at its first `/`, so a model ID with its own `/`, such as OpenCode's `<provider>/<model>`, is written whole after it. Option IDs differ per provider, so take them from `orchestrator_capabilities`. `inherit-parent` or `auto` omits `target`.

- arena runners: `claudeAgent/claude-opus-5-5 effort=xhigh`, `codex/gpt-6.1-sol reasoningEffort=xhigh`, `grok/grok-4.7 reasoningEffort=xhigh`
- arena cross-judge pool: `claudeAgent/claude-opus-5-5 effort=xhigh`, `codex/gpt-6.1-sol reasoningEffort=xhigh`, `grok/grok-4.7 reasoningEffort=xhigh`
