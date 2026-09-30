import { appendFile, lstat, readFile, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import type { PlanConfig } from "../types";
import { AgentPlanError, NotInitializedError, PlansPathOccupiedError } from "./errors";
import { branchExists, execGit, gitPath, runGit } from "./git";
import { getGitCommonDir, getMainWorktreeRoot, getPlansDir } from "./paths";

async function realpathSafe(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isWorktreeDir(repoRoot: string, plansDir: string): Promise<boolean> {
  const { exitCode, stdout: output } = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  if (exitCode !== 0) return false;

  const resolvedPlansDir = await realpathSafe(plansDir);
  const worktreePaths = await Promise.all(
    output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => realpathSafe(line.slice("worktree ".length))),
  );

  return worktreePaths.includes(resolvedPlansDir);
}

/** Adds `.plans` to `<git-common-dir>/info/exclude` if not already present.
 * This keeps the entry out of the committed `.gitignore` and ensures it is
 * shared across all worktrees via the common git directory. */
async function ensureInfoExclude(repoRoot: string): Promise<void> {
  const gitCommonDir = await getGitCommonDir(repoRoot);
  const excludePath = path.join(gitCommonDir, "info", "exclude");

  let contents = "";
  try {
    contents = await readFile(excludePath, "utf8");
  } catch {
    // no-op
  }

  if (contents.split("\n").some((l) => l.trim() === ".plans")) return;

  const suffix = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  await appendFile(excludePath, `${suffix}.plans\n`);
}

async function addWorktreeDir(repoRoot: string, plansDir: string, branch: string): Promise<void> {
  if (await isWorktreeDir(repoRoot, plansDir)) {
    return;
  }

  if (await pathExists(plansDir)) {
    throw new PlansPathOccupiedError(plansDir);
  }

  await execGit(["worktree", "add", plansDir, branch], repoRoot);
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
  const mainRoot = await getMainWorktreeRoot(repoRoot);
  // Resolve symlinks before comparing — on macOS, /var/folders is a symlink to
  // /private/var/folders, so a naive path.resolve comparison would disagree.
  const [resolvedRepo, resolvedMain] = await Promise.all([
    realpathSafe(repoRoot),
    realpathSafe(mainRoot),
  ]);
  const isMain = resolvedRepo === resolvedMain;

  await ensureInfoExclude(repoRoot);

  if (isMain) {
    // The main checkout owns the real .plans/ worktree.
    if (await isWorktreeDir(repoRoot, plansDir)) {
      return;
    }

    if (!isInit) {
      // Non-init callers expect the branch to already exist.
      if (!(await branchExists(repoRoot, config.branch))) {
        try {
          await execGit(["fetch", config.remote, config.branch], repoRoot);
          await execGit(["branch", config.branch, `${config.remote}/${config.branch}`], repoRoot);
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
      // no-op
    }

    if (existingLstat !== null) {
      if (!existingLstat.isSymbolicLink()) {
        throw new PlansPathOccupiedError(plansDir);
      }
      const resolved = await realpathSafe(plansDir);
      if (resolved === (await realpathSafe(mainPlansDir))) {
        return;
      }
      // Only the link itself is removed; the directory it pointed to is untouched.
      await rm(plansDir);
    }

    await symlink(mainPlansDir, plansDir);
  }
}

const IN_PROGRESS_OPERATIONS = [
  { marker: "rebase-merge", name: "rebase", command: "rebase" },
  { marker: "rebase-apply", name: "rebase", command: "rebase" },
  { marker: "MERGE_HEAD", name: "merge", command: "merge" },
  { marker: "CHERRY_PICK_HEAD", name: "cherry-pick", command: "cherry-pick" },
] as const;

/**
 * Throws when `.plans/` is in the middle of a rebase, merge, or cherry-pick.
 * Committing then would record conflict markers as plan content and leave
 * the operation half-finished.
 */
export async function assertNoOperationInProgress(plansDir: string): Promise<void> {
  for (const operation of IN_PROGRESS_OPERATIONS) {
    if (await pathExists(await gitPath(plansDir, operation.marker))) {
      throw new AgentPlanError(
        `A ${operation.name} is in progress in ${plansDir}. Resolve the conflicts, stage the files, ` +
          `and run 'git -C ${plansDir} ${operation.command} --continue', or cancel with ` +
          `'git -C ${plansDir} ${operation.command} --abort'. Then run the command again.`,
      );
    }
  }
}
