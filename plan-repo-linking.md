---
title: Linking Plans to Repo Changes
status: draft
tags:
  - cli
  - git
created: 2026-09-11
updated: 2026-09-16
---

# Linking Plans to Repo Changes

## Problem

Plans drive implementation, but there's no connection between plan files and the code changes they produce. You can't answer "which commits implemented this plan?" or "what was the plan state when this commit landed?" without manually cross-referencing git logs on two branches.

This matters most during handoffs. A new developer or agent picking up a plan needs to understand what's already been done, and a plan file alone doesn't tell you that.

## Solution

Record the repo's current HEAD and branch whenever a plan is written, and let users explicitly link repo commits back to plans. This creates a lightweight bidirectional trail between planning and implementation without requiring any workflow changes beyond what `plan add` already does.

### How It Works

**Passive (automatic):** Every `plan add` captures the repo's HEAD commit and branch name as metadata on the plan commit. This happens silently and creates a timeline of "plan was at version X when the repo was at commit Y."

**Active (opt-in):** `plan link <commit>` explicitly associates a repo commit with a plan file. This is for after-the-fact annotation, like marking "these three commits implemented this plan."

### Data Model

Metadata is stored in `.plan-meta.json` on the plans branch, keyed by plan file path:

```json
{
  "plan.md": {
    "snapshots": [
      {
        "plan_commit": "aaa1111",
        "repo_ref": "bbb2222",
        "repo_branch": "feature/auth",
        "timestamp": "2026-09-11T12:00:00Z"
      }
    ],
    "linked_commits": ["ccc3333", "ddd4444"]
  }
}
```

**`snapshots`** are written automatically on each `plan add`. They record the repo state at the time of the plan update.

**`linked_commits`** are written explicitly via `plan link`. They record repo commits that implemented the plan.

Storing this as a separate JSON file rather than encoding it in plan commit messages keeps it queryable without parsing commit logs.

## Implementation

### Wave 1: Passive Tracking (parallel)

**Task 1: Record repo context on `plan add`**
- In `addPlans()`, capture `git rev-parse HEAD` and `git rev-parse --abbrev-ref HEAD` from the main repo before writing to the plans branch
- Read `.plan-meta.json` from the plans branch (or start with `{}`), append a snapshot entry for each file being added, and include it in the `writeFiles` call alongside the plan files
- Skip snapshot if the repo has no commits yet (fresh repo)

**Task 2: Show repo context in `plan log`**
- When displaying log entries, read `.plan-meta.json` and match plan commits to their snapshot entries
- Add a `repo: <short-hash> (<branch>)` column to the human-readable log output
- Include `repo_ref` and `repo_branch` fields in `--json` output

### Wave 2: Active Linking (parallel)

**Task 3: `plan link` command**
- `plan link <file> <commit> [commits...]`: associate one or more repo commits with a plan file
- Reads `.plan-meta.json`, appends to `linked_commits` for that file (deduplicates), writes it back
- Validates that each commit hash resolves in the repo (`git rev-parse --verify`)
- `plan link <file> --last`: shortcut to link the most recent repo commit

**Task 4: `plan links <file>` command**
- Show all links for a plan file: both automatic snapshots and explicit links
- Human output: table with columns for type (snapshot/link), repo commit, branch, date
- Supports `--json`

### Wave 3: Querying

**Task 5: `plan trace <file>`**
- Interleaved timeline of plan changes and linked repo commits, sorted by date
- Each entry shows whether it's a plan update or a repo commit, with the relevant hash and message
- Gives a complete picture of how a plan evolved alongside implementation
- Supports `--json`

## Decisions

**Automatic snapshots on every `plan add`**: Yes. The cost is one extra field in a JSON file per plan update. Noise is minimal because snapshots are only recorded when a plan actually changes, and they're hidden unless you ask for them with `plan links` or `plan log`.

**No commit trailer injection**: The original draft proposed amending repo commits with `Plan-Ref:` trailers. This is invasive (rewrites history), breaks with signed commits, and conflicts with auto-commit workflows. The metadata file approach gets the same information without touching the repo's commit history.

**No PR linking in this phase**: PR numbers require GitHub API access and are platform-specific. Commit hashes are universal. PR linking can be added later as an optional integration.

## Open Questions

- Should `plan trace` also show unlinked repo commits between snapshots (the commits that happened between plan updates)? This would give a more complete timeline but requires walking the repo log, which could be slow on large repos.
- Should `.plan-meta.json` be a single file or per-plan-file (e.g., `.plan-meta/plan.md.json`)? Single file is simpler but could get large in repos with many plans.
