# Change log

## 0.12.2, 13 November 2026

Agents ask less. The `ask` tool no longer tells the agent to use it for every question. It tells the agent to ask only to get a choice or an approval, to settle an ambiguity it can't resolve itself, or when it is blocked, and to finish other work before asking about a blocked part. The question and handoff notes now let the agent drop an offer or a question whose only sensible answer is yes. The handoff check now fires only on a reply that waits on you, such as "once you've enabled billing" or "let me know when it's done". Lines under "What I need from you", "you'll need to", and "please restart" no longer count by themselves, because they tell you how to use the result and don't block the run. The checks also skip table rows and text in double quotes, so a reply that quotes an example such as "Paste your token here" no longer triggers a nudge.

The composer status no longer shows an out-of-usage mark for a model family that has no models.

## 0.12.1, 13 November 2026

These changes use features from recent T3 versions:

- The bridge shows the unfinished goal, each unfinished workflow, and the model families out of usage next to the composer. T3 shows extension status there since #23901.
- T3's `/clear` starts a new Pi session in the same thread, which dropped the goal. The goal and the facts its evidence cites now move to the new session, paused, and the bridge names any workflows it left behind.
- The secret nudge tells the agent to pass the sign-in page as `url`, which T3 shows as a button on the card, and to use `delivery: "file"` when a shell command needs the value.

This problem is fixed:

- From T3 0.1.10, `t3_thread_read` returns a thread's newest items first. The check of a finished child read only its newest 100 activity items, so an earlier usage-limit error could be missed. It now pages back through `earlierPosition`, and still pages forward on older T3 versions.

## 0.12.0, 13 November 2026

Agents now ask with a card instead of leaving you a request in chat:

- Inside T3, `request_secret` is declared to the model in every thread with a UI. T3 registers it for `tool_search` only, so models wrote "paste your token here" or waited for you instead.
- A reply that asks for a login, token, key, or password in prose, such as "Run `gh auth login` and tell me when it's done", sends the agent back to call `request_secret`.
- A reply that hands you a task or waits on you, such as "Once you've enabled billing, I'll run it", or that lists items under "What I need from you", sends the agent back to do the task itself or to ask with an `ask` card that waits until you say it is done.
- The `ask` tool's guidance tells the agent to ask and wait for a step only you can take, and to use `request_secret` for secrets.

Pi is now 1.5.2. pstack is synced to t3-pstack 2.2.8: a delegated child is a leaf that starts no subagents unless its brief names one, writers use T3's `isolation: "worktree"`, and the worktree audit reads refs by full name. tstack is synced to `11e37a74`, where `council` acts on each result as it arrives. The T3 MCP tool list was checked against T3 0.1.10 nightly, and no change was needed.

`pstack/` now holds t3-pstack 2.2.8's skill text exactly as upstream ships it. The Pi changes to that text, such as the brief format and `pstack_model`, moved into `overlay/overlay.json`, so the skills Pi serves are unchanged and the next sync can take upstream's text without a merge.

## 0.11.0, 12 November 2026

These problems are fixed:

- `/goal` in a folder outside a git repository failed with "Cannot recheck workspace files". It now says that goals need a git repository.
- A delegated child whose brief was complete but broke its limits, such as Size L, a time limit above its size, too many files, a broad path like `**`, or an "allow xhigh" line, still ran. Every brief now passes the same checks, and a child with a failing brief stops with STATUS: BLOCKED and the list of problems.
- `get_goal` returned every fact the goal ever observed. It now returns only the facts evidence can still cite and the ones saved evidence already cites.
- Copies of pstack under `~/.local/state/pi-t3/pstack-overlay` were never deleted, and each held upstream's 3.5 MB statechart test corpus. Pi now deletes copies no start has used for 7 days, and copies leave out upstream's tests.
- `pr-wait` never reported green for a PR with no checks, and ignored `XDG_STATE_HOME`. A PR with no checks is now green after two polls agree, and state goes under `$XDG_STATE_HOME/pr-wait`.
- `npm test` could read and write the real config and state folders. It now points them at a temp folder.
- Each extension load added another exit listener for the sandbox's runtime folders, so `npm test` and repeated `/reload` printed MaxListenersExceededWarning. All loads now share one listener.

`council` now asks for three model families rather than three providers, so one provider that serves Claude, GPT and Gemini models is enough. The `poteto-help`, `setup-pstack` and `automate-me` skills now give Pi install steps, `/skill:<name>` names and the `ask` tool. Unused exports are gone from the bridge.

A new extension, `bstack.ts`, serves the `ship` skill. Say "ship it" and the agent takes the change to a green commit on main: it runs the repo's CI commands locally, pushes without force, watches CI on main, and reverts its own commit if CI fails. It is tstack's `full-send` without the branch, PR, `sol-loop` and `council`, and it files a PR only when the branch is protected or you ask.

A new tool, `create_goal`, lets the agent start a goal when you or a skill you invoked asks for one, as in Codex. `/goal <objective>` works as before.

`/goal approve` and `/goal review` are gone. A goal completes as soon as fresh evidence matches every condition the agent proposed, so it never waits for you, as in Codex. A goal also no longer pauses itself after three cycles with no new evidence. It stops only when you pause it or when the same blocker stops the agent three cycles running.

## 0.10.1, 11 November 2026

The README is rewritten around the features, with a new section on workflows and diagrams in place of long paragraphs. The section on verifying a release archive is gone.

These problems are fixed:

- `pi -p "/goal <objective>"` saved the goal and exited before the goal's run reached the model. In print and JSON modes, `/goal` now waits until that run ends.
- `create_workflow` offered `read-only` isolation, which every step then refused, and let a local step ask for a worktree. Its schema now allows only local steps with `shared` isolation and delegated steps with `shared` or `worktree` isolation.
- A child session that ended without `session_shutdown`, such as an SDK `session.dispose()`, left its `pi-t3-child-*` folder in the temp directory. Pi now removes any such folder when its process exits.

## 0.10.0, 11 November 2026

`/goal <objective>` saves one objective on the session branch and keeps the agent working until it reports completion with evidence, or a blocker. `get_goal` and `update_goal` let the agent read and report on it. The README section "Saved goals" lists the commands.

The stop checks and MAST checks are gone, along with the `steer` and `classifierModel` settings and the `steer.jsonl` log. Saved goals now keep a run going until it has evidence, and they do it without a classifier. Old settings files that still set these keys keep working, and you can delete `~/.local/state/pi-t3/steer.jsonl`.

Two fixed reply checks replace them. A reply that hits the output limit still continues, as before. A reply that ends by asking you a question in plain text now goes back to the agent once, with a note to ask it on an `ask` card, and the `ask` tool tells the agent to use it for every question. The README section "Reply checks" has the rules.

The README now says that T3's own Plan mode does nothing in a Pi thread, because T3 doesn't send the Plan setting to Pi.

The plan gate no longer has a Plan mode state that nothing set. The `plan` tool works as before, and when card rendering or selection throws, the gate opens again instead of blocking write tools until the next plan. If inline rendering is unavailable, the selection dialog shows the plan and waits for an answer.

These problems are fixed:

- A child's acceptance command that timed out lost its output and its "(timed out)" note in the report.
- A child working in a subdirectory of a repository, or writing a file with a space in its name, was reported as writing outside its brief.
- Two Pi processes that started at the same time could fail while building the pstack copy.
- One failed T3 lookup made a delegated child look like your own session until it restarted.
- Status refreshes for Pi in a terminal could overlap and reconnect twice.
- Two chats that marked model families out at the same moment could lose one of the marks. `accounts.json` is now written under a lock, using the new dependency `proper-lockfile`.
- A settings file that exists but can't be read, e.g. for lack of permission, was ignored without a warning.
- Each delegated child left an empty `pi-t3-child-*` folder in the temp directory. The child now removes its own folder when its session ends.
- A goal sent the model one more copy of its full instruction after every continuation. The model now sees only the current instruction, and older copies in the session show as a one-line note.
- `create_workflow` accepted a `goalId` that names no saved goal, and the workflow then failed at its first step. It now refuses the ID when it creates the workflow. A workflow without `goalId` works as before.
- `/goal` with extra spaces before its words showed the goal status instead of running the command.
- `get_workflow` is marked read-only, so it runs while a plan card waits for an answer.
- The bundled playbooks named the state folder `pi-t3-bridge`. They now name `pi-t3`, where the bridge keeps its state.

`ledger.jsonl` moves its older lines to a `.1` file at 10 MB, so it does not grow without limit. The bundled `models.json` file is read once per process instead of on every turn or tool call. The README now asks for Pi 1.5.0, which the package has needed since 0.7.0.

## 0.9.1, 8 November 2026

GitHub Releases now provides an optional archive signed with Packslip. The README explains how to verify and install the archive. The existing git install is unchanged.

## 0.9.0, 8 November 2026

GitHub Actions now runs the checks on pull requests and changes to main. The Linux sandbox checks run in Docker without privileged mode.

The package is no longer published to npm, and 0.8.3 is the last npm release. Install it from GitHub with `pi install git:github.com/bjoernaagaard/pi-t3-bridge`. If you have the npm package, run `pi remove npm:pi-t3-bridge` first. `package.json` is marked private, so `npm publish` refuses to run.

Pi in a terminal signs in to T3's MCP server by itself. Before, it asked you to approve a sign-in page at `127.0.0.1:3773`, which never loads when your browser runs on another machine than T3. The bridge now gets a one-time pairing code from the running server's `t3` CLI, trades it for a 30-day token, and saves the token in `~/.local/state/pi-t3/t3-mcp.json`. It signs in again when the token is rejected or expires within a day. A T3 server on another machine still uses the browser sign-in.

The sign-in also recovers in two more cases. When T3 revokes the token during a session, the next T3 tool call fails with "MCP server requires authentication", and the bridge now signs in again, so the call after it works. Before, the bridge did not recognize that message. When T3 is down as Pi starts, the bridge signs in once T3 comes back. Before, Pi stayed signed out until you restarted it. The steer tests no longer sign in to the real T3 on the machine that runs them.

The README and the change log were rewritten in plain language, and the README now has a section on the child sandbox with a tree of the folders a child can write.

The notes in `brief.md` about the child sandbox moved from `pstack/` into `overlay/`, so `pstack/` holds the upstream text again and the next upstream merge won't conflict with them. Agents read the same notes as before.

The tests load Pi from the project's `devDependencies`. Before, they read Pi from `~/.pi/agent/install`, which a Pi installed some other way, such as through mise, doesn't have, so every test file failed to start. The Linux test image no longer builds a copy of that folder.

Stale files are gone: the request probe that only the removed bridge-trim test used, and a perf script that pointed at Pi 1.4.0. Twenty-six names that no other file imports are no longer exported.

## 0.8.3, 6 November 2026

Version 0.8.3 fixes six problems that a large orchestration run found in the child sandbox, and it changes how often the stop checks send a note.

The child sandbox has these changes:

- A bullet under "Files you may write" may list several paths, and every word with a slash or a glob counts as a path. Before, the bridge kept only the first word, so a child was refused a file its brief meant to allow.
- The disk limit leaves out `node_modules`, because pnpm fills it from the store. Before, a 500 MB limit failed on any pnpm monorepo install.
- On Linux the child runs in its own process namespace, so it can't see or signal processes on the host. Anything a command starts in the background ends when that command ends.
- The bridge sets `TMPDIR` in the child. The README now says that Chrome and Electron need `--no-sandbox` inside the sandbox, and that a `pi` run inside a child needs `PI_CODING_AGENT_DIR`.

The stop checks now send at most one note for each prompt. When a check would send a second note for the same prompt, the bridge logs it in `steer.jsonl` as capped, where earlier releases showed a toast.

## 0.8.2, 6 November 2026

Version 0.8.2 closes a hole in the child sandbox. A delegated child whose brief missed a section or a header field ran with no sandbox and no limits, because the bridge treated it as your own session, and such a child could rewrite the parent's git hooks.

The bridge now blocks every tool in that child, and the block lists what the brief is missing, so the parent can send a complete brief. A session you start yourself is never blocked, even when its first message starts with `# Task:`.

## 0.8.1, 6 November 2026

Version 0.8.1 lets a delegated child run `pnpm install` and `git commit` in a repo that uses pnpm and lefthook, under `bwrap` on Linux and `sandbox-exec` on macOS.

Each child gets its own `XDG_RUNTIME_DIR` in the temp folder, because pnpm 12 takes its store lock there. The sandbox can write to the store that `pnpm store path` names for the workdir, and the child uses that store, so the child shares the parent's store and doesn't build a second one in the workdir.

Children skip install scripts, so a root `prepare` such as `lefthook install` no longer fails on the read-only git hooks. With the same setting, npm also skips the `pre` and `post` scripts of `npm run`, while pnpm still runs them. A brief that needs a postinstall step, e.g. `next typegen`, should name the build or typecheck that runs the step.

## 0.8.0, 5 November 2026

Version 0.8.0 removes the pi-amplike adapter, `amplike.ts`. The package no longer loads pi-amplike or changes its `/mode`, `/btw`, `/handoff`, and `subagent` for T3, so use T3's own `/btw`, `/side`, model picker, and `delegate_task` instead. If you set `{"source":"npm:pi-amplike","extensions":[]}` for the adapter, remove that entry from `~/.pi/agent/settings.json`.

The bridge also stops rewriting the "- Subagents:" bullet in the "## T3 Code orchestration" section of T3's system prompt, so Pi sends the prompt unchanged. The rewrite broke pi-cached-compaction, which compares the last request byte for byte before it reuses the prompt cache, and every cached compaction in T3 failed with `request field "system" differs`. Pi now sees T3's original bullet, which names Claude's `Agent` and Codex's `spawn_agent`, although Pi has neither tool.

## 0.7.2, 5 November 2026

Version 0.7.2 stops pi-amplike's permission prompt in T3 threads. T3 has its own permission system, so the bridge no longer loads amplike's `permissions` extension inside T3, and Pi no longer asks "Permission required ... Allow?" before bash commands there. Outside T3, amplike's `/permissions` and its prompts work as before.

## 0.7.1, 4 November 2026

Version 0.7.1 changes only the documentation. The README covers all four extensions and the pi-amplike adapter, and the package ships the change log.

## 0.7.0, 4 November 2026

Version 0.7.0 builds and checks every schema with `@earendil-works/pi-schema` instead of `typebox`, because Pi 1.5.0 moved its own schemas and tool checks to pi-schema. The package lists pi-schema as a dependency and no longer needs `typebox`.

The package behaves the same for you. A schema that reads data from T3, a settings file, or a model still accepts fields it doesn't know, as it did with `typebox`. Tools send the model their allowed values as `enum` instead of `anyOf`, and the model can send the same values as before.

## 0.6.0, 4 November 2026

Version 0.6.0 adds `amplike.ts`, which loads pi-amplike's extensions and changes the parts that T3 can't show.

In a T3 thread, amplike's `subagent` tool is off, so subagent work goes through T3's `delegate_task`. `/btw` starts a `delegate_task` child, and `/handoff` and the `handoff` tool start a new T3 thread with a summary and the parent session file. `/mode` sends each model change to T3, so T3's model picker shows the same model.

To use the adapter, change `"npm:pi-amplike"` in `~/.pi/agent/settings.json` to `{"source":"npm:pi-amplike","extensions":[]}`. Outside T3, amplike works as before.

## 0.5.0, 4 November 2026

Version 0.5.0 lets the stop checks use any chat model when Jev isn't available. You can name the model with `classifierModel` in `~/.config/pi-t3/config.json`. Without the setting, the bridge uses Jev when you have access and the session model when you don't. The release also updates pstack to t3-pstack 2.2.1 and pins T3 to 0.1.7.

## 0.4.0, 2 November 2026

Version 0.4.0 adds the tstack skills to the package, and it changes how the package serves the pstack skills.

The tstack skills are a public set by Theo Browne, which are babysit-pr, council, file-pr, full-send, full-stop, leaving-pr-comments, modernize, sol-loop, and takeover. A new file, `tstack.ts`, serves them to Pi, and it works on its own, so the skills stay available when you turn the pstack extension off. You get updates to the skills with package updates, so you don't keep a copy by hand.

The `pstack/` folder now holds the exact text from the pstack project, and a new `overlay/` folder holds every change Pi needs. At start, the package copies `pstack/` into the state folder, applies the changes from `overlay/` to the copy, and serves the copy. A maintainer can take an upstream update as it comes, and the test run fails with the file name when a change in `overlay/` no longer matches the new text.

If you copied the tstack skills into your own skills folder, delete the copies, because two copies of one skill can conflict. Otherwise you don't need to do anything, and the pstack skills work as before.
