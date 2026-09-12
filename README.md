# plan-storage

Version-controlled plan storage for agent-driven coding workflows, without cluttering your main repo.

## Quick Start

```bash
# Install
npm install -g plan-storage
# or run directly
npx plan-storage

# Initialize in your repo
plan init

# Add a plan file
plan add plan.md

# View plans
plan ls
plan show plan.md

# Sync with teammates
plan sync
```

## Why?

AI coding workflows generate a steady stream of research docs, plans, and handoffs. Committing them to your main repo creates churn and review burden on files that are just markdown. Keeping them local means they can't be shared with teammates or survive a fresh clone. plan-storage solves this by storing plans on a separate git branch with its own history, synced with a single command, so there's never a question of whether or how to commit a plan file.

## Commands

### `plan init [--branch <name>] [--worktree] [--auto-commit]`

Initializes plan storage in the current repo. Creates the orphan branch (default: `plans`) if it doesn't exist, and writes `.plans/config.json`.

- `--branch <name>`: use a branch name other than `plans`
- `--worktree`: also materialize a `.plans/` worktree for direct file access (see below)
- `--auto-commit`: install a git hook that commits worktree changes automatically

```bash
plan init --branch plans --worktree --auto-commit
```

### `plan add <file> [files...] [-m <message>]`

Writes one or more files to the plans branch and commits immediately.

```bash
plan add research.md plan.md -m "Add auth research and plan"
```

### `plan commit [-m <message>]`

Worktree mode only: stages and commits changes made directly in `.plans/`. Without worktree mode, this is a no-op that points you to `plan add`.

```bash
plan commit -m "Update plan after review"
```

### `plan show <path> [--version <ref>] [--json]`

Prints the contents of a plan file. Use `--version` to view a historical revision.

```bash
plan show plan.md
plan show plan.md --version HEAD~2
```

### `plan ls [path] [--json]`

Lists plan files, optionally under a subdirectory.

```bash
plan ls
plan ls research/
```

### `plan log [file] [-n <limit>] [--json]`

Shows commit history for all plans, or for a single file.

```bash
plan log plan.md -n 5
```

### `plan diff <file> [--json]`

Diffs a local file against its last-committed version on the plans branch.

```bash
plan diff plan.md
```

### `plan sync`

Fetches and fast-forwards the local plans ref, then pushes. Skips gracefully if no remote is configured.

```bash
plan sync
```

## How It Works

Plans live on an independent orphan branch (default: `plans`) with its own commit history, unrelated to your main branch. Reads use `git show plans:<path>` and writes use git plumbing (`hash-object`, `mktree`, `commit-tree`, `update-ref`) to commit directly to the branch — none of it touches your working tree or index. Because it's pushed to the same remote as your code, teammates get plans automatically on fetch, with no extra remote or auth setup.

## Worktree Mode

`plan init --worktree` checks out the plans branch into a `.plans/` directory, so agents and editors can read and write plan files with normal file I/O instead of going through the CLI. `plan commit` then stages and commits whatever changed in `.plans/`, same as a regular git commit.

## Agent Integration

- **Structured output**: every read command (`show`, `ls`, `log`, `diff`) supports `--json` for scripting and parsing.
- **Normal file I/O**: worktree mode lets agents read and write plan files directly instead of shelling out to the CLI for every edit.
- **Automatic sync**: the auto-commit hook (`plan init --auto-commit`) keeps `.plans/` committed without a separate step.

Example agent workflow:

```bash
plan init --worktree --auto-commit
# agent writes /.plans/plan.md directly with normal file tools
plan sync                    # push to remote so teammates see it
plan show plan.md --json     # read back structured plan state later
```

## Development

```bash
bun install
bun test
bun run src/index.ts --help
```
