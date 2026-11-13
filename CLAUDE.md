# agent-plan (`apl`)

A TypeScript CLI, developed with Bun and published for Node, that stores agent-written markdown (plans, research, handoffs) on an orphan git branch (`apl`), so it never touches the code branch. See README.md for user-facing behavior; keep it in sync when commands or flags change.

## Commands

```bash
bun test                 # end-to-end CLI tests (concurrent)
bun test test/sync.test.ts -t "conflicting"   # one file or test name
bun run typecheck        # tsc --noEmit
bun run lint             # biome check; lint:fix to autoformat
bun src/index.ts <cmd>   # run the CLI from source
bun run test:dist        # build dist/apl.js and run the tests against it under Node
```

Run all three (test, typecheck, lint) before calling work done.

Releases are published to npm as `@ghmeier/agent-plan`, and as standalone binaries on a GitHub release, by `.github/workflows/publish.yml` when a `v*` tag is pushed; see README "Releasing". The npm package is `dist/apl.js`, a single Node bundle built by `scripts/build.ts` with no runtime dependencies, so every package in `package.json` is a devDependency. `install.sh` installs a release binary; keep it POSIX `sh`. Workflow actions are locked in `.github/workflows/actions.lock` by [`gh actions-lock`](https://github.com/github/gh-actions-lock); rerun it after changing any `uses:`, and the `verify-lockfile` workflow fails CI if you don't. CI runs on Linux, where git versions can differ from local macOS, so be careful with git behavior that varies across versions.

## Layout

- `src/index.ts`: commander setup. Each command lives in `src/commands/<name>.ts` and exports `register<Name>(program)`.
- `src/lib/worktree.ts`: `ensureStore`, the core invariant. The docs branch is checked out once, at `.apl` in the main checkout (the store), and every other checkout gets a `.apl` symlink to it. It stays out of `.git/` because Claude Code prompts on every write there; bare repos fall back to `<git-common-dir>/agent-plan/worktree`. Commands call `ensureStore` first and use the path it returns, never the `.apl` link.
- `src/lib/paths.ts`: repo root discovery (which maps the store itself back to a checkout), store paths, and `resolvePlanPath` (maps a user path to its path in the store).
- `src/lib/config.ts`: config is JSON at `<git-common-dir>/agent-plan/config.json`, shared by all checkouts and never committed.
- `src/lib/doc-types.ts`: doc types. A doc's type is its top-level directory in the store; types come from a `config.json` committed on the docs branch, or the built-ins (`plan`, `research`, `handoff`). Also templates for `apl new`. Status validity depends on the type, so it's checked at display time (`withValidStatus`), never while parsing.
- `src/lib/frontmatter.ts`: YAML frontmatter parsing, and `setFrontmatterFields`, which edits only the lines for the keys it sets so everything else in a user's frontmatter survives. Never re-serialize a whole frontmatter block.
- `src/lib/hooks.ts`: the optional post-commit auto-commit hook. It appends a marked section to an existing hook rather than overwriting it.
- `src/lib/links.ts`: links between docs and the code branches that implement them. The working link is git config in the code repo (`branch.<name>.apl-doc`); the record is an empty commit on the docs branch with `Linked-Doc`, `Code-Branch`, and `Code-Commit` trailers. `recordLinks` runs on every commit and sync. Queries read only the docs-branch log, never a file.
- `src/lib/remote.ts`: fetch, rebase, and ahead/behind helpers shared by `sync`, `pull`, and `status`.
- `plugins/agent-plan/`: the Claude Code and Codex plugin (skill and hooks) that teams enable to teach agents the tool. Both agents share the skill. Claude Code reads `.claude-plugin/plugin.json` and `hooks/hooks.json`, listed by `.claude-plugin/marketplace.json`; Codex reads the root `plugin.json` and `hooks/codex-hooks.json`, listed by `.agents/plugins/marketplace.json`. Codex rejects unknown manifest fields and has no `asyncRewake`, which is why each agent has its own manifest and hooks file; keep the two hooks files in step. Update the skill when a command agents use changes, and check it with `claude plugin validate .`. The plugin has no `version` on purpose, so every commit reaches users.
- `src/commands/complete.ts` is the hidden backend for shell completion; `completion.ts` emits the bash/zsh/fish scripts that call it.

## Conventions

- Git calls go through `runGit` / `execGit` in `src/lib/git.ts`, never a git library or a direct `spawn`. Those helpers set `APL_INTERNAL`, which the auto-commit hook checks so apl's own commits don't trigger it. `.apl` is added to `<git-common-dir>/info/exclude`, not `.gitignore`.
- User-facing failures throw `AgentPlanError` (or a subclass in `src/lib/errors.ts`) with an actionable message; `index.ts` maps it to an exit code. Anything else exits 2 as "Unexpected error".
- Print through `src/lib/output.ts` (`success`, `warn`, `info`, `error`) so `NO_COLOR` / `--no-color` is respected. Read commands support `--json`; keep that output stable because agents parse it.
- Compare paths with `realpath` first. On macOS `/var` and `/tmp` are symlinks to `/private/...`, so plain string comparison of paths gives false mismatches.
- No migration code for old layouts: the tool is pre-release.
- `src/` runs on Node 20+, so it uses `node:` modules, never `Bun` APIs (lint enforces this). File helpers are in `src/lib/fs.ts`. Tests and `scripts/` run under Bun and use `Bun.*` and `bun:test` freely. Use `bun`/`bunx` for development, not `npm`/`npx`.

## Tests

Tests are end-to-end: they drive the real CLI as a subprocess against throwaway repos. Don't import command functions directly into tests.

- Use helpers from `test/harness.ts` (`repo.storeDir` is the checkout's `.apl` link): `createInitializedRepo`, `createRepo`, `createRemote` + `addOrigin`, `createSecondaryCheckout`, `addPlan`, `apl(cwd, args)`, `git(cwd, args)`, `planLogMessages`, and for links `startWorkBranch`, `commitCode`, `readLinks`. Clean up with `await using repo = ...`.
- The harness strips inherited `GIT_*` variables and global git config, and puts an `apl` shim first on `PATH` so hooks and completion scripts call the code under test. Don't bypass `run()` when spawning processes in tests.
- Tests run concurrently, so every test must build its own repos and share no state.
- Group tests by user workflow (`authoring`, `reading`, `sync`, `checkouts`, `init`, `types`, `completion`, `linking`), not by source file.
