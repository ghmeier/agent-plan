# Frontmatter Metadata for Plan Files

## Problem

`plan ls` shows a flat list of filenames with no context. To understand what a plan is about, you have to `plan show` each one. This makes it hard to quickly find the right plan, especially as the number of plans grows.

## Solution

Support YAML frontmatter in plan files. Parse it on read and use it to enrich CLI output and enable filtering.

### Frontmatter Format

```markdown
---
title: Frontmatter Metadata
status: active
tags: [cli, ux]
created: 2026-09-11
---

# Plan content here...
```

### Supported Fields

- **title**: Short display name (used in `plan ls` output instead of filename)
- **status**: One of `draft`, `active`, `completed`, `archived`
- **tags**: Array of free-form strings for categorization
- **created**: ISO date, auto-set on `plan add` if missing
- **updated**: ISO date, auto-set on each `plan add`

All fields are optional. Files without frontmatter work exactly as they do today.

## Implementation

### Wave 1: Parsing

**Task 1: Frontmatter parser (`src/lib/frontmatter.ts`)**
- Parse YAML frontmatter from markdown content using a small parser (gray-matter or hand-rolled regex for the `---` fences + `yaml` package)
- Return typed `PlanMeta` with the supported fields plus a `content` string (body without frontmatter)
- Round-trip safe: serializing parsed meta back produces valid frontmatter
- Auto-populate `created` and `updated` timestamps when writing

### Wave 2: CLI Integration

**Task 2: Enrich `plan ls` output**
- Default output becomes a table: `filename | title | status | tags`
- Align columns for readability
- `--short` flag for filename-only output (current behavior)

**Task 3: Add `--status` and `--tag` filters to `plan ls`**
- `plan ls --status active` filters to plans with that status
- `plan ls --tag cli` filters to plans containing that tag
- Filters combine with AND

**Task 4: Show frontmatter in `plan show`**
- Print a short header block before the content showing title, status, tags, created, updated
- `--raw` flag skips the header and prints the file as-is (current behavior)

### Wave 3: JSON Support

**Task 5: Include metadata in `--json` output**
- `plan ls --json` includes parsed frontmatter fields per entry
- `plan show --json` includes metadata alongside content
