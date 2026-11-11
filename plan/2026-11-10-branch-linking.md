---
title: Linking plans to branches and commits
status: active
tags: [cli, git]
created: 2026-11-10
updated: 2026-11-11
---
# Linking plans to branches and commits

Replaces the earlier `plan-repo-linking.md` draft, which stored links in a `.plan-meta.json` file on the docs branch.

## Goal

Connect each plan to the branches and commits that implement it, without agents maintaining any link data. This makes three things possible:

- List every branch for a plan, including branches that have since been deleted.
- Find the plan for a branch without grepping, so a new session started on a branch gets its plan as context.
- See which plan edits happened while a branch was being worked on.

Links must survive deleted branches, because gazebo squash-merges and deletes every branch. A link records the branch name and its last tip. It does not record the pull request or the squash commit (see Decisions).

## Constraints and findings

- **Who edits the plan is unrelated to who does the work.** An orchestrator on the default branch usually edits the plan, and implementer subagents on work branches make the commits. So the link cannot be derived from plan edits. It has to be recorded from the work branch.
- **Trailers on code commits do not survive.** All of the last 400 commits on gazebo's main branch are squash commits whose subject ends in `(#N)`, and the ones inspected use the pull request title and description as the message. The branch's own commit messages are discarded.
- **Trailers on docs-branch commits work.** A prototype confirmed that `git log --format='%(trailers:key=Code-Branch,valueonly)' -- <doc>` and `git log --grep='^Code-Branch: <branch>$'` return the right commits, that empty commits can carry the trailers, and that both survive the `git rebase` that `apl sync` runs (git 2.50.1).
- **A shared metadata file would conflict.** Every sync from every teammate would rewrite the same file. Commits on the docs branch only ever append, so they cannot conflict.
- **Claude Code hooks fire for subagents.** Plugin `PostToolUse` hooks run for a subagent's tool calls, and the input includes `agent_id`. For file tools, `tool_input.file_path` is always absolute. Hooks accept an `if` field in permission-rule syntax, so a hook can be limited to paths under `.apl/` before any process starts. The documentation does not say what `cwd` is for a subagent running in its own worktree, so it was measured (see "Checks before writing code").

## Approach

### Where a link lives

A link has two parts.

**The working link** is git config in the code repo: `branch.<name>.apl-doc`, one value per linked doc. All worktrees of a clone share it, and git removes it when the branch is deleted. It is local to the clone and is how apl knows which branches to watch.

**The durable record** is a commit on the docs branch with trailers. It is shared with teammates and outlives the branch:

```
Link feature/supplier-merge to plan/2026-11-10-supplier-merge.md

Linked-Doc: plan/2026-11-10-supplier-merge.md
Code-Branch: feature/supplier-merge
Code-Commit: 7112e56a...
```

These link commits are empty: they change no files. One commit covers one branch, with one `Linked-Doc` trailer per doc linked to it. The docs branch log is the only source of truth for queries. Nothing is cached in a file.

`apl unlink` writes a commit with an `Unlinked-Doc: <doc>` trailer.

### When a link is created

A doc is linked to a branch when it is read or edited from a checkout of that branch. Three things trigger it:

1. `apl show <doc>` run in a checkout on a work branch.
2. The Read, Edit, or Write tool used on a path under `.apl/`, caught by a plugin `PostToolUse` hook that runs the hidden `apl hook doc-touched`.
3. `apl link <doc> [--branch <name>]`, for workflows where the implementer never opens the plan, such as an orchestrator that pastes the relevant section into the subagent's prompt.

Rules that apply to all three:

- Docs of every type link, not only plans. Files in the store that are not docs, such as `config.json`, do not.
- Nothing links on the default branch, on the docs branch, or on a detached HEAD. The default branch comes from `origin/HEAD`, falling back to `init.defaultBranch`, then `main`.
- Linking is idempotent. A second read of the same plan from the same branch does nothing.
- A branch can have several docs, and a doc can have several branches.

For the hook, the branch comes from the checkout that contains `cwd` in the hook's input. For a subagent with its own worktree, `cwd` is that worktree, whichever path it used to reach the doc (see "Checks before writing code").

The trigger only writes the git config value. It makes no docs commit, so it is fast and cannot fail a read.

### When the record is written

Every `apl sync` (and `apl commit`) scans local branches that have an `apl-doc` value. For each one, it compares the branch tip with the last `Code-Commit` recorded for that branch on the docs branch. If the link is new or the tip has moved, it writes one link commit.

This needs no hook in the code repo, and it does not matter which session syncs. The orchestrator's Stop hook on the default branch records an implementer's commits, because both see the same branches. Only the latest tip is recorded per sync, since earlier commits are its ancestors.

The Stop hook calls `syncPlans({ ifChanged: true })`, which today returns early when no doc changed. A new link commit must count as a change so that it gets pushed.

### Reading links

- `apl links [<doc>] [--branch <name>] [--json]` lists links. For a doc: each branch and its last tip. For a branch: its docs. With neither, it lists every link. `--branch` without a name means the current branch.
- `apl show --branch [<name>]` prints every doc linked to a branch, defaulting to the current branch. This is the command for starting a session on a branch with its plan as context. Each doc starts with its usual metadata header, and `--outline` and `--section` apply to each.
- `apl ls --branch <name>` filters the list to docs linked to that branch.
- `apl show --json` and `apl ls --json` gain a `links` field with each link's branch and tip. Existing fields do not change.
- The SessionStart hook prints one line per doc linked to the current branch, next to the open handoffs it already prints.
- `apl log` hides link commits by default and shows them with `--links`. `apl log <file>` already excludes them, because they change no files.

Plan edits made while a branch is worked on are derived, not recorded: they are the docs commits that touch the linked doc after the branch's first link commit. `apl links <doc> --branch <name> --edits` prints them. Nothing records when a branch is merged, so the list has no end.

### Plugin and skill

- `plugins/agent-plan/hooks/hooks.json` gains `PostToolUse` entries for Read, Edit, and Write, each with an `if` rule matching `**/.apl/**`, running `apl hook doc-touched`.
- `SKILL.md` gains a short "Linked branches" section that says:
  - Reading a plan from a work branch links it, so there is nothing to maintain.
  - Read plans with `apl show`, which always attributes the read to the right branch.
  - `apl links` and `apl show --branch` answer "which plan is this branch for" and "what implemented this plan".
  - Use `apl link <doc> --branch <name>` when an implementer will not open the plan itself.

## Steps

### Checks before writing code

All three were done on 2026-11-10.

1. **A worktree subagent's hook input.** Measured with Claude Code 2.1.322: a headless session spawned a subagent with worktree isolation under a `PostToolUse` hook that logged its input. `cwd` was the subagent's worktree for every call, including a Read of the plan through the main checkout's absolute path. `agent_id` was set for the subagent and absent for the main session, and `session_id` was the parent's. `tool_input.file_path` was the absolute path as the agent addressed it, not resolved through the `.apl` symlink.
2. **The `if` filter.** A hook with `"if": "Read(**/.apl/**)"` ran for all three reads of the plan (main session, worktree path, main checkout path) and not for a Read of `README.md`.
3. **Empty commits and rebase.** Covered by the test "sync publishes a link, rebased onto a teammate's doc changes" in `test/linking.test.ts`, which runs on CI's git.

### Pull requests

Three are open and stacked, each based on the one before: `branch-linking-storage` (#1), `branch-linking-auto` (#2), `branch-linking-reading` (#3). Merge them in order. A fourth, pull request lookup (#4, `branch-linking-pull-requests`), was built and closed without merging.

1. **Storage and explicit linking.** Add `src/lib/links.ts`: read and write `branch.<name>.apl-doc`, find the default branch, write link commits through `execGit`, and parse the docs log into links. Add `apl link`, `apl unlink`, and `apl links`. Make `commit` and `sync` record new links and moved tips, and make the `ifChanged` path push them.
2. **Automatic linking.** Link from `apl show`. Add `apl hook doc-touched` and the plugin's `PostToolUse` entries. Update `SKILL.md` and check it with `claude plugin validate .`.
3. **Reading links.** Add `show --branch`, `ls --branch`, the `links` JSON field, `log --links`, `links --edits`, the SessionStart line, and shell completion for branch names.
Each pull request updates the README. Tests are in `test/linking*.test.ts` and drive the real CLI.

## Risks

- **Reading a doc for reference links it.** Every doc type links, so an implementer that opens two plans and a research note links all three. `apl unlink` corrects it. The cost of a wrong link is one extra row in `apl links` and one extra doc printed by `apl show --branch`, which matters most when that output is used as a new session's context.
- **`apl sync` does not commit when no remote is configured.** It returns before committing, so in a repo without a remote the Stop hook never records links. `apl commit` and `apl links` do.
- **An unlink can be undone by a teammate's clone.** `apl unlink` removes the working link only in the clone where it runs. If a teammate's clone still has it, their next sync links the doc again.
- **A branch is deleted before any sync records it.** The working link disappears with the branch. The Stop hook syncs every turn, so this needs a branch to be created, linked, and deleted within one turn.
- **A reused branch name continues its old link.** Nothing marks a branch as finished, so a later branch with the same name adds to the earlier link instead of starting a new one.
- **Link commits add volume to the docs log.** There is at most one per linked branch per sync, and only when the tip moved. Queries filter with `--grep='^Code-Branch: '` in a single `git log` call, which is fast at gazebo's size. Measure it there before the third pull request.
- **Git version differences.** Trailer formatting (`%(trailers:key=...)`) and the handling of empty commits during a rebase vary across git versions, and CI runs a different git than macOS.

## Decisions

- **Every doc type links.** Handoffs and research belong to a branch as much as plans do.
- **`apl show --branch` prints every linked doc**, not only the most recent one.

- **No pull request or squash commit in the record.** A lookup through the `gh` CLI was built (#4) and dropped on 2026-11-10. It tied apl to GitHub and made session start wait on up to 20 `gh` calls. The recorded branch name is enough for a tool to run `gh pr list --head <branch> --state all` when it needs the pull request. A git-only alternative exists if this is wanted later: for each new commit on the default branch, check whether merging the recorded tip into its parent gives the same tree.
- **No trailers on code commits.** Squash merges discard them, and they would put apl metadata in the team's commit messages.
- **No metadata file on the docs branch.** It would conflict on concurrent syncs and would be one more file for agents to damage.
- **No `branches:` field in plan frontmatter.** It cannot record tips or pull requests without constant churn in files agents are editing.
- **No git hook in the code repo.** Scanning linked branches at sync time gives the same record and works for commits made by any tool.
