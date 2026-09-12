# Linking Plans to Repo Changes

## Problem

Plans drive implementation, but there's no connection between the plan files and the actual code changes they produce. You can't answer "which commits implemented this plan?" or "what plan was this commit part of?" without manually cross-referencing.

## Solution

Track bidirectional links between plan commits and repo commits so you can trace from plan to implementation and back.

### How It Works

**Plan side**: When a plan file is updated, the CLI records the current repo HEAD (the commit on the working branch) as context. This creates a timeline: plan was at version X when the repo was at commit Y.

**Repo side**: A lightweight commit trailer (`Plan-Ref: <plan-commit-hash>`) can be appended to repo commit messages to point back at the plan state that motivated the change. This is opt-in and non-invasive since git already supports arbitrary trailers.

### Data Model

Each plan commit stores optional metadata:

```json
{
  "repo_ref": "abc1234",
  "repo_branch": "feature/auth",
  "linked_commits": ["def5678", "ghi9012"]
}
```

This metadata lives in a `.plan-meta.json` file on the plans branch, keyed by plan file path.

## Implementation

### Wave 1: Passive Tracking

**Task 1: Record repo HEAD on plan writes**
- On `plan add`, capture the current repo HEAD and branch name
- Store in `.plan-meta.json` on the plans branch alongside the plan files
- `plan log` output gains a column showing the associated repo ref

**Task 2: `plan links <file>` command**
- Show the repo commits that were current when each version of a plan was written
- Output: table of plan commit, repo commit, repo branch, timestamp

### Wave 2: Active Linking

**Task 3: `plan link <commit>` command**
- Explicitly associate a repo commit with the current plan state
- Stores the mapping in `.plan-meta.json`
- Can be called after the fact: `plan link abc1234`

**Task 4: Commit trailer injection**
- `plan link --trailer` appends a `Plan-Ref:` trailer to the most recent repo commit (via `git commit --amend`)
- `plan add --link` combines adding a plan update with linking the current repo HEAD
- The trailer is machine-readable so tooling can parse it later

### Wave 3: Querying

**Task 5: `plan trace <file>` command**
- Show a unified timeline: interleaved plan changes and linked repo commits
- Gives a full picture of how a plan evolved alongside the implementation

**Task 6: `plan linked-commits <file>` command**
- List all repo commits linked to a plan file
- Supports `--format` for integration with other tools (e.g., generating changelogs)

## Open Questions

- Should linking be automatic on every `plan add`, or always explicit? Automatic is lower friction but could create noisy links when plans are updated for reasons unrelated to the current branch.
- Should we support linking to PRs in addition to commits? PR numbers are more stable references, but require GitHub API access.
- Is `.plan-meta.json` the right storage, or should links be encoded in the plan commit message itself?
