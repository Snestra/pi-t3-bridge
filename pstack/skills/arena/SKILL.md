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
3. Pick the runners. Call `pstack_model` with `arena runners` and run one seat per returned target. If it returns `blocked`, record its reason and stop the arena. Spawn more runners when the arena covers multiple design directions. Use the same model N times when the work is generation-bound rather than judgment-sensitive. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.
4. Give each candidate its own output location (a git worktree where possible, otherwise `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill. On T3 that worktree comes from `isolation: "worktree"`, or from `git worktree add` where poteto-mode's Dispatch on T3 says so. T3 makes an isolated worktree only once the candidate starts, so its brief names its own worktree as its output location, and its reply names the path.

## Phase B: Fan out

Spawn all N subagents in one message with `mode: "async"`, each with the task, the path to the shared grounding, its own output path, and instructions to produce the artifact and a short rationale naming the alternatives it considered and what it rejected.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, call `pstack_model` with `arena cross-judge pool`. Spawn one judge subagent, briefed to inspect only and change no file. The judge is never from the parent's family, the family of `orchestrator_capabilities`' `inheritedModel`. A model's family is the first segment of its ID's last `/` part, such as `claude`, `gpt`, or `grok`, whatever provider instance serves it. Try only the returned targets from another family, in the order returned. An `inherit-parent` target is the parent model, so it never judges. Among the targets from another family, try first those whose model ran fewer candidates, so no model scores its own work when another can judge. Return order decides among targets that ran as many, and the reply says when the judge ran a candidate. If `delegate_task` rejects a target, use the same model at the closest lower reasoning level that `orchestrator_capabilities` lists for it, under any provider instance, or move to the next target when there is none. If `pstack_model` returns `blocked`, or no target from another family runs, skip the judge, pick the base alone in Phase D, and say so. If `orchestrator_capabilities` names no `inheritedModel`, try the targets in the order returned and say that the family check did not run. The judge sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with your reading in Phase D. Don't spawn it while candidates are still writing.

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

Get every target from the `pstack_model` tool. Pass the role name plus the job type and size from the routing table in poteto-mode's Subagents section. This skill's spawns are `design` jobs, and the cross-judge a `review` job. Write every brief from `<plugin root>/skills/poteto-mode/brief.md`: the extension refuses a `delegate_task` call whose brief is missing its sections or limits. Without a job, pass the complexity: `groundwork` for cheap mechanical work, `bounded` for involved but bounded work, `general` for work that needs substantial judgment. The tool reads the role's line in the model sheet (`~/.config/t3-pstack/models.md`, written by `/setup-pstack`). A line naming a model is used as written, moved to a provider T3 can run right now when needed. A role with no line, or `inherit-parent` or `auto`, is routed by this extension's `models.json`: the parent's model family, sized and reasoned by complexity, and for panels one seat per family. The extension blocks a `delegate_task` call that uses the reserved Fable model or fast mode unless the user named it, reasoning above what `pstack_model` returned, or reasoning above high unless the user's latest message is "allow xhigh". Pass each returned target as `delegate_task`'s `target`. `inherit-parent` means omit `target`. `blocked` means the panel cannot reach two model families on this T3, so record its reason.

- arena runners: panel, one seat per model family
- arena cross-judge pool: panel, one seat per model family
