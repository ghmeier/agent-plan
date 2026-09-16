import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { initPlans } from "../src/commands/init";

export interface TestRepo {
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Runs a git command in the given directory and returns its stdout.
 * Throws if the command exits with a non-zero status, including stderr
 * in the error message to make failures easy to diagnose.
 */
export async function gitExec(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir });

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
 * Provisions an isolated git repository in a temporary directory, with an
 * initial commit so the repo is non-empty and ready for further commits.
 * Callers must invoke the returned `cleanup` function to remove the
 * temporary directory once the test is done.
 */
export async function createTestRepo(): Promise<TestRepo> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-plan-test-"));

  await gitExec(dir, ["init"]);
  await gitExec(dir, ["config", "user.email", "test@test.com"]);
  await gitExec(dir, ["config", "user.name", "Test"]);

  await Bun.write(path.join(dir, ".gitkeep"), "");
  await gitExec(dir, ["add", ".gitkeep"]);
  await gitExec(dir, ["commit", "-m", "Initial commit"]);

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
  const dir = await mkdtemp(path.join(tmpdir(), "agent-plan-wt-"));
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
