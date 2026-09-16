import { appendFile, lstat, readFile, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import type { PlanConfig } from "../types";
import { NotInitializedError } from "./errors";
import { Git } from "./git";
import { getGitCommonDir, getMainWorktreeRoot, getPlansDir } from "./paths";

async function realpathSafe(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

async function isWorktreeDir(repoRoot: string, plansDir: string): Promise<boolean> {
  const git = new Git(repoRoot);
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
  const git = new Git(repoRoot);

  if (await isWorktreeDir(repoRoot, plansDir)) {
    return;
  }

  // Remove any stale entry that would block `git worktree add`.
  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(plansDir);
  } catch {
    // no-op
  }

  if (existing !== null) {
    await rm(plansDir, { recursive: true, force: true });
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
  const git = new Git(repoRoot, config.branch);

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
      if (!(await git.branchExists())) {
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
      // no-op
    }

    if (existingLstat !== null) {
      if (existingLstat.isSymbolicLink()) {
        const resolved = await realpathSafe(plansDir);
        if (resolved === (await realpathSafe(mainPlansDir))) {
          return;
        }
        await rm(plansDir);
      } else {
        await rm(plansDir, { recursive: true, force: true });
      }
    }

    await symlink(mainPlansDir, plansDir);
  }
}
