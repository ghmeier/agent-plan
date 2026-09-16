---
title: Plan Storage CLI
status: completed
tags:
  - cli
  - architecture
  - storage
created: 2026-09-11
updated: 2026-09-16
---

# Plan Storage CLI

We'd like to build a tool to manage plans for agent-driven coding workflows.

## Overview

Today, many teams have a workflow that does some version of the following:

1. Generate Research Doc
2. Generate Plan
3. Implement the plan (lots of steps that also update the plan)
4. Generate Handoff (for use later)

This has a few problems:

- Files just sit around on developers' laptops
- Each team or project has to answer the question "Do you commit the plan or no" - there's a standardization problem
- How do you share with others and handoff context if you haven't consistently committed
- You lose context on past implementation if you don't commit
- Committing everything to your main repo can create a lot of churn and review burden on files that are just markdown.

Some high-level requirements:

- Interface to initialize the tool in existing repositories
- Straightforward interface for LLMs to interact with
- Store Markdown files in a separate storage medium from the main git repo
- Accessible from both local machine and teammates
- Store changes over time
- Minimal workflow change from existing git workflows

Out of scope:

- Don't want to rebuild git
- Don't need a markdown viewer
- Doesn't need to be hosted publicly
- Don't really need a UI at all
- Don't need to handle concurrent editing

## Solution

The solution here is a tool that easily integrates with an existing git repo,
but stores planning related files separately where they can be managed automatically
without concern for review, or even consistent human interaction. Agents should be
able to access these files and the history easily to get context, and it should
stay reasonably up to date.

Using the tool means there's no more question of whether or which files to commit.

There should be a one-command initialization step, a one-command sync step, and
an automatic way to commit plan changes.

We may want to couple this with a set of skills or a claude plugin so harnesses can interact
easily with the tool.

We should use typescript and bun along with any helpful libraries to build the tool and
use git as the underlying storage mechanism. For now it's ok to assume a logged in
github account for pushing to remote, but it shouldn't be assumed.

## Architecture

### Storage: Git Orphan Branch

Plans are stored on an orphan branch (default: `plans`) within the same repository. This branch has completely independent history from the main codebase. The branch is pushed to the same remote, so teammates get access automatically on fetch.

**Why orphan branch over alternatives:**
- **vs. separate repo**: No extra remote config, no second auth setup, portable across clones.
- **vs. git notes**: Notes attach to commits, not projects. One note per commit per namespace. Poor fit for living documents.
- **vs. plain files in the repo**: The whole point is avoiding churn and review burden on plan files.

**How it works under the hood:**
- `apl init` checks the plans branch out as a git worktree at `.plans/`. There is no other storage mode: every command reads and writes plan files through that directory, so agents and editors use normal file I/O.
- If the branch already exists on the remote, `init` builds on it so teammates share history; otherwise it creates the orphan branch with an empty initial commit.
- `apl commit` stages and commits everything that changed in `.plans/`. `show --version`, `log`, and `diff` run git inside the worktree.
- The main checkout owns the real `.plans/` worktree. Secondary checkouts (from `git worktree add` or tools like `wt`) get `.plans` as a symlink to the main checkout's `.plans/`, so every checkout shares the same files and branch.
- `.plans` is added to `<git-common-dir>/info/exclude` rather than `.gitignore`, so the rule applies to every checkout and never shows up in a commit.
- Shell completion is the one place that reads from the branch directly (`git ls-tree`), because pressing tab should not create the worktree.

### CLI: Bun + Commander.js

- **Runtime**: Bun (fast startup, native TypeScript, good shell spawning via `Bun.spawn`).
- **CLI framework**: Commander.js for subcommand routing and auto-generated help.
- **Git interaction**: Shell out to `git` directly. No wrapper library needed.
- **Config**: `<git-common-dir>/agent-plan/config.json` (normally `.git/agent-plan/config.json`). Living in the shared git directory keeps it local, shared across checkouts, and off the plans branch. An old `.plans/config.json` is migrated on first read.

### Project Structure

```
plan-storage/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── commands/
│   │   ├── init.ts           # plan init
│   │   ├── add.ts            # plan add <file>
│   │   ├── commit.ts         # plan commit
│   │   ├── sync.ts           # plan sync (push/pull)
│   │   ├── log.ts            # plan log [file]
│   │   ├── show.ts           # plan show <file> [--version <ref>]
│   │   ├── ls.ts             # plan ls
│   │   └── diff.ts           # plan diff [file]
│   ├── lib/
│   │   ├── git.ts            # Git plumbing wrapper
│   │   ├── config.ts         # Config read/write
│   │   └── paths.ts          # Path resolution helpers
│   └── types.ts              # Shared type definitions
├── test/
│   ├── commands/             # Command-level integration tests
│   └── lib/                  # Unit tests for git/config helpers
├── package.json
├── tsconfig.json
├── bunfig.toml
├── PLAN.md
└── README.md
```

## Implementation Tasks

Tasks are organized into waves. Tasks within a wave can be done in parallel.
Tasks depend only on prior waves, never on other tasks in the same wave.

### Wave 1: Foundation (all parallel)

These have no dependencies and set up everything later waves build on.

**Task 1: Project setup and CLI skeleton**
- `bun init` with TypeScript
- Set up `package.json` with `bin` entry pointing to `src/index.ts` with `#!/usr/bin/env bun` shebang
- Configure `tsconfig.json` with strict mode
- Add `.gitignore` entries for `node_modules/`, `.plans/`
- Install Commander.js: `bun add commander`
- Create `src/index.ts` with Commander program setup
- Register subcommands: `init`, `add`, `commit`, `sync`, `log`, `show`, `ls`, `diff`
- Stub each command file in `src/commands/` with placeholder implementations
- Verify `bun run src/index.ts --help` prints usage

**Task 2: Test infrastructure**
- Create a test helper that initializes a temporary git repo for each test (and cleans up after)
- Verify `bun test` runs and passes with a trivial test
- Add a test script to `package.json`

**Task 3: Git plumbing wrapper (`src/lib/git.ts`)**
Build a `GitPlumbing` class that wraps the low-level git operations needed to read/write the orphan branch without touching the working tree:
- `exec(args)`: Run a git command via `Bun.spawn` and return stdout
- `branchExists(branch)`: Check if the plans branch exists
- `createOrphanBranch(branch)`: Create an empty orphan branch with an initial empty commit

> **Superseded:** the branch readers (`readFile`, `listFiles`, `getLog`), plumbing writes (`writeFiles`), and `diff` were removed when storage became worktree-only. The wrapper now only provides `exec`, `branchExists`, and `createOrphanBranch`.

**Task 4: Config and path helpers (`src/lib/config.ts`, `src/lib/paths.ts`, `src/types.ts`)**
- Define `PlanConfig` type: branch name, remote name, worktree path
- `readConfig(repoRoot)`: Read `.plans/config.json`, return defaults if missing
- `writeConfig(repoRoot, config)`: Write config to `.plans/config.json`
- `findRepoRoot()`: Walk up from cwd to find `.git/`
- Path resolution helpers: resolve plan file paths relative to repo root

### Wave 2: Core Commands (all parallel)

Depends on Wave 1. Each task only needs the git plumbing wrapper, config module,
and CLI stubs from Wave 1.

**Task 5: `plan init` command**
- Detect the git repo root
- Create the orphan branch if it doesn't exist (via `GitPlumbing.createOrphanBranch`)
- Write `.plans/config.json` with default settings
- Add `.plans/` to `.gitignore` if not already present
- Print confirmation with next steps
- Tests: init in a fresh repo, init when already initialized (idempotent), init in a non-git directory (error)

**Task 6: `plan add` and `plan commit` commands**
- `plan add <file> [file...]`: Write one or more markdown files to the plans branch immediately (combined add+commit in one step for simplicity). Accepts a glob or multiple paths. Auto-generates commit message from file list, or accepts `-m <message>`.
- `plan commit [-m <message>]`: When worktree mode is active (Wave 4), commits all changes in `.plans/`. Without worktree, this is a no-op that tells the user to use `plan add`.
- Tests: add a single file, add multiple files, add overwrites existing, add with custom message

**Task 7: Read commands — `plan show`, `plan ls`, `plan log`, `plan diff`**
- `plan show <path>`: Print contents of a plan file. Support `--version <ref>` for historical versions.
- `plan ls [path]`: List all plan files or files under a subdirectory. Show last-modified info.
- `plan log [file]`: Commit history for all plans or a specific file. Formatted like `git log --oneline`.
- `plan diff [file]`: Diff a local file against its last-committed version on the plans branch.
- Tests: show existing file, show missing file (error), show historical version, ls empty branch, ls with files, log with multiple commits, diff with changes

### Wave 3: Sync and Output (parallel)

Depends on Wave 2. Both tasks are independent of each other.

**Task 8: `plan sync` command**
- Pull: `git fetch <remote> <branch>`, then fast-forward the local plans ref
- Push: `git push <remote> <branch>`
- Handle first push (remote branch doesn't exist yet)
- Handle remote-ahead (fetch first, then push)
- Handle no remote configured (skip with a message)
- Report what changed: files added/modified/deleted since last sync
- Tests: sync with no remote (graceful skip), sync push, sync pull (requires a test remote — use a bare repo in tmp)

**Task 9: `--json` flag on read commands**
- Add `--json` flag to `show`, `ls`, `log`, `diff`
- JSON output includes structured fields: path, content, timestamps, commit hashes
- Keep the human-readable output as default
- Tests: verify JSON output parses and contains expected fields for each command

### Wave 4: Agent Ergonomics (parallel)

Depends on Wave 3. Both tasks are independent of each other.

**Task 10: Worktree mode**

> **Superseded:** the worktree is no longer optional. `init` always creates it, the `--worktree` flag and `teardown` command don't exist, and every command works through `.plans/`. See "How it works under the hood" above.

- `plan init --worktree`: Create a git worktree at `.plans/` checking out the plans branch
- When worktree exists, `plan commit` does `git -C .plans add -A && git -C .plans commit`
- `plan show` and `plan ls` can read directly from `.plans/` when the worktree is present
- `plan teardown --worktree`: Remove the worktree
- Tests: init with worktree, add file via worktree, commit via worktree, teardown

**Task 11: Auto-commit hook**
- `plan init --auto-commit`: Install a git post-commit hook that runs `plan commit` (worktree mode) or is a no-op (non-worktree mode, since add already commits)
- Hook is a shell script that checks for the plan CLI and runs silently
- `plan init --no-auto-commit`: Remove the hook
- Tests: hook installs, hook runs on commit, hook handles missing CLI gracefully

### Wave 5: Polish (parallel)

Depends on Wave 4.

**Task 12: Error handling and UX**
- Wrap all commands in a top-level error handler with user-friendly messages
- Color output using ANSI codes (with `--no-color` / `NO_COLOR` env var support)
- Detect common problems: not in a git repo, plans branch not initialized, file not found
- Consistent exit codes: 0 success, 1 user error, 2 internal error

**Task 13: README and documentation**
- Quick start guide
- Full command reference with examples
- Section on agent/LLM integration patterns
- Section on worktree vs. plumbing mode tradeoffs

**Task 14: Publishing**
- `npm publish` with `bin` entry so `npx plan-storage` works
- `bun build --compile` for standalone binary (optional, for users without Bun)
- GitHub releases with compiled binaries

## Open Questions

- **Naming**: `plan` as the CLI command? Or `plans`, `planner`, `pst`?
- **File organization**: Flat list of plans, or support subdirectories (e.g., `research/`, `handoffs/`)?
- **Templates**: Should `plan init` create starter plan files? What structure?
- **Commit granularity**: One commit per `plan add` call, or batch until explicit `plan commit`?
