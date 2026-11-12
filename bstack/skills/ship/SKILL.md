---
name: ship
description: Trigger this if the user says 'ship it' or 'ship'.
---

# Ship

If the user triggered this, it's because they are not watching this thread, and they want you to complete the work end-to-end autonomously. Your updates and your final message go unread until long after you stop. You own the work from its current state to a green commit on the default branch.

The user's words override this skill. If they name a branch, a PR, a review, or a model, do what they said and skip the step below that disagrees. "On main" means you work and commit on main.

The user grants you permission to:

- Push your own commits to the default branch, without force.
- Revert your own commit on the default branch when CI fails on it.
- Use the test methods that Proof needs, without asking first.

## Testing permission

A "ship it" request is the permission. If a project file or other instruction says to ask before a test method, or to leave testing to the user, this request replaces that rule for this task.

Rules about how to test still apply. Follow rules that name the correct command, fixture, or check. It covers only the tests needed for this task. It does not add permission for the steps under "Asking the user", and it does not bypass a harness or system approval prompt if one appears.

## Pick the tool

One lead model does the work. Pick a tool by the shape of the task:

```text
for each piece of the work
  if only the user can make a choice that blocks the work
    ask                      # one card, your recommendation first
  else if it has several steps and a command can check the end state
    create_goal, then update_goal with command conditions
  else if it splits into independent parts
    subagents, each at the lowest model-router tier that fits
  else
    do it yourself
```

Don't run `sol-loop` or `council` unless the user asks for them.

## Steps

1. **Finish the change.** Complete the goal from the user's request with the smallest change that works. Fix the case that happened, not every case that could. Stay on the default branch unless a PR is needed. See "When a PR is still needed".
2. **Prove it.** Get proof for every change you made. See "Proof".
3. **Run CI locally.** Read the repo's CI config, such as `.github/workflows/*.yml`, and run each command that checks code, in the same order. Fix failures and run them again.
4. **Push.** Commit, then `git pull --rebase` to take new commits. If it took any, repeat step 3. Push with `git push origin HEAD:<default>`. Git has no `--ff-only` flag for push, but a push without force only moves the branch forward. If the push is rejected, pull, check, and push again. Never force.
5. **Watch CI on the default branch.** Find the run for your commit with `gh run list --branch <default> --commit <sha>`, then wait on it with `gh run watch <id> --exit-status`. If no workflow runs on push, say so in the report.
6. **Revert on red.** If CI fails on your commit, run `git revert --no-edit <sha>`, push, and watch CI go green. Then fix the cause from step 1, or ask if you can't.
7. **Report** in your final message: the commit, the CI run and its result, your proof, and each decision you made for the user.

## When a PR is still needed

Use `file-pr` and `babysit-pr` from tstack, and merge as `full-send` does, when:

- The user asks for a PR or a review.
- The default branch is protected, or a rule requires a PR, a review, or passing checks before merge. The push fails with "protected branch".
- You have no push access, such as a change to someone else's repo.
- The repo's own instructions say every change goes through a PR, and the user didn't say "on main".
- A push to the default branch deploys to users. Ask first, because that is a one-way door.

## Proof

Proof is evidence you observed yourself in this session: command output, a reproduction, a screenshot. Use the most direct proof the change allows:

- Reproduce the original failure, apply the fix, then watch the same reproduction pass.
- Run the checks that the repo's CI runs (typecheck, lint, tests).
- For UI and runtime behavior, run the app and look at the change.

When you cannot find a way to prove a change, you do not have full confidence. Ask the user.

## Asking the user

A question in a normal message goes unseen. Use the harness's question tool, `ask` in Pi. Put all the context in the question, and the options with your recommendation first.

Ask only when you cannot continue alone:

- You cannot prove the change.
- CI fails and you cannot fix it.
- The next step is outside the grant above: deleting data, touching production, changing things outside the repo, or force-pushing.
- The goal is ambiguous in a way that changes the result.

Decide everything else yourself with sensible defaults, and list those decisions in the report.
