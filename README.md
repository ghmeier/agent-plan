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
apl search auth rewrite

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

## Linking Docs to Branches

A doc can be linked to the code branches that implement it, so you can go from a plan to its branches and from a branch to its plan without searching.

```bash
# On a work branch: link a doc to it
apl link plan/billing

# From anywhere: link a doc to a named branch
apl link plan/billing --branch feature/billing

# Every link, the links of one doc, or the docs of one branch
apl links
apl links plan/billing
apl links --branch feature/billing   # no name means the current branch

apl unlink plan/billing --branch feature/billing
```

The link is stored in two places, and neither is a file:

- **In the code repo's git config**, as `branch.<name>.apl-doc`. Every checkout of your clone shares it, and git removes it when the branch is deleted. It tells apl which branches to watch.
- **On the docs branch**, as an empty commit whose trailers (`Linked-Doc`, `Code-Branch`, `Code-Commit`) name the doc, the branch, and the branch's tip. This is what `apl links` reads. It is synced to teammates and stays after the branch is deleted.

Every `apl commit` and `apl sync` records a new commit for each linked branch whose tip has moved, from any checkout. A session on the default branch therefore records the commits an implementer made on a work branch. The default branch and the docs branch can't be linked.

Most links are made for you. Running `apl show` on a doc from a work branch links it to that branch, and so does the Claude Code plugin: its hook runs after the agent reads, edits, or writes a file under `.apl/` and links that doc to the branch of the checkout the agent works in. This only writes the git config part, so it adds no commit and never fails the read. The next `apl commit` or `apl sync` records it on the docs branch. Use `apl link` for work that never opens the doc itself, such as an orchestrator that pastes a section of a plan into a subagent's prompt.

To read links back:

```bash
# Print every doc linked to a branch (the current branch when no name), for starting a session with its plan
apl show --branch
apl show --branch feature/billing --section Rollout   # --outline, --section, and --raw apply to each doc

# List only the docs linked to a branch
apl ls --branch feature/billing

# Docs-branch edits to a doc while the branch was being worked on
apl links plan/billing --branch feature/billing --edits

# Link commits are hidden from the log unless asked for
apl log --links
```

`show --json` and `ls --json` include a `links` array for each doc, with each linked branch's `branch`, `commit`, `pr`, `merged`, and `prState`. These commands only read: they never record links.

## Agent Usage

- **Normal file I/O**: agents read and write docs in `.apl/` directly, without shelling out to the CLI for every edit. `apl new` prints the path to write to.
- **Structured output**: `show`, `ls`, `search`, `links`, `log`, `diff`, `status`, `types`, and `new` support `--json`.

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

### Codex setup

The same plugin works in Codex, with the same skill and hooks. Add the marketplace and install the plugin:

```bash
codex plugin marketplace add ghmeier/agent-plan
codex plugin add agent-plan@agent-plan
```

Codex skips plugin hooks until you trust them, so run `/hooks` in a Codex session and trust the two agent-plan hooks. Codex can't wake the agent from a background hook, so if publishing doc edits after a turn hits a conflict, it shows up at the next session start instead of right away. Run `codex plugin marketplace upgrade` to pick up plugin updates.


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
