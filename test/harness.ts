import { chmod, cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * The command that runs the CLI under test. By default that's the source under
 * Bun; `APL_TEST_DIST=1` runs the bundle from `bun run build` instead, which is
 * what npm users install. It runs the file itself, so its launcher line picks
 * the runtime: Node when it's on PATH, otherwise Bun. Node starts slower than
 * Bun, and every test starts the CLI many times while the others run, so
 * `test:dist` raises the default 5s timeout: on a 3-core CI runner tests took
 * up to 15s.
 */
const CLI_COMMAND =
  process.env.APL_TEST_DIST === "1"
    ? [join(import.meta.dir, "..", "dist", "apl.js")]
    : ["bun", join(import.meta.dir, "..", "src", "index.ts")];

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  env?: Record<string, string>;
  stdin?: string;
}

/**
 * The run's scratch area: repo templates and the `apl` shim live here, and
 * `test/setup.ts` deletes it after the run. `bun test` evaluates this module
 * once for every test file, so the templates are built once per run.
 */
const scratchRoot = await realpath(await mkdtemp(join(tmpdir(), "apl-test-")));

export async function removeScratchRoot(): Promise<void> {
  await rm(scratchRoot, { recursive: true, force: true });
}

/**
 * Git hooks and completion scripts call `apl` by name, so this shim puts the
 * CLI under test first on PATH instead of whatever `apl` the developer has
 * installed globally.
 */
const shimDir = join(scratchRoot, "bin");
await mkdir(shimDir);
await Bun.write(
  join(shimDir, "apl"),
  `#!/bin/sh\nexec ${CLI_COMMAND.map((part) => `"${part}"`).join(" ")} "$@"\n`,
);
await chmod(join(shimDir, "apl"), 0o755);

/**
 * Inherited `GIT_*` variables (set when the suite runs inside a git hook) would
 * point every command at the developer's repo, and global git config such as
 * commit signing or a global hooks path would change results. Both are
 * stripped, and author identity comes from the environment instead.
 */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  }
  return {
    ...env,
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    NO_COLOR: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };
}

const testEnv = baseEnv();

export async function run(
  command: readonly string[],
  cwd: string,
  options: RunOptions = {},
): Promise<CommandResult> {
  const proc = Bun.spawn([...command], {
    cwd,
    env: { ...testEnv, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** Runs the `apl` CLI under test from `cwd`. */
export function apl(
  cwd: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  return run([...CLI_COMMAND, ...args], cwd, options);
}

/**
 * Runs git for arranging state the CLI doesn't own (remotes, commits in the
 * code repo) and for inspecting what reached a remote. Throws on failure so a
 * broken arrange step can't masquerade as a behavior failure.
 */
export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run(["git", ...args], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export interface TempDir extends AsyncDisposable {
  dir: string;
}

export async function createTempDir(): Promise<TempDir> {
  const dir = await mkdtemp(join(scratchRoot, "tmp-"));
  return {
    dir,
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  };
}

export interface Repo extends TempDir {
  /** The checkout's `.apl` link to the docs store. */
  storeDir: string;
}

function toRepo(temp: TempDir): Repo {
  return { ...temp, storeDir: join(temp.dir, ".apl") };
}

const emptyRepoTemplate = (async () => {
  const dir = join(scratchRoot, "template-empty");
  await mkdir(dir);
  await git(dir, ["init", "-b", "main"]);
  await Bun.write(join(dir, "README.md"), "# Project\n");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-m", "Initial commit"]);
  return dir;
})();

const initializedRepoTemplate = (async () => {
  const dir = join(scratchRoot, "template-initialized");
  await cp(await emptyRepoTemplate, dir, { recursive: true });
  const result = await apl(dir, ["init"]);
  if (result.exitCode !== 0) throw new Error(`apl init failed: ${result.stderr}`);
  return dir;
})();

async function copyTemplate(template: Promise<string>): Promise<Repo> {
  const temp = await createTempDir();
  await cp(await template, temp.dir, { recursive: true });
  return toRepo(temp);
}

/** A git repo with one commit on `main` and no plan storage. */
export function createRepo(): Promise<Repo> {
  return copyTemplate(emptyRepoTemplate);
}

/** A git repo where `apl init` has already run. */
export async function createInitializedRepo(): Promise<Repo> {
  const repo = await copyTemplate(initializedRepoTemplate);
  // The copied store worktree still points at the template by absolute path.
  // Left alone, commits in the store would land in the template's repo. Both
  // halves of the worktree link are rewritten by hand: `git worktree repair`
  // follows the store's stale `.git` file back to the template and, on some
  // git versions, re-points the template's store at this copy.
  const storeGitFile = join(repo.storeDir, ".git");
  const templateAdminDir = (await Bun.file(storeGitFile).text()).replace(/^gitdir: /, "").trim();
  const adminDir = join(repo.dir, ".git", "worktrees", basename(templateAdminDir));
  await Bun.write(storeGitFile, `gitdir: ${adminDir}\n`);
  await Bun.write(join(adminDir, "gitdir"), `${storeGitFile}\n`);
  return repo;
}

/** A bare repo that stands in for a shared remote such as GitHub. */
export async function createRemote(): Promise<TempDir> {
  const temp = await createTempDir();
  await git(temp.dir, ["init", "--bare"]);
  return temp;
}

/** Adds `remote` as `origin` of `repo`. */
export async function addOrigin(repo: Repo, remote: TempDir): Promise<void> {
  await git(repo.dir, ["remote", "add", "origin", remote.dir]);
}

/**
 * Writes `content` to `planPath` in the code checkout and runs `apl add` on
 * it, the way a user brings a doc under storage.
 */
export async function addPlan(
  repo: Repo,
  planPath: string,
  content: string,
  message?: string,
): Promise<void> {
  await Bun.write(join(repo.dir, planPath), content);
  const messageArgs = message === undefined ? [] : ["-m", message];
  const result = await apl(repo.dir, ["add", planPath, ...messageArgs]);
  if (result.exitCode !== 0) throw new Error(`apl add ${planPath} failed: ${result.stderr}`);
}

export interface LogEntry {
  hash: string;
  message: string;
  date: string;
  author: string;
}

/** Commit messages on the docs branch, newest first, read through `apl log --json`. */
export async function planLogMessages(repo: Repo, args: string[] = []): Promise<string[]> {
  const result = await apl(repo.dir, ["log", "--json", ...args]);
  const { entries } = JSON.parse(result.stdout) as { entries: LogEntry[] };
  return entries.map((entry) => entry.message);
}

/** A second checkout of `repo`, as created by `git worktree add` or `wt`. */
export async function createSecondaryCheckout(repo: Repo): Promise<Repo> {
  const temp = await createTempDir();
  await rm(temp.dir, { recursive: true });
  await git(repo.dir, ["worktree", "add", temp.dir]);
  return {
    ...toRepo(temp),
    [Symbol.asyncDispose]: async () => {
      await git(repo.dir, ["worktree", "remove", "--force", temp.dir]).catch(() => {});
      await temp[Symbol.asyncDispose]();
    },
  };
}

/** Commits a team config.json, such as custom doc types, at the root of the docs branch. */
export async function writeStoreConfig(repo: Repo, config: unknown): Promise<void> {
  await Bun.write(join(repo.storeDir, "config.json"), JSON.stringify(config));
  await git(repo.storeDir, ["add", "config.json"]);
  await git(repo.storeDir, ["commit", "-m", "Configure doc types"]);
}

/** Adds a commit to the code branch checked out at `repo` and returns its hash. */
export async function commitCode(repo: Repo, file: string): Promise<string> {
  await Bun.write(join(repo.dir, file), `${file}\n`);
  await git(repo.dir, ["add", file]);
  await git(repo.dir, ["commit", "-m", `Add ${file}`]);
  return git(repo.dir, ["rev-parse", "HEAD"]);
}

/** Creates `branch` with one commit of its own and leaves it checked out. Returns its tip. */
export async function startWorkBranch(repo: Repo, branch: string): Promise<string> {
  await git(repo.dir, ["checkout", "-b", branch]);
  return commitCode(repo, `${branch.replaceAll("/", "-")}.txt`);
}

/** A link between a code branch and docs, as `apl links --json` returns it. */
export interface Link {
  branch: string;
  docs: string[];
  commit: string | null;
}

/** Links read through `apl links --json`, newest first. */
export async function readLinks(repo: Repo, args: string[] = []): Promise<Link[]> {
  const result = await apl(repo.dir, ["links", "--json", ...args]);
  if (result.exitCode !== 0) throw new Error(`apl links failed: ${result.stderr}`);
  return (JSON.parse(result.stdout) as { links: Link[] }).links;
}
