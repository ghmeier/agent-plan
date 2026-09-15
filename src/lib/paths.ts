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
