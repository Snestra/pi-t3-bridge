---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Get the worker target from `pstack_model` with `swarm workers`. When it returns `inherit-parent`, omit `target` so the workers run on the parent model. For a model race, name each arm's model up front. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.
4. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Spawn all N workers in one response as `delegate_task` calls with `mode: "async"` and the step 3 `target`, left unset for `auto` or `inherit-parent`. Every worker runs on this machine, so a worker that writes gets `isolation: "worktree"`, per poteto-mode's Dispatch on T3.

When a worker must start from a non-default branch, it starts from that branch's head commit, per poteto-mode's Dispatch on T3.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with a result table, issue one-liners, gaps or dropouts, and the race rule when used.

## Models

Get every target from the `pstack_model` tool. Pass the role name plus the job type and size from the routing table in poteto-mode's Subagents section. This skill's spawns are `check` jobs for verification workers and `implement` or `mechanical` jobs for build workers. Write every brief from `<plugin root>/skills/poteto-mode/brief.md`: the extension refuses a `delegate_task` call whose brief is missing its sections or limits. Without a job, pass the complexity: `groundwork` for cheap mechanical work, `bounded` for involved but bounded work, `general` for work that needs substantial judgment. The tool reads the role's line in the model sheet (`~/.config/t3-pstack/models.md`, written by `/setup-pstack`). A line naming a model is used as written, moved to a provider T3 can run right now when needed. A role with no line, or `inherit-parent` or `auto`, is routed by this extension's `models.json`: the parent's model family, sized and reasoned by complexity, and for panels one seat per family. The extension blocks a `delegate_task` call that uses the reserved Fable model or fast mode unless the user named it, reasoning above what `pstack_model` returned, or reasoning above high unless the user's latest message is "allow xhigh". Pass each returned target as `delegate_task`'s `target`. `inherit-parent` means omit `target`. `blocked` means the panel cannot reach two model families on this T3, so record its reason.

- swarm workers: one target
