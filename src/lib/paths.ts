import { realpath } from "node:fs/promises";
import path from "node:path";
import { AgentPlanError, NotARepoError } from "./errors";
import { execGit, runGit } from "./git";

/**
 * Returns the checkout that contains `startDir`. From inside the store
 * worktree itself (someone `cd`s into `.apl/`, which git sees as its own
 * worktree), returns the main checkout instead, since the store is not a
 * checkout of the code.
 */
export async function findRepoRoot(startDir?: string): Promise<string> {
  const cwd = path.resolve(startDir ?? process.cwd());
  const toplevel = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (toplevel.exitCode !== 0) throw new NotARepoError();

  const root = toplevel.stdout.trim();
  const storeDir = await getStoreDir(root);
  if ((await realpathSafe(root)) === (await realpathSafe(storeDir))) {
    return getMainWorktreeRoot(root);
  }
  return root;
}

export async function realpathSafe(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** The name of the symlink to the store that apl keeps in every checkout. */
export const STORE_LINK_NAME = ".apl";

function repoRelative(repoRoot: string, absolutePath: string): string | null {
  const relative = path.relative(repoRoot, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/**
 * Maps a file inside the repo to the path it's stored at in the store: its
 * repo-relative path, or, for a file already inside `.apl/`, its path there.
 * Throws for files outside the repo, which have no repo-relative path.
 */
export async function resolvePlanPath(repoRoot: string, absolutePath: string): Promise<string> {
  // The unresolved path is tried first because `.apl` is a symlink into the
  // git directory, and resolving it would put the file outside the checkout.
  // The resolved pair covers macOS paths that differ only by a symlinked
  // prefix such as /var and /private/var.
  const relative =
    repoRelative(repoRoot, absolutePath) ??
    repoRelative(await realpath(repoRoot), await realpath(absolutePath));

  if (relative === null) {
    throw new AgentPlanError(`${absolutePath} is outside the repository at ${repoRoot}`);
  }

  const storePrefix = `${STORE_LINK_NAME}/`;
  return relative.startsWith(storePrefix) ? relative.slice(storePrefix.length) : relative;
}

/** The `.apl` symlink in a checkout. */
export function getStoreLink(repoRoot: string): string {
  return path.join(repoRoot, STORE_LINK_NAME);
}

/**
 * The store worktree, where the docs branch is checked out: `.apl` in the
 * main checkout, which every other checkout links to. It stays out of the
 * git directory because Claude Code asks before every write under `.git/`,
 * even through a symlink, and no permission rule can pre-approve that. A
 * bare repo has no main checkout, so its store falls back to the git
 * directory.
 */
export async function getStoreDir(repoRoot: string): Promise<string> {
  const main = await getMainWorktree(repoRoot);
  if (main.bare) return path.join(await getGitCommonDir(repoRoot), "agent-plan", "worktree");
  return path.join(main.path, STORE_LINK_NAME);
}

/** Returns the absolute path to the shared git directory (same as .git in main checkout,
 * or the common parent .git when called from a secondary worktree). */
export async function getGitCommonDir(repoRoot: string): Promise<string> {
  return execGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot);
}

/** The main worktree: the first entry from `git worktree list`, which is the git directory itself in a bare repo. */
async function getMainWorktree(repoRoot: string): Promise<{ path: string; bare: boolean }> {
  const output = await execGit(["worktree", "list", "--porcelain"], repoRoot);
  const [firstEntry = ""] = output.split("\n\n");
  const lines = firstEntry.split("\n");
  const worktreeLine = lines.find((l) => l.startsWith("worktree "));
  if (!worktreeLine) throw new Error(`Could not find main worktree from ${repoRoot}`);
  return { path: worktreeLine.slice("worktree ".length).trim(), bare: lines.includes("bare") };
}

/** Returns the root directory of the main worktree (the first entry from `git worktree list`). */
export async function getMainWorktreeRoot(repoRoot: string): Promise<string> {
  return (await getMainWorktree(repoRoot)).path;
}

/** Returns the path to the config file stored inside the shared git directory. */
export function getConfigPath(gitCommonDir: string): string {
  return path.join(gitCommonDir, "agent-plan", "config.json");
}
