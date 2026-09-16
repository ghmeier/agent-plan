---
title: Shell Autocomplete
status: completed
tags:
  - cli
  - ux
  - completion
created: 2026-09-11
updated: 2026-09-16
---

# Shell Autocomplete

## Problem

Users have to remember subcommand names and flags. Tab completion is table stakes for CLI tools, and without it `plan` feels unfinished compared to `git`, `gh`, etc.

## Solution

Generate shell completion scripts for bash, zsh, and fish. Commander.js has built-in support for generating completions, but it only covers subcommands and flags. We also want dynamic completions for plan file paths (e.g., `plan show <tab>` lists stored plans).

### User Experience

```bash
plan <tab>
# → add  commit  diff  init  log  ls  show  sync

plan show <tab>
# → cli-distribution.md  frontmatter-metadata.md  plan-repo-linking.md

plan show --<tab>
# → --version  --json  --raw

plan ls --status <tab>
# → draft  active  completed  archived
```

## Implementation

### Wave 1: Static Completions

**Task 1: Generate completion scripts**
- Use Commander's `program.completionScript()` or write custom scripts that enumerate subcommands and their flags
- Support bash, zsh, and fish
- Add `plan completion <shell>` command that prints the appropriate script
- Install instructions: `eval "$(plan completion zsh)"` in `.zshrc` (or equivalent)

**Task 2: `plan completion --install` shortcut**
- Detect the current shell from `$SHELL`
- Append the `eval` line to the appropriate rc file (`.zshrc`, `.bashrc`, `config.fish`)
- Idempotent: skip if the line already exists
- Print what was added and where

### Wave 2: Dynamic Completions

**Task 3: Complete plan file paths**
- `plan show`, `plan log`, `plan diff` should complete against the list of files on the plans branch
- The completion function calls `plan ls --short` (or a faster internal `plan __complete files` hidden subcommand) and returns the results
- Handle the case where plans aren't initialized (return no completions, don't error)

**Task 4: Complete flag values**
- `--status` completes against known status values
- `--tag` completes against tags that exist in current plan files (requires reading frontmatter, depends on the frontmatter feature)
- `--version` on `plan show` completes against commit hashes from `plan log`

### Wave 3: Polish

**Task 5: Hidden `__complete` subcommand**
- Add `plan __complete <context>` that outputs completion candidates, one per line
- Subcommands: `plan __complete files [prefix]`, `plan __complete tags`, `plan __complete statuses`
- Faster than parsing full command output; keeps completion scripts thin
- Hidden from `--help` output

## Open Questions

- Commander.js added completion support recently — worth checking if the latest version handles enough of this out of the box before writing custom scripts.
- Should `plan completion --install` back up the rc file before modifying it?
- Fish completions use a different mechanism (individual `complete` commands) — worth supporting from day one or defer?
