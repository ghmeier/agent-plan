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

## Commands

### `apl init [--branch <name>] [--worktree] [--auto-commit]`

Initializes plan storage in the current repo. Creates the orphan branch (default: `plans`) if it doesn't exist, and writes `.plans/config.json`.

- `--branch <name>`: use a branch name other than `plans`
- `--worktree`: also materialize a `.plans/` worktree for direct file access (see below)
- `--auto-commit`: install a git hook that commits worktree changes automatically

```bash
apl init --branch plans --worktree --auto-commit
```

### `apl add <file> [files...] [-m <message>]`

Writes one or more files to the plans branch and commits immediately.

```bash
apl add research.md plan.md -m "Add auth research and plan"
```

### `apl commit [-m <message>]`

Worktree mode only: stages and commits changes made directly in `.plans/`. Without worktree mode, this is a no-op that points you to `apl add`.

```bash
apl commit -m "Update plan after review"
```

### `apl show <path> [--version <ref>] [--json] [--raw]`

Prints the contents of a plan file. Frontmatter fields are shown in a header block above the body. Use `--raw` to print the file exactly as stored (including the frontmatter fences). Use `--version` to view a historical revision.

```bash
apl show plan.md
apl show plan.md --raw
apl show plan.md --version HEAD~2
```

### `apl ls [path] [--json] [--short] [--status <status>] [--tag <tag>]`

Lists plan files, optionally under a subdirectory. The default output is a table showing filename, title, status, and tags. Use `--short` for the original filename-only output. Use `--status` and `--tag` to filter results (filters combine with AND).

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
apl log plan.md -n 5
```

### `apl diff <file> [--json]`

Diffs a local file against its last-committed version on the plans branch.

```bash
apl diff plan.md
```

### `apl sync`

Fetches and fast-forwards the local plans ref, then pushes. Skips gracefully if no remote is configured.

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

## How It Works

Plans live on an independent orphan branch (default: `plans`) with its own commit history, unrelated to your main branch. Reads use `git show plans:<path>` and writes use git plumbing (`hash-object`, `mktree`, `commit-tree`, `update-ref`) to commit directly to the branch — none of it touches your working tree or index. Because it's pushed to the same remote as your code, teammates get plans automatically on fetch, with no extra remote or auth setup.

## Worktree Mode

`apl init --worktree` checks out the plans branch into a `.plans/` directory, so agents and editors can read and write plan files with normal file I/O instead of going through the CLI. `apl commit` then stages and commits whatever changed in `.plans/`, same as a regular git commit.

## Agent Integration

- **Structured output**: every read command (`show`, `ls`, `log`, `diff`) supports `--json` for scripting and parsing.
- **Normal file I/O**: worktree mode lets agents read and write plan files directly instead of shelling out to the CLI for every edit.
- **Automatic sync**: the auto-commit hook (`apl init --auto-commit`) keeps `.plans/` committed without a separate step.

Example agent workflow:

```bash
apl init --worktree --auto-commit
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
