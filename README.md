# agent-plan

Version-controlled plan storage for agent-driven coding workflows, without cluttering your main repo.

## Quick Start

```bash
# Install from a clone of this repo (see Install / Build below)
bun install && bun link

# Initialize in your repo
apl init

# Start a doc from a template; prints the path to edit
apl new plan auth-rewrite

# Or store an existing file
apl add notes.md

# View docs
apl ls
apl show plan/auth-rewrite.md

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

### `apl new <type> <name> [--title <title>] [--tag <tag>]... [--json]`

Creates `.apl/<type>/<name>.md` from the type's template and prints its absolute path, so an agent can capture it and write to it. `<name>` may include directories, such as `billing/stripe-webhooks`. The doc starts at the type's default status. `new` doesn't commit; `commit`, `sync`, or the auto-commit hook record the doc once it has content. It fails if the file already exists.

```bash
apl new research billing/stripe-webhooks --title "Stripe webhook retries" --tag billing
apl new handoff auth-session-3 --json
```

### `apl add <file> [files...] [-m <message>] [--type <type>]`

Copies one or more files into `.apl/` at their repo-relative path, stamps frontmatter timestamps, and commits. With `--type`, the path goes under that type's directory. A file already inside `.apl/` is committed in place. Files outside the repo are rejected.

```bash
apl add research.md plan.md -m "Add auth research and plan"
apl add --type research docs/notes.md    # stored at research/docs/notes.md
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

### `apl ls [path] [--json] [--short] [--type <type>] [--status <status>] [--tag <tag>]`

Lists markdown files in `.apl/`, including uncommitted ones, optionally under a subdirectory. The default output is a table showing filename, type, title, status, and tags. Use `--short` for filename-only output. Use `--type`, `--status`, and `--tag` to filter results (filters combine with AND).

```bash
apl ls
apl ls research/
apl ls --short
apl ls --status active
apl ls --tag cli
apl ls --status active --tag cli
apl ls --type handoff --status open
```

### `apl types [--json]`

Lists the doc types with their statuses, default status, and whether each template is built in or custom.

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

## Document Types

A doc's type is its top-level directory: `.apl/research/billing/stripe.md` is a `research` doc. Docs outside a type directory, like `.apl/notes.md` or `.apl/archive/old.md`, have no type and work as before.

With no configuration there are three types:

| Type | Statuses (first is the default) |
| --- | --- |
| `plan` | `draft`, `active`, `completed`, `archived` |
| `research` | `draft`, `final`, `archived` |
| `handoff` | `open`, `picked-up`, `closed` |

To define your own, commit a `config.json` at the root of the docs branch. When it has a `types` key, that list replaces the built-ins, and because it lives on the branch every teammate gets the same set:

```json
{
  "types": {
    "plan": { "description": "Implementation plans" },
    "handoff": { "statuses": ["open", "picked-up", "closed"] },
    "adr": { "description": "Decision records", "statuses": ["proposed", "accepted", "superseded"] }
  }
}
```

`statuses` defaults to `draft`, `active`, `completed`, `archived`, and `defaultStatus` defaults to the first status. Type names are lowercase letters, digits, and dashes.

Templates for `apl new` come from `.apl/.templates/<type>.md` when that file exists, and otherwise from a built-in one. These placeholders are filled in: `{{title}}`, `{{status}}`, `{{type}}`, `{{name}}`, `{{date}}`, and `{{branch}}` (the current code branch). Files under dot-directories such as `.templates/` never appear in `ls` or completion.

## Frontmatter Metadata

Docs can include optional YAML frontmatter for richer display and filtering:

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
- **status**: One of the doc type's statuses (see Document Types). A status that isn't valid for the type is ignored with a warning, and the file is left unchanged.
- **tags**: Array of free-form strings for categorization
- **created**: ISO date, auto-set on first `apl add`
- **updated**: ISO date, auto-set on every `apl add` and `apl commit`

Other keys are kept as written. Stamping changes only the `created` and `updated` lines, so comments, key order, and formatting are left alone. Timestamps are only injected into files that already have a frontmatter block.

## Agent Integration

- **Normal file I/O**: agents read and write docs in `.apl/` directly, without shelling out to the CLI for every edit.
- **Structured output**: every read command (`show`, `ls`, `log`, `diff`) supports `--json` for scripting and parsing.
- **Automatic sync**: the auto-commit hook (`apl init --auto-commit`) commits `.apl/` changes automatically after every git commit.

Example agent workflow:

```bash
apl init --auto-commit
f=$(apl new plan auth-rewrite)   # agent writes to "$f" with normal file tools
apl sync                         # push to remote so teammates see it
apl show plan/auth-rewrite.md --json   # read back structured state later
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
