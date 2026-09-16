import { stat } from "node:fs/promises";
import path from "node:path";

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
      throw new Error("Not a git repository (or any parent up to mount point)");
    }

    dir = parent;
  }
}

export function resolvePlanPath(repoRoot: string, filePath: string): string {
  let result = filePath;

  if (path.isAbsolute(result)) {
    const relativeToRoot = path.relative(repoRoot, result);
    // Only adopt the repo-relative form when filePath actually falls under
    // repoRoot; otherwise fall through to the leading-slash strip below so
    // an absolute-looking path outside the repo still normalizes sanely.
    if (!relativeToRoot.startsWith("..")) {
      result = relativeToRoot;
    }
  }

  result = path.normalize(result).split(path.sep).join("/");

  while (result.startsWith("./")) {
    result = result.slice(2);
  }
  while (result.startsWith("/")) {
    result = result.slice(1);
  }

  return result;
}

export function getPlansDir(repoRoot: string): string {
  return path.join(repoRoot, ".plans");
}

/** Returns the absolute path to the shared git directory (same as .git in main checkout,
 * or the common parent .git when called from a secondary worktree). */
export async function getGitCommonDir(repoRoot: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Could not determine git common dir in ${repoRoot}`);
  const dir = stdout.trim();
  return path.isAbsolute(dir) ? dir : path.resolve(repoRoot, dir);
}

/** Returns the root directory of the main worktree (the first entry from `git worktree list`). */
export async function getMainWorktreeRoot(repoRoot: string): Promise<string> {
  const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const firstLine = stdout.split("\n").find((l) => l.startsWith("worktree "));
  if (!firstLine) throw new Error(`Could not find main worktree from ${repoRoot}`);
  return firstLine.slice("worktree ".length).trim();
}

/** True when repoRoot is the main worktree (not a secondary `git worktree add` checkout). */
export async function isMainWorktree(repoRoot: string): Promise<boolean> {
  const mainRoot = await getMainWorktreeRoot(repoRoot);
  return path.resolve(repoRoot) === path.resolve(mainRoot);
}

/** Returns the path to the config file stored inside the shared git directory. */
export function getConfigPath(gitCommonDir: string): string {
  return path.join(gitCommonDir, "agent-plan", "config.json");
}
