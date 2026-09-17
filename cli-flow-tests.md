---
title: CLI Flow Tests
status: active
tags:
  - tests
created: 2026-09-17
updated: 2026-09-17
---

# CLI Flow Tests

## Goal

Replace the current tests, which import command functions and internal library modules, with tests that drive the real `apl` binary as a subprocess and assert only on what a user can observe: stdout, stderr, exit codes, files in `.plans/`, and git history on the plans branch and remote.

## Problems with the current suite

- Most command tests call exported functions (`addPlans`, `listPlans`, `showPlan`) with a `cwd` argument, and capture output by monkey-patching `console.log` and `process.stdout.write`. None of them exercise argument parsing, the error handler in `src/index.ts`, or exit codes.
- Several tests assert on implementation details: the `Git` class, `readConfig`/`writeConfig`, hook helpers (`installAutoCommitHook`, `hasAutoCommitHook`), `resolvePlanPath`, `findRepoRoot`, and the shape of the completion script text. Refactoring any of these breaks tests without changing behavior.
- Coverage is duplicated across files: `json.test.ts`, `read.test.ts`, and `frontmatter.test.ts` all test `show`/`ls` output; `worktree.test.ts` and `init.test.ts` both test init idempotence and that config is not committed.
- The auto-commit hook is only tested by reading the hook file. Nothing checks that a commit in the main repo actually commits plan changes.
- Tests inherit the developer's global git config, so settings like commit signing or global hooks can change results.

## Approach

1. **Harness (`test/harness.ts`)**
   - `apl(args, { cwd, env })` spawns `bun src/index.ts` with `NO_COLOR=1` and returns `{ stdout, stderr, exitCode }`.
   - Git runs with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` for isolation.
   - Fixtures are `AsyncDisposable` so tests use `await using` instead of `try/finally`: an empty repo, a repo initialized through `apl init` (copied from a template built once per run, with paths fixed by `git worktree repair`), a bare remote, a clone of that remote, and a secondary `git worktree`.
   - A `PATH` directory holding an `apl` shim, used by the auto-commit hook and the shell completion tests.
   - `git(dir, args)` stays available for arranging external state (remotes, commits in the main repo) and for checking what landed on the remote.

2. **Test files, organized by user flow**
   - `test/init.test.ts`: init output and idempotence, `.plans` ignored by the main repo, `--branch` honored by later commands, errors outside a repo and before init, init from a remote that already has the plans branch.
   - `test/authoring.test.ts`: `add` (single, multiple, from a subdirectory, absolute path, missing file, custom message), editing in `.plans/` followed by `diff` and `commit`, "Nothing to commit", timestamp stamping on `add` and `commit`.
   - `test/reading.test.ts`: `show` (header, `--raw`, `--json`, `--version`, missing file, malformed or invalid frontmatter), `ls` (table, `--short`, `--json`, `--status`/`--tag`, subdirectory, uncommitted files), `log` (`-n`, file filter, `--json`), `diff --json`.
   - `test/sync.test.ts`: two clones collaborating through a bare remote, divergence warning, no remote, fetch failure, push failure, relative remote URL.
   - `test/worktrees.test.ts`: plans shared between the main checkout and a secondary worktree; auto-commit hook installed, triggered by a real `git commit`, coexisting with an existing hook, and removed with `--no-auto-commit`.
   - `test/completion.test.ts`: keep the real-shell tests, but get scripts from `apl completion <shell>`; run `__complete` and `completion --install` through the CLI with a temporary `HOME`; drop the substring checks on script text.

3. **Remove** `test/lib/*`, `test/helpers.ts`, `test/helpers.test.ts`, and `test/commands/*` once their behavior is covered by the flow tests.

## Verification

- `bun test`, `bun run typecheck`, and `bun run lint` pass.
- Every behavior in the removed tests maps to a flow test, or is dropped on purpose because it only checked internals.
- Suite time stays near the current ~23 seconds.
