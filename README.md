# agent-plan

Version-controlled plan storage for agent-driven coding workflows, without cluttering your main repo.

## Quick Start

```bash
# Install (requires Bun); run it again to update
bun i -g @ghmeier/agent-plan@latest

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

Docs live on an independent orphan branch (default: `apl`), checked out as a git worktree at `.apl` in the main checkout. Every other checkout (from `git worktree add`) gets a `.apl` symlink to it, and `.apl` is listed in `.git/info/exclude` so the code repo never sees it. The store stays out of `.git/` because Claude Code asks for approval before every write there, even through a symlink, and no permission rule can pre-approve it. A bare repo has no main checkout, so its store stays at `.git/agent-plan/worktree`. Agents and editors read and write files under `.apl/` with normal file I/O. `apl commit` stages and commits whatever changed. Because the branch is pushed to the same remote as your code, teammates get docs automatically on fetch, with no extra remote or auth setup.

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

Creates `.apl/<type>/<name>.md` from the type's template and prints its absolute path, so an agent can capture it and write to it. `<name>` may include directories, such as `billing/stripe-webhooks`; a leading `<type>/` is dropped. Without `--title`, the title comes from the file name, minus any leading date: `2026-10-01-stripe-webhooks` becomes "Stripe webhooks". The doc starts at the type's default status. `new` doesn't commit; `commit`, `sync`, or the auto-commit hook record the doc once it has content. It fails if the file already exists.

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

Stages and commits all pending changes in `.apl/`. Stamps `updated` timestamps into any modified markdown files that have frontmatter. The default message names the changed files. Files over 1 MB are left uncommitted with a warning, so data an agent saves next to its notes isn't pushed to the shared remote; use `apl add` to commit one on purpose.

apl's commits and pushes skip the code repo's git hooks (`--no-verify`), since hooks written for code, like pre-commit's, don't apply to the docs branch.

```bash
apl commit
apl commit -m "Update plan after review"
```

### `apl show <path> [--at <ref>] [--json] [--raw]`

Prints the contents of a doc. Reads from `.apl/<path>` directly, so uncommitted edits are visible. The `.md` extension is optional. Use `--at` to read a historical revision from git history.

```bash
apl show plan.md
apl show plan.md --raw
apl show plan.md --at HEAD~2
```

### `apl ls [path] [--json] [--short] [--type <type>] [--status <status>] [--tag <tag>]`

Also available as `apl list`. Lists markdown files in `.apl/`, including uncommitted ones, optionally under a subdirectory, most recently updated first. The default output is a table showing filename, type, title, status, last update, and tags. Use `--short` for filename-only output. Use `--type`, `--status`, and `--tag` to filter results (filters combine with AND).

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

### `apl sync [--if-changed]`

Commits any pending changes in `.apl/`, rebases them onto the remote branch, then pushes. If a teammate edited the same lines, sync aborts the rebase, names the conflicting files, and exits with an error without pushing; your local commits are left as they were. Skips gracefully if no remote is configured.

`--if-changed` does nothing, not even a fetch, unless there are local changes to publish, which suits hooks that run often.

`commit`, `add`, and `sync` refuse to run while a rebase or merge inside `.apl/` is unfinished, so conflict markers are never committed as plan content.

```bash
apl sync
```

### `apl pull [--quiet]`

Brings in teammates' doc changes without pushing. Pending edits are committed locally first, then rebased onto the remote branch, the same way `sync` does it.

### `apl status [--json]`

Shows where the store is, how many commits this checkout is ahead of or behind the remote as of the last fetch (`apl pull` refreshes it), uncommitted files, and any unfinished rebase or merge. It also creates the `.apl` link in a checkout that doesn't have one yet.

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

- **Normal file I/O**: agents read and write docs in `.apl/` directly, without shelling out to the CLI for every edit. `apl new` prints the path to write to.
- **Structured output**: `show`, `ls`, `log`, `diff`, `status`, `types`, and `new` support `--json`, and output is uncolored when it isn't going to a terminal.
- **Finding docs**: `.apl` is git-ignored (and a symlink outside the main checkout), so ripgrep-based search tools skip it unless given the path explicitly (for example Grep with `path: ".apl"`).
- **Editing from other checkouts**: in a checkout made with `git worktree add`, `.apl` links to the main checkout, which is outside that session's working directory. Claude Code asks before writing there unless an allow rule such as `Edit(//path/to/main-checkout/.apl/**)` matches, or the main checkout's `.apl` is added with `/add-dir` or `additionalDirectories`.

### Claude Code setup

This repo is also a Claude Code plugin marketplace. The `agent-plan` plugin (in `plugins/agent-plan/`) bundles a skill that teaches agents to look for earlier docs, create them with `apl new`, leave publishing to the Stop hook, and write handoffs, plus two hooks:

- **SessionStart** runs `apl pull`, tells the agent to load the skill, and shows it open handoffs. It also creates the `.apl` link in a new worktree.
- **Stop** runs `apl sync --if-changed` after each turn, which publishes doc edits and skips the network when there are none. A conflict is reported rather than resolved.

Both hooks do nothing in a repo whose clone has no docs branch yet, so the plugin can be enabled for your user without affecting other repos. Run `apl init` once in a clone to turn them on there. With these hooks, the git post-commit hook (`apl init --auto-commit`) isn't needed. If `apl` isn't installed, the Stop hook does nothing and the SessionStart hook tells the agent how to install it.

To turn it on for everyone working in a repo, commit this to the repo's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "agent-plan": {
      "source": { "source": "github", "repo": "ghmeier/agent-plan" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "agent-plan@agent-plan": true }
}
```

Teammates are asked to install the marketplace the first time they trust the repo in Claude Code, and the plugin then updates itself. Each teammate still installs the CLI with `bun i -g @ghmeier/agent-plan@latest`.

To use it yourself without changing a repo's settings, install it for your user:

```bash
claude plugin marketplace add ghmeier/agent-plan
claude plugin install agent-plan@agent-plan
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

Install the latest release globally with Bun, which puts `apl` on `PATH` (in `~/.bun/bin`). Run the same command to update:

```bash
bun i -g @ghmeier/agent-plan@latest
apl --version
```

For local development, link the CLI globally from a clone instead:

```bash
bun install && bun link
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

## Releasing

```bash
bun pm version patch   # or minor / major: bumps package.json, commits, and tags vX.Y.Z
git push --follow-tags
```

Pushing the tag runs `.github/workflows/publish.yml`, which checks the tag matches `package.json`, then typechecks, lints, tests, and publishes to npm. The workflow needs an npm automation token in the repo's `NPM_TOKEN` secret.
