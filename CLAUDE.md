# agent-plan (`apl`)

A Bun + TypeScript CLI that stores agent-written markdown (plans, research, handoffs) on an orphan git branch, checked out as a `.plans/` worktree so it never touches the code branch. See README.md for user-facing behavior; keep it in sync when commands or flags change.

## Commands

```bash
bun test                 # end-to-end CLI tests (concurrent)
bun test test/sync.test.ts -t "diverged"   # one file or test name
bun run typecheck        # tsc --noEmit
bun run lint             # biome check; lint:fix to autoformat
bun src/index.ts <cmd>   # run the CLI from source
```

Run all three (test, typecheck, lint) before calling work done.

## Layout

- `src/index.ts`: commander setup. Each command lives in `src/commands/<name>.ts` and exports `register<Name>(program)`.
- `src/lib/worktree.ts`: `ensurePlansWorktree`, the core invariant. The main checkout owns the real `.plans/` worktree; secondary checkouts (`git worktree add`, `wt`) get `.plans` as a symlink to it. Most commands call this before touching files.
- `src/lib/paths.ts`: repo root discovery, main-worktree detection, and `resolvePlanPath` (maps a user path to its path inside `.plans/`).
- `src/lib/config.ts`: config is JSON at `<git-common-dir>/agent-plan/config.json`, shared by all checkouts and never committed.
- `src/lib/frontmatter.ts`: YAML frontmatter parsing and `created`/`updated` stamping. Stamping only applies to files that already have frontmatter.
- `src/lib/hooks.ts`: the optional post-commit auto-commit hook. It appends a marked section to an existing hook rather than overwriting it.
- `src/commands/complete.ts` is the hidden backend for shell completion; `completion.ts` emits the bash/zsh/fish scripts that call it.

## Conventions

- Git state changes go through the `git` CLI via `Bun.spawn`, never a git library. `.plans/` is added to `<git-common-dir>/info/exclude`, not `.gitignore`.
- User-facing failures throw `AgentPlanError` (or a subclass in `src/lib/errors.ts`) with an actionable message; `index.ts` maps it to an exit code. Anything else exits 2 as "Unexpected error".
- Print through `src/lib/output.ts` (`success`, `warn`, `info`, `error`) so `NO_COLOR` / `--no-color` is respected. Read commands support `--json`; keep that output stable because agents parse it.
- Compare paths with `realpath` first. On macOS `/var` and `/tmp` are symlinks to `/private/...`, so plain string comparison of paths gives false mismatches.
- No migration code for old layouts: the tool is pre-release.
- Prefer `Bun.file`, `Bun.write`, `Bun.spawn`, and `bun:test` over Node or npm equivalents. Use `bun`/`bunx`, not `node`/`npx`.

## Tests

Tests are end-to-end: they drive the real CLI as a subprocess against throwaway repos. Don't import command functions directly into tests.

- Use helpers from `test/harness.ts`: `createInitializedRepo`, `createRepo`, `createRemote` + `addOrigin`, `createSecondaryCheckout`, `addPlan`, `apl(cwd, args)`, `git(cwd, args)`, `planLogMessages`. Clean up with `await using repo = ...`.
- The harness strips inherited `GIT_*` variables and global git config, and puts an `apl` shim first on `PATH` so hooks and completion scripts call the code under test. Don't bypass `run()` when spawning processes in tests.
- Tests run concurrently, so every test must build its own repos and share no state.
- Group tests by user workflow (`authoring`, `reading`, `sync`, `checkouts`, `init`, `completion`), not by source file.
