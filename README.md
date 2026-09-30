# agent-plan

Version-controlled plan storage for agent-driven coding workflows, without cluttering your main repo.

## Quick Start

```bash
# Install from a clone of this repo (see Install / Build below)
bun install && bun link

# Initialize in your repo
apl init

# Add a plan file
apl add plan.md

# View docs
apl ls
apl show plan.md

# Sync with teammates
apl sync
```

## Why?

AI coding workflows generate a steady stream of research docs, plans, and handoffs. Committing them to your main repo creates churn and review burden on files that are just markdown. Keeping them local means they can't be shared with teammates or survive a fresh clone. agent-plan solves this by storing them on a separate git branch with its own history, synced with a single command, so there's never a question of whether or how to commit one.

## How It Works

Docs live on an independent orphan branch (default: `apl`), checked out as a git worktree inside the shared git directory at `.git/agent-plan/worktree`. Every checkout of the repo gets a `.apl` symlink to it, and it is listed in `.git/info/exclude` so the code repo never sees it. Agents and editors read and write files under `.apl/` with normal file I/O. `apl commit` stages and commits whatever changed. Because the branch is pushed to the same remote as your code, teammates get docs automatically on fetch, with no extra remote or auth setup.

Because the worktree belongs to no single checkout, every checkout (from `git worktree add` or a tool like `wt`) shares the same files and commits to the same branch, and removing or moving any checkout leaves the docs intact. Any apl command creates the `.apl` link in a checkout that lacks one. If an agent already wrote files into a plain `.apl/` directory there, apl moves them into the store first.

## Commands

### `apl init [--branch <name>] [--auto-commit]`

Initializes doc storage in the current repo. Creates the docs branch if it doesn't exist (or builds on an existing remote branch to keep shared history), and sets up the `.apl/` worktree.

Teammates don't need to run `init`: in a clone whose remote already has the docs branch, any command fetches it and sets up `.apl/` on first use.

- `--branch <name>`: use a branch name other than `apl`
- `--auto-commit`: install a post-commit hook that commits pending `.apl/` changes after every code commit. It goes wherever git reads hooks from, including `core.hooksPath`, and covers every checkout of the repo. It needs `apl` on `PATH`.

```bash
apl init
apl init --branch docs --auto-commit
```

### `apl add <file> [files...] [-m <message>]`

Copies one or more files into `.apl/` at their repo-relative path, stamps frontmatter timestamps, and commits. A file already inside `.apl/` is committed in place. Files outside the repo are rejected.

```bash
apl add research.md plan.md -m "Add auth research and plan"
```

### `apl commit [-m <message>]`

Stages and commits all pending changes in `.apl/`. Stamps `updated` timestamps into any modified markdown files that have frontmatter.

```bash
apl commit
apl commit -m "Update plan after review"
```

### `apl show <path> [--at <ref>] [--json] [--raw]`

Prints the contents of a doc. Reads from `.apl/<path>` directly, so uncommitted edits are visible. Use `--at` to read a historical revision from git history.

```bash
apl show plan.md
apl show plan.md --raw
apl show plan.md --at HEAD~2
```

### `apl ls [path] [--json] [--short] [--status <status>] [--tag <tag>]`

Lists markdown files in `.apl/`, including uncommitted ones, optionally under a subdirectory. The default output is a table showing filename, title, status, and tags. Use `--short` for filename-only output. Use `--status` and `--tag` to filter results (filters combine with AND).

```bash
apl ls
apl ls research/
apl ls --short
apl ls --status active
apl ls --tag cli
apl ls --status active --tag cli
```

### `apl log [file] [-n <limit>] [--json]`

Shows commit history for all docs, or for a single file.

```bash
apl log
apl log plan.md -n 5
```

### `apl diff [file] [--json]`

Shows uncommitted changes in `.apl/` against HEAD, for all files or one, including new files that have never been committed.

```bash
apl diff
apl diff plan.md
```

### `apl sync`

Commits any pending changes in `.apl/`, rebases them onto the remote branch, then pushes. If a teammate edited the same lines, sync aborts the rebase, names the conflicting files, and exits with an error without pushing; your local commits are left as they were. Skips gracefully if no remote is configured.

`commit`, `add`, and `sync` refuse to run while a rebase or merge inside `.apl/` is unfinished, so conflict markers are never committed as plan content.

```bash
apl sync
```

## Frontmatter Metadata

Plan files can include optional YAML frontmatter for richer display and filtering:

```markdown
---
title: My Feature Plan
status: active
tags: [cli, backend]
created: 2026-09-01
updated: 2026-09-15
---

# Plan content here...
```

Supported fields:

- **title**: Short display name shown in `apl ls` output
- **status**: One of `draft`, `active`, `completed`, `archived`
- **tags**: Array of free-form strings for categorization
- **created**: ISO date, auto-set on first `apl add`
- **updated**: ISO date, auto-set on every `apl add` and `apl commit`

Other keys are kept as written. Stamping changes only the `created` and `updated` lines, so comments, key order, and formatting are left alone. Timestamps are only injected into files that already have a frontmatter block.

## Agent Integration

- **Normal file I/O**: agents read and write plan files in `.apl/` directly, without shelling out to the CLI for every edit.
- **Structured output**: every read command (`show`, `ls`, `log`, `diff`) supports `--json` for scripting and parsing.
- **Automatic sync**: the auto-commit hook (`apl init --auto-commit`) commits `.apl/` changes automatically after every git commit.

Example agent workflow:

```bash
apl init --auto-commit
# agent writes .apl/plan.md directly with normal file tools
apl sync                    # push to remote so teammates see it
apl show plan.md --json     # read back structured plan state later
```

## Shell Completion

Tab completion is available for bash, zsh, and fish. It completes subcommands and
flags, and asks the CLI for plan file names, tags, statuses, and commit hashes.

```bash
# Add it to your shell config automatically
apl completion --install

# Or print the script and wire it up yourself
apl completion zsh    # eval "$(apl completion zsh)" in ~/.zshrc
apl completion bash   # eval "$(apl completion bash)" in ~/.bashrc
apl completion fish   # apl completion fish | source in ~/.config/fish/config.fish
```

Open a new shell, or source the rc file, for completion to take effect.

## Development

```bash
bun install
bun test
bun run typecheck   # type-check all source and test files
bun run lint        # lint and format check (Biome)
bun run lint:fix    # auto-fix lint and formatting issues
bun run src/index.ts --help
```

## Install / Build

For local development, link the CLI globally with Bun:

```bash
bun link
apl --help
```

To produce a standalone binary that runs without Bun installed:

```bash
bun run build          # compiles dist/apl for the current platform
./dist/apl --help
```

To cross-compile binaries for macOS (arm64, x64) and Linux (x64) in one step:

```bash
bun run build:all      # writes dist/apl-darwin-arm64, dist/apl-darwin-x64, dist/apl-linux-x64
```
