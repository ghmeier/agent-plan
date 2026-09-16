import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { initPlans } from "../src/commands/init";

export interface TestRepo {
  dir: string;
  cleanup: () => Promise<void>;
}

// Environment variables that skip slow per-call git overhead.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * Runs a git command in the given directory and returns its stdout.
 * Throws if the command exits with a non-zero status, including stderr
 * in the error message to make failures easy to diagnose.
 */
export async function gitExec(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir, env: GIT_ENV });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Templates are built once per `bun test` run and copied for every test, so
 * the git setup cost is paid once instead of once per test. `bun test` loads
 * this module once for all test files; `test/setup.ts` removes the templates
 * after the whole run because `process.on("exit")` handlers don't fire there.
 */
const templateRoot = mkdtempSync(join(tmpdir(), "agent-plan-tpl-"));

export async function removeTestTemplates(): Promise<void> {
  await rm(templateRoot, { recursive: true, force: true });
}

const baseTemplatePromise: Promise<string> = (async () => {
  const dir = join(templateRoot, "base");
  await mkdir(dir);

  await gitExec(dir, ["init", "-b", "main"]);
  await gitExec(dir, ["config", "user.email", "test@test.com"]);
  await gitExec(dir, ["config", "user.name", "Test"]);

  await Bun.write(join(dir, ".gitkeep"), "");
  await gitExec(dir, ["add", ".gitkeep"]);
  await gitExec(dir, ["commit", "-m", "Initial commit"]);

  return dir;
})();

const plansTemplatePromise: Promise<string> = (async () => {
  const dir = join(templateRoot, "plans");
  await cp(await baseTemplatePromise, dir, { recursive: true });

  await initPlans({ cwd: dir });

  return dir;
})();

/**
 * A copied repo's `.plans/` worktree still points at the template through two
 * absolute paths: `.plans/.git` names the admin dir under `.git/worktrees/`,
 * and that admin dir's `gitdir` file names `.plans/.git`. Git derives the
 * admin dir's name from the worktree path, so it is read back rather than
 * assumed.
 */
async function repairWorktreePaths(dir: string): Promise<void> {
  // realpath resolves macOS /var to /private/var, matching what git stores.
  const real = await realpath(dir);
  const pointerPath = join(dir, ".plans", ".git");
  const pointer = await Bun.file(pointerPath).text();
  const adminDirName = path.basename(pointer.replace(/^gitdir:\s*/, "").trim());

  await Bun.write(pointerPath, `gitdir: ${real}/.git/worktrees/${adminDirName}\n`);
  await Bun.write(join(dir, ".git", "worktrees", adminDirName, "gitdir"), `${real}/.plans/.git\n`);
}

/**
 * Provisions an isolated git repository in a temporary directory, with an
 * initial commit so the repo is non-empty and ready for further commits.
 * Callers must invoke the returned `cleanup` function to remove the
 * temporary directory once the test is done.
 */
export async function createTestRepo(): Promise<TestRepo> {
  const template = await baseTemplatePromise;

  const dir = await mkdtemp(join(tmpdir(), "agent-plan-test-"));
  await cp(template, dir, { recursive: true });

  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
  };

  return { dir, cleanup };
}

/**
 * Provisions an isolated git repository that already has plan storage
 * initialized: a `plans` orphan branch and a `.plans/` worktree. Equivalent
 * to `createTestRepo()` followed by `initTestPlans()`, but uses a pre-built
 * template so the per-test cost is a file copy rather than ~10 git subprocess
 * calls.
 *
 * Use this in tests that exercise commands which require an initialized repo.
 * Leave `createTestRepo()` + `initTestPlans()` in tests that exercise `init`
 * itself, since those tests care about the initialization side-effects.
 */
export async function createTestRepoWithPlans(): Promise<TestRepo> {
  const template = await plansTemplatePromise;

  const dir = await mkdtemp(join(tmpdir(), "agent-plan-test-"));
  await cp(template, dir, { recursive: true });

  await repairWorktreePaths(dir);

  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
  };

  return { dir, cleanup };
}

/**
 * Initializes plan storage with a worktree in the given repo directory and
 * returns the path to `.plans/`. Equivalent to running `apl init` for tests.
 */
export async function initTestPlans(
  repoDir: string,
  options: { branch?: string } = {},
): Promise<string> {
  await initPlans({ cwd: repoDir, branch: options.branch });
  return join(repoDir, ".plans");
}

/**
 * Writes a file into `.plans/` and commits it. Use this in tests that need
 * a committed plan file without going through the `add` command.
 */
export async function writePlanFile(
  repoDir: string,
  planPath: string,
  content: string,
  message?: string,
): Promise<void> {
  const plansDir = join(repoDir, ".plans");
  const destPath = join(plansDir, planPath);
  await mkdir(path.dirname(destPath), { recursive: true });
  await Bun.write(destPath, content);

  await gitExec(plansDir, ["add", "--", planPath]);
  await gitExec(plansDir, ["commit", "-m", message ?? `Add ${planPath}`]);
}

/**
 * Creates a secondary git worktree of the given main repo at a temporary
 * directory. The secondary worktree shares history with the main repo and
 * is useful for testing the symlink behavior of ensurePlansWorktree.
 */
export async function createSecondaryWorktree(
  mainDir: string,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-plan-wt-"));
  // Remove the dir first since git worktree add creates it.
  await rm(dir, { recursive: true, force: true });
  await gitExec(mainDir, ["worktree", "add", dir]);

  return {
    dir,
    cleanup: async () => {
      // Prune the worktree reference regardless of whether the directory
      // still exists, to keep the main repo's worktree list clean.
      try {
        await gitExec(mainDir, ["worktree", "remove", "--force", dir]);
      } catch {
        // already gone or prune will clean it up
        try {
          await gitExec(mainDir, ["worktree", "prune"]);
        } catch {
          // best effort
        }
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
