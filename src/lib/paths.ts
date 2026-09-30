import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AgentPlanError, NotARepoError } from "./errors";
import { execGit } from "./git";

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function findRepoRoot(startDir?: string): Promise<string> {
  let dir = path.resolve(startDir ?? process.cwd());

  while (true) {
    if (await exists(path.join(dir, ".git"))) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new NotARepoError();
    }

    dir = parent;
  }
}

const PLANS_DIR_NAME = ".plans";

function repoRelative(repoRoot: string, absolutePath: string): string | null {
  const relative = path.relative(repoRoot, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/**
 * Maps a file inside the repo to the path it's stored at in `.plans/`: its
 * repo-relative path, or, for a file already inside `.plans/`, its path there.
 * Throws for files outside the repo, which have no repo-relative path.
 */
export async function resolvePlanPath(repoRoot: string, absolutePath: string): Promise<string> {
  // The unresolved path is tried first because in a secondary checkout
  // `.plans` is a symlink into the main checkout, and resolving it would put
  // the file outside this checkout. The resolved pair covers macOS paths that
  // differ only by a symlinked prefix such as /var and /private/var.
  const relative =
    repoRelative(repoRoot, absolutePath) ??
    repoRelative(await realpath(repoRoot), await realpath(absolutePath));

  if (relative === null) {
    throw new AgentPlanError(`${absolutePath} is outside the repository at ${repoRoot}`);
  }

  const plansPrefix = `${PLANS_DIR_NAME}/`;
  return relative.startsWith(plansPrefix) ? relative.slice(plansPrefix.length) : relative;
}

export function getPlansDir(repoRoot: string): string {
  return path.join(repoRoot, PLANS_DIR_NAME);
}

/** Returns the absolute path to the shared git directory (same as .git in main checkout,
 * or the common parent .git when called from a secondary worktree). */
export async function getGitCommonDir(repoRoot: string): Promise<string> {
  return execGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot);
}

/** Returns the root directory of the main worktree (the first entry from `git worktree list`). */
export async function getMainWorktreeRoot(repoRoot: string): Promise<string> {
  const output = await execGit(["worktree", "list", "--porcelain"], repoRoot);
  const firstLine = output.split("\n").find((l) => l.startsWith("worktree "));
  if (!firstLine) throw new Error(`Could not find main worktree from ${repoRoot}`);
  return firstLine.slice("worktree ".length).trim();
}

/** Returns the path to the config file stored inside the shared git directory. */
export function getConfigPath(gitCommonDir: string): string {
  return path.join(gitCommonDir, "agent-plan", "config.json");
}
