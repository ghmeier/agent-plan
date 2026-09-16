---
title: Test Suite Speed
status: completed
tags:
  - performance
  - tests
created: 2026-09-16
updated: 2026-09-16
---

# Test Suite Speed

## Problem

`bun test` runs 130 tests across 15 files in ~48 seconds. The suite runs serially (total wall time ≈ sum of per-file times), and nearly all the time is git subprocess overhead.

### Per-file timings (wall clock, individual runs)

| File | Time | Tests |
|------|------|-------|
| test/commands/sync.test.ts | 8.9s | 9 |
| test/commands/frontmatter.test.ts | 8.5s | 14 |
| test/commands/read.test.ts | 7.2s | 13 |
| test/commands/worktree.test.ts | 4.9s | 10 |
| test/commands/init.test.ts | 4.0s | 8 |
| test/commands/add.test.ts | 3.7s | 6 |
| test/commands/complete.test.ts | 3.2s | 11 |
| test/commands/json.test.ts | 2.8s | 5 |
| test/lib/git.test.ts | 2.6s | 7 |
| test/commands/auto-commit.test.ts | 1.5s | 9 |
| test/lib/config.test.ts | 0.6s | 4 |
| test/helpers.test.ts | 0.4s | 3 |
| test/lib/frontmatter.test.ts | 0.03s | 11 |
| test/lib/paths.test.ts | 0.01s | 6 |
| test/commands/completion.test.ts | 0.02s | 14 |

### Root cause

Every test calls `createTestRepo()` which spawns 5 git subprocesses (`git init`, `git config` ×2, `git add`, `git commit`). Most tests then call `initTestPlans()` → `initPlans()` which spawns another 6–8 subprocesses (`branchExists`, `hash-object`, `commit-tree`, `update-ref`, `worktree list`, `getGitCommonDir`, `getMainWorktreeRoot`, `worktree add`). Each macOS git subprocess costs 30–100 ms to spawn, so 11–13 spawns × ~60 ms = 660–780 ms per test, matching the observed per-test cost of ~370 ms across the full suite.

`bun test` v1.4.1 runs files serially; total wall time equals the sum of per-file times. No subprocess pipe-drain bugs were found (the previous stall issue is not present).

### What does not help

- Network or remote-fetch timeouts: none observed.
- Tests already call exported functions directly rather than spawning the CLI.
- `bun test --concurrency` is not a recognized flag in v1.4.1.

## Implementation

### Wave 1: Template repo in helpers.ts

- [x] Add a module-level template-repo promise in `test/helpers.ts` that creates one git repo per `bun test` run (all files share one process), runs the five `createTestRepo` git calls once, and is copied for every test. A preload file (`test/setup.ts`, registered in `bunfig.toml`) removes the templates in a global `afterAll`, because `process.on("exit")` handlers don't fire under `bun test`.
- [x] Rewrite `createTestRepo()` to copy the template with `fs.cp` instead of spawning git.
- [x] Add `GIT_CONFIG_NOSYSTEM=1` and `GIT_TERMINAL_PROMPT=0` to every `gitExec` call in `helpers.ts` to skip reading `/etc/gitconfig` and suppress any interactive prompts.

### Wave 2: Template repo with plans branch

- [x] Add a second module-level template that calls `initPlans` on top of the base template, producing a repo that already has the orphan branch and `.plans/` worktree.
- [x] Expose `createTestRepoWithPlans()` from `helpers.ts`; replace `createTestRepo()` + `initTestPlans()` call pairs in test files that do not test `initPlans` itself.
- [x] Leave `test/commands/init.test.ts` and `test/lib/git.test.ts` on the old `createTestRepo()` + `initTestPlans()` pair since they are testing init behavior directly.

### Wave 3: Verify

- [x] Run `bun test` twice and record wall-clock time: 21.98s and 22.06s (down from 48.5s baseline).
- [x] Run `bun run lint` and `bun run typecheck` and confirm they pass.
