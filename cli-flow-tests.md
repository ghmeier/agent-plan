---
title: CLI Flow Tests
status: completed
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

## Outcome

Merged to `main` in three commits: the auto-commit hook fix, the `show --at` rename, and the test rewrite. The rebase onto `main` also ported the two tests from "Refuse to overwrite an existing .plans" into the new style.

- The suite is now 99 tests in six files (`init`, `authoring`, `reading`, `sync`, `checkouts`, `completion`) plus `test/harness.ts`. Nothing under `test/` imports from `src/`.
- `bunfig.toml` runs every test file concurrently. The suite takes about 13 seconds, down from 23, and passed four runs in a row with no flakes.
- Tests planned as `worktrees.test.ts` and an auto-commit file were combined into `checkouts.test.ts`.

### Bugs found by driving the real CLI

1. **`apl show --version <ref>` never worked.** The program-wide `-V, --version` flag consumed `--version` even after the subcommand, so the CLI printed `0.1.0`. Fixed by renaming the flag to `apl show --at <ref>`, including shell completions and the README.
2. **The `--auto-commit` hook never committed anything.** Git runs hooks with `GIT_INDEX_FILE=.git/index`; inside `.plans/`, `.git` is a file, so `apl commit` failed and the hook's `2>/dev/null || true` hid the error. Fixed in `src/lib/hooks.ts` by unsetting `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_INDEX_FILE` before calling `apl`. Hooks that are already installed keep the broken script until someone runs `apl init --no-auto-commit` and then `apl init --auto-commit`.

### Noted, not changed

- Because `.plans/` is a worktree of the same repo, it shares `.git/hooks`. Every plan commit runs the user's own `post-commit` hook, and the auto-commit hook calls itself once more (the nested call finds nothing to commit).
- `apl completion fish --install` fails if `~/.config/fish/` does not exist yet.

### Dropped on purpose

Checks that only covered internals: the `Git` class, config file location, hook file contents and idempotence, the `.plans` entry in `info/exclude`, the `__complete` fallback when `.plans/` is missing, and substring checks on completion script text (real-shell completion tests now cover the scripts).
