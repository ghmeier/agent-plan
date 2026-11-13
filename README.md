# agent-plan

Enhance document-driven agentic coding workflows with any coding harness by automagically syncing your documentation across worktrees and checkouts without cluttering your codebase.

## Quick Start

```bash
# Install with your package manager.
npm i -g @ghmeier/agent-plan@latest

# Initialize in your repo
apl init

# Start a doc from a template; prints the path to edit
apl new plan auth-rewrite

# Or store an existing file
apl add notes.md

# View docs
apl ls
apl show plan/auth-rewrite.md

# Search docs
apl search auth rewrite

# Sync with remote
apl sync
```

## Why?

Picture this: you're building dozens of new features, each with it's own plan, research, and handoff documents to share context across sessions. This creates a steady stream of markdown documents that are ideally at least organized in a folder, but could end up in all sorts of dusty locations on your laptop, in your sandbox, or in some data center somewhere. You're not the only one; the rest of your team is doing the same thing.

What do you do with all this text? On one hand, it's useful when you forget what you worked on a month ago (or last week, let's be honest). On the other, it's such a chore to get everyone to agree on which updates to commit, where to put them, and how to keep them organized. If you make the LLM do it, you'll end up with slight differences when it just decides to ignore your instructions. You'll probably end up in an annoying split-state where _some_ documents get faithfully updated, others are left _partially_ updated, and more are just left unstaged until they're inevitably deleted.

Agent-plan solves the documentation problem by building it into your coding workflow. Documents are stored on a separate branch where they're isolated from the rest of your code, symlinked across all your worktrees so they're still easy to access in-context, and automatically synced with the rest of the team.

There's no more deciding where and when things are committed: they just are. Even better, updates are synced immediately so sharing projects with the team is a cinch. Because it's all managed in git, documents are tied to the implementation branch and you (or your LLM) can dig into the blame for each document update if you're into that kind of thing. As an added bonus, since documents are managed deterministically, you can create templates that are always applied and easily searchable by keyword, date, or your ticketing system's ids.

## Install

```bash
npm i -g @ghmeier/agent-plan@latest
```

apl runs on macOS and Linux, and needs supports Node 22+ or Bun (`bun i -g` works too). Without Node, install the standalone binary from the [latest release](https://github.com/ghmeier/agent-plan/releases):

```bash
curl -fsSLO https://github.com/ghmeier/agent-plan/releases/latest/download/install.sh && less install.sh && sh install.sh
```

## Configuration

### Document Types

Documents can be automatically grouped into folders, filtered, and have custom statuses using document types. By default agent-plan has the following:

| Type       | Statuses                                   |
| ---------- | ------------------------------------------ |
| `plan`     | `draft`, `active`, `completed`, `archived` |
| `research` | `draft`, `final`, `archived`               |
| `handoff`  | `open`, `picked-up`, `closed`              |

Document types are configurable by creating `config.json` at the root of the docs branch (`.apl` by default). For example:

```json
{
  "types": {
    "plan": { "description": "Implementation plans" },
    "handoff": { "statuses": ["open", "picked-up", "closed"] },
    "adr": {
      "description": "Decision records",
      "statuses": ["proposed", "accepted", "superseded"]
    }
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

For easier cross-referencing and integration with other tooling, docs can be manually (or automagically) linked to branches. That allows you to later track which commits related to a given plan.

```bash
# Link plan/billing to the current branch.
apl link plan/billing

# Link plan/billing to a specific branch.
apl link plan/billing --branch feature/billing

# List all links.
apl links

# List all branches linked to plan/billing.
apl links plan/billing

# List all documents linked to a specific branch.
apl links --branch feature/billing

# Remove a link.
apl unlink plan/billing --branch feature/billing
```

Links are stored in two ways:

- **In the repo's git config**, as `branch.<name>.apl-doc`.
- **On the agent-plan branch**, as an empty commit with commented `Linked-Doc`, `Code-Branch`, and `Code-Commit`.

## Agent Usage

- **Normal file I/O**: agents read and write docs in `.apl/` directly. `apl new` creates a doc and returns it's path.
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

Codex skips plugin hooks until you trust them, so run `/hooks` in a Codex session and trust the two agent-plan hooks.

## Shell Completion

Tab completion is available for bash, zsh, and fish:

```bash
# Add it to your shell config automatically
apl completion --install
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

Development uses Bun; the published CLI runs on Node.

```bash
bun run build          # bundles dist/apl.js, the Node CLI npm publishes
bun run test:dist      # runs the tests against dist/apl.js under Node
bun run build:binary   # compiles a standalone dist/apl
```

To link the CLI globally from a clone:

```bash
bun install && bun link
apl --help
```

### Releasing

Bump `version` in `package.json` and push a matching `v*` tag. `publish.yml` creates a GitHub release with attested binaries and publishes to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers) (configure it on npmjs.com for workflow `publish.yml`, environment `release`).
