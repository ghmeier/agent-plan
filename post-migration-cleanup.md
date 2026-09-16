---
title: Post-Migration Cleanup
status: active
tags:
  - cleanup
  - completion
  - tests
  - docs
created: 2026-09-16
updated: 2026-09-16
---

# Post-Migration Cleanup

## Problem

Frontmatter metadata, shell autocomplete, and the move to worktree-only storage are all merged, but a review turned up loose ends:

- Bash completion fails for anyone without the bash-completion package, including the stock macOS bash 3.2. The fallback branch in `bashScript()` (`src/commands/completion.ts`) evaluates `$((${COMP_WORDS[@]} - 1))`, which raises `syntax error in expression` and aborts the completion function.
- Completion tests only assert on the generated script text. Nothing runs the scripts in a real shell, which is how the bug above shipped.
- `GitPlumbing.readFile`, `listFiles`, and `getLog` in `src/lib/git.ts` are only called from tests. They read from the branch, which the app no longer does.
- `add.test.ts`, `frontmatter.test.ts`, and `git.test.ts` verify results through those branch readers instead of the `.plans/` worktree the app uses.
- `complete.ts` duplicates `listMarkdownFiles` from `ls.ts`.
- `PLAN.md` still describes plumbing writes, an optional worktree, and `.plans/config.json`.
- The repo `.gitignore` still carries a `.plans/` entry from the old `init`; `info/exclude` handles this now.
- 13 stale agent worktrees from the initial build remain at `~/git/plan-storage.agent-*`. Twelve are patch-equivalent to main; `agent-a70b7065256847934` (original worktree mode) was superseded. None have uncommitted changes.

## Implementation

### Wave 1 (all parallel)

**Task 1: Fix bash completion fallback**
- In `bashScript()`, drop the `COMP_WORDS=($COMP_LINE)` reassignment and the broken `cword` arithmetic; the function only uses `COMP_WORDS`, `COMP_CWORD`, `cur`, and `prev`, which bash already provides.
- Set `cur` and `prev` from `COMP_WORDS[COMP_CWORD]` in both branches so behavior is identical with and without `_init_completion`.

**Task 2: Execute completion scripts in real shells**
- Add tests that source the generated script and invoke the completion function with a simulated command line, asserting on the candidates returned:
  - bash: set `COMP_WORDS`, `COMP_CWORD`, call `_apl_completions`, read `COMPREPLY`. Run under `/bin/bash` so the no-bash-completion path is covered.
  - zsh: at minimum, `zsh -n` syntax check plus loading the script under `compinit`; skip if zsh is absent.
  - fish: `fish --no-execute` syntax check, and `complete --do-complete "apl sh"` for candidates; skip if fish is absent.
- Cover: subcommand names, `show <tab>` file names, `ls --status <tab>`, `ls --tag <tab>`, flag lists.
- Put `apl` on `PATH` for these tests via a small shim script in the temp dir that runs `bun <repo>/src/index.ts "$@"`.
- Add the reproduction for Task 1: bash completion of `apl sh` returns `show` without `_init_completion` defined.

**Task 3: Remove dead branch readers and share file listing**
- Delete `readFile`, `listFiles`, and `getLog` (and `LogEntry` if unused) from `GitPlumbing`.
- Rename `GitPlumbing` to `Git` (or similar) since plumbing is no longer its purpose; update imports in `init.ts`, `add.ts`, `sync.ts`, `worktree.ts`.
- Move `listMarkdownFiles` to `src/lib/` and use it from both `ls.ts` and `complete.ts`.
- Keep the branch fallback in `complete.ts`: completions must not create the worktree on a tab press.

**Task 4: Update PLAN.md and .gitignore**
- Rewrite the Architecture section of `.plans/PLAN.md`: `.plans/` is always a worktree on the orphan branch, secondary checkouts symlink to it, config lives at `<git-common-dir>/agent-plan/config.json`, and `.plans` is excluded via `info/exclude`.
- Mark Task 10 (worktree mode) as superseded by always-on worktree storage, and remove the plumbing `writeFiles` steps from Task 3.
- Remove `.plans/` from the repo `.gitignore`.

### Wave 2

Depends on Task 3.

**Task 5: Verify tests through the worktree**
- Replace `git.readFile(...)` assertions in `add.test.ts` and `frontmatter.test.ts` with reads from `.plans/` on disk, plus `git -C .plans show HEAD:<file>` where the test is asserting the change was committed.
- Delete the `readFile` / `listFiles` / `getLog` cases from `test/lib/git.test.ts`; keep coverage for `exec`, `branchExists`, and `createOrphanBranch`.
- Run `bun test`, `bun run lint`, and `bun run typecheck`.

### Wave 3

**Task 6: Remove stale agent worktrees**
- Before removing, re-confirm each is clean and that `git cherry main <branch>` shows no unmerged work other than `agent-a70b7065256847934`.
- `git worktree remove ~/git/plan-storage.agent-<id>` and `git branch -D agent-<id>` for all 13.
- `git worktree prune`.

## Coordination

A separate effort to speed up the test suite (see `test-suite-speed.md`) runs in parallel and will likely touch `test/helpers.ts` and shared setup. Tasks 2 and 5 touch test files; rebase on whichever lands first.
