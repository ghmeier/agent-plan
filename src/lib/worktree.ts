import { lstat, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import type { PlanConfig } from "../types";
import { readConfig } from "./config";
import { NotInitializedError } from "./errors";
import { GitPlumbing } from "./git";
import { getMainWorktreeRoot, getPlansDir } from "./paths";

async function realpathSafe(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

async function isWorktreeDir(repoRoot: string, plansDir: string): Promise<boolean> {
  const git = new GitPlumbing(repoRoot);
  let output: string;
  try {
    output = await git.exec(["worktree", "list", "--porcelain"]);
  } catch {
    return false;
  }

  const resolvedPlansDir = await realpathSafe(plansDir);
  const worktreePaths = await Promise.all(
    output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => realpathSafe(line.slice("worktree ".length))),
  );

  return worktreePaths.includes(resolvedPlansDir);
}

async function addWorktreeDir(repoRoot: string, plansDir: string, branch: string): Promise<void> {
  const git = new GitPlumbing(repoRoot);

  if (await isWorktreeDir(repoRoot, plansDir)) {
    return;
  }

  // Remove any stale plain directory that would block `git worktree add`.
  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(plansDir);
  } catch {
    // doesn't exist — fine
  }

  if (existing !== null) {
    if (existing.isSymbolicLink()) {
      await rm(plansDir);
    } else {
      // Migrate any config.json that may live in an old plain-directory .plans/
      // before removing it; the caller's readConfig already wrote the new
      // location, so we just need the directory gone.
      await rm(plansDir, { recursive: true, force: true });
    }
  }

  await git.exec(["worktree", "add", plansDir, branch]);
}

/** Ensures `.plans/` is ready for use: a real worktree in the main checkout
 * and a symlink to it in every secondary `git worktree add` checkout.
 * Throws NotInitializedError when the branch doesn't exist and cannot be
 * fetched from the configured remote. Pass `isInit = true` when called from
 * `initPlans` to suppress that error (init is about to create the branch). */
export async function ensurePlansWorktree(
  repoRoot: string,
  config: PlanConfig,
  isInit = false,
): Promise<void> {
  const plansDir = getPlansDir(repoRoot);
  const git = new GitPlumbing(repoRoot, config.branch);

  const mainRoot = await getMainWorktreeRoot(repoRoot);
  // Resolve symlinks before comparing — on macOS, /var/folders is a symlink to
  // /private/var/folders, so a naive path.resolve comparison would disagree.
  const [resolvedRepo, resolvedMain] = await Promise.all([
    realpathSafe(repoRoot),
    realpathSafe(mainRoot),
  ]);
  const isMain = resolvedRepo === resolvedMain;

  if (isMain) {
    // The main checkout owns the real .plans/ worktree.
    if (await isWorktreeDir(repoRoot, plansDir)) {
      return;
    }

    if (!isInit) {
      // Non-init callers expect the branch to already exist.
      if (!(await git.branchExists())) {
        // Try to create the local branch from the remote.
        try {
          await git.exec(["fetch", config.remote, config.branch]);
          await git.exec(["branch", config.branch, `${config.remote}/${config.branch}`]);
        } catch {
          throw new NotInitializedError();
        }
      }
    }

    await addWorktreeDir(repoRoot, plansDir, config.branch);
  } else {
    // Secondary worktrees get a symlink that points at the main checkout's .plans/.
    const mainPlansDir = path.join(mainRoot, ".plans");

    let existingLstat: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      existingLstat = await lstat(plansDir);
    } catch {
      // doesn't exist — will create symlink below
    }

    if (existingLstat !== null) {
      if (existingLstat.isSymbolicLink()) {
        const resolved = await realpathSafe(plansDir);
        if (resolved === (await realpathSafe(mainPlansDir))) {
          return; // already correct
        }
        await rm(plansDir);
      } else {
        await rm(plansDir, { recursive: true, force: true });
      }
    }

    await symlink(mainPlansDir, plansDir);
  }
}

/** Read the config for the given repo root. Re-exported here so commands can
 * import both config and worktree setup from one place if they choose to. */
export { readConfig };
