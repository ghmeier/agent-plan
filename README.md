# agent-plan

Version-controlled plan storage for agent-driven coding workflows, without cluttering your main repo.

## Quick Start

```bash
# Install
npm install -g agent-plan
# or run directly
npx agent-plan

# Initialize in your repo
apl init

# Add a plan file
apl add plan.md

# View plans
apl ls
apl show plan.md

# Sync with teammates
apl sync
```

## Why?

AI coding workflows generate a steady stream of research docs, plans, and handoffs. Committing them to your main repo creates churn and review burden on files that are just markdown. Keeping them local means they can't be shared with teammates or survive a fresh clone. agent-plan solves this by storing plans on a separate git branch with its own history, synced with a single command, so there's never a question of whether or how to commit a plan file.

## How It Works

Plans live in a `.plans/` directory that `apl init` sets up as a git worktree on an independent orphan branch (default: `plans`). Agents and editors read and write plan files with normal file I/O. `apl commit` stages and commits whatever changed in `.plans/`. Because the branch is pushed to the same remote as your code, teammates get plans automatically on fetch, with no extra remote or auth setup.

When you have multiple checkouts of the same repo (from `git worktree add` or a tool like `wt`), the main checkout owns the real `.plans/` worktree. Every other checkout gets `.plans` as a symlink to the main checkout's `.plans/`, so they all share the same files and commit to the same branch.

## Commands

### `apl init [--branch <name>] [--auto-commit]`

Initializes plan storage in the current repo. Creates the plans branch if it doesn't exist (or builds on an existing remote branch to keep shared history), and sets up the `.plans/` worktree.

- `--branch <name>`: use a branch name other than `plans`
- `--auto-commit`: install a git hook that commits worktree changes automatically after every commit

```bash
apl init
apl init --branch plans --auto-commit
```

### `apl add <file> [files...] [-m <message>]`

Copies one or more files into `.plans/` at their repo-relative path, stamps frontmatter timestamps, and commits.

```bash
apl add research.md plan.md -m "Add auth research and plan"
```

### `apl commit [-m <message>]`

Stages and commits all pending changes in `.plans/`. Stamps `updated` timestamps into any modified markdown files that have frontmatter.

```bash
apl commit
apl commit -m "Update plan after review"
```

### `apl show <path> [--version <ref>] [--json] [--raw]`

Prints the contents of a plan file. Reads from `.plans/<path>` directly, so uncommitted edits are visible. Use `--version` to read a historical revision from git history.

```bash
apl show plan.md
apl show plan.md --raw
apl show plan.md --version HEAD~2
```

### `apl ls [path] [--json] [--short] [--status <status>] [--tag <tag>]`

Lists markdown files in `.plans/`, including uncommitted ones, optionally under a subdirectory. The default output is a table showing filename, title, status, and tags. Use `--short` for filename-only output. Use `--status` and `--tag` to filter results (filters combine with AND).

```bash
apl ls
apl ls research/
apl ls --short
apl ls --status active
apl ls --tag cli
apl ls --status active --tag cli
```

### `apl log [file] [-n <limit>] [--json]`

Shows commit history for all plans, or for a single file.

```bash
apl log
apl log plan.md -n 5
```

### `apl diff [file] [--json]`

Shows uncommitted changes in `.plans/` against HEAD, for all files or one.

```bash
apl diff
apl diff plan.md
```

### `apl sync`

Commits any pending changes in `.plans/`, fast-forward pulls from the configured remote, then pushes. If local and remote have diverged, warns and exits with an error without pushing. Skips gracefully if no remote is configured.

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

Files without frontmatter work exactly as they do without it. Timestamps are only injected into files that already have a frontmatter block.

## Agent Integration

- **Normal file I/O**: agents read and write plan files in `.plans/` directly, without shelling out to the CLI for every edit.
- **Structured output**: every read command (`show`, `ls`, `log`, `diff`) supports `--json` for scripting and parsing.
- **Automatic sync**: the auto-commit hook (`apl init --auto-commit`) commits `.plans/` changes automatically after every git commit.

Example agent workflow:

```bash
apl init --auto-commit
# agent writes /.plans/plan.md directly with normal file tools
apl sync                    # push to remote so teammates see it
apl show plan.md --json     # read back structured plan state later
```

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
