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

Files live on an independent orphan branch (default: `apl`), checked out as a git worktree at `.apl` in the main checkout. The plan folder is visible in every other checkout (from `git worktree add`) via a symlink to `.apl`. Agents and editors read and write files under `.apl/` with normal file I/O. `apl commit` stages and commits whatever changed. Because the branch is pushed to the same remote as your code, teammates get docs automatically.

## Configuration

### Document Types

Documents can be automatically grouped into folders, filtered, and have custom statuses using document types. By default agent-plan has the following:

| Type | Statuses |
| --- | --- |
| `plan` | `draft`, `active`, `completed`, `archived` |
| `research` | `draft`, `final`, `archived` |
| `handoff` | `open`, `picked-up`, `closed` |

Document types are configurable by creating `config.json` at the root of the docs branch (`.apl` by default). For example:

```json
{
  "types": {
    "plan": { "description": "Implementation plans" },
    "handoff": { "statuses": ["open", "picked-up", "closed"] },
    "adr": { "description": "Decision records", "statuses": ["proposed", "accepted", "superseded"] }
  }
}
```

In addition to separating documents by folders, document types can also pull from different default templates used by `apl new`. Document type templates are located in `.apl/.templates/<type>.md`. Templates have the following placeholder variables automatically inserted: `{{title}}`, `{{status}}`, `{{type}}`, `{{name}}`, `{{date}}`, and `{{branch}}`.

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
- **status**: One of the doc type's statuses (see Document Types).
- **tags**: Array of free-form strings for categorization
- **created**: ISO date, auto-set on first `apl add`
- **updated**: ISO date, auto-set on every `apl add` and `apl commit`

## Agent Usage

- **Normal file I/O**: agents read and write docs in `.apl/` directly, without shelling out to the CLI for every edit. `apl new` prints the path to write to.
- **Structured output**: `show`, `ls`, `log`, `diff`, `status`, `types`, and `new` support `--json`.

### Claude Code setup

Integrate `agent-plan` automatically into Claude code using the provided plugin. The plugin includes a skill explaining usage as well as two hooks:

- **SessionStart** runs `apl pull`, tells the agent to load the skill, and shows it open handoffs. It also creates the `.apl` link in a new worktree.
- **Stop** runs `apl sync --if-changed` in the background after each turn.

Install the plugin by adding it to `.claude/settings.json`:

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

Or manually using the claude CLI:

```bash
claude plugin marketplace add ghmeier/agent-plan
claude plugin install agent-plan@agent-plan
```


## Shell Completion

Tab completion is available for bash, zsh, and fish:

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
