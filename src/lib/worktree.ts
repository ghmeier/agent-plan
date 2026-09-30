import { appendFile, cp, lstat, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import type { PlanConfig } from "../types";
import { AgentPlanError, NotInitializedError, StorePathOccupiedError } from "./errors";
import { branchExists, execGit, gitPath, runGit } from "./git";
import { warn } from "./output";
import { getGitCommonDir, getStoreDir, getStoreLink, realpathSafe, STORE_LINK_NAME } from "./paths";

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

interface WorktreeEntry {
  path: string;
  branch?: string;
}

async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const output = await execGit(["worktree", "list", "--porcelain"], repoRoot);
  const entries: WorktreeEntry[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      entries.push({ path: line.slice("worktree ".length) });
    } else if (line.startsWith("branch refs/heads/")) {
      const current = entries.at(-1);
      if (current) current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return entries;
}

/** Adds `.apl` to `<git-common-dir>/info/exclude` if not already present.
 * This keeps the entry out of the committed `.gitignore` and ensures it is
 * shared across all worktrees via the common git directory. */
async function ensureInfoExclude(gitCommonDir: string): Promise<void> {
  const excludePath = path.join(gitCommonDir, "info", "exclude");

  let contents = "";
  try {
    contents = await readFile(excludePath, "utf8");
  } catch {
    await mkdir(path.dirname(excludePath), { recursive: true });
  }

  if (contents.split("\n").some((l) => l.trim() === STORE_LINK_NAME)) return;

  const suffix = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  await appendFile(excludePath, `${suffix}${STORE_LINK_NAME}\n`);
}

/** Checks out the docs branch at the store path, fetching it from the remote if needed. */
async function addStoreWorktree(
  repoRoot: string,
  storeDir: string,
  config: PlanConfig,
  isInit: boolean,
): Promise<void> {
  if (!isInit && !(await branchExists(repoRoot, config.branch))) {
    try {
      await execGit(["fetch", config.remote, config.branch], repoRoot);
      await execGit(["branch", config.branch, `${config.remote}/${config.branch}`], repoRoot);
    } catch {
      throw new NotInitializedError();
    }
  }

  // Drops registrations whose directories were deleted, so a store removed
  // by hand can be recreated instead of failing as "already registered".
  await runGit(["worktree", "prune"], repoRoot);

  const holder = (await listWorktrees(repoRoot)).find((w) => w.branch === config.branch);
  if (holder) {
    throw new AgentPlanError(
      `Branch '${config.branch}' is already checked out at ${holder.path}. ` +
        `Remove that worktree with 'git worktree remove ${holder.path}', then run the command again.`,
    );
  }

  if (await pathExists(storeDir)) {
    throw new StorePathOccupiedError(storeDir);
  }

  await mkdir(path.dirname(storeDir), { recursive: true });
  await execGit(["worktree", "add", "--quiet", storeDir, config.branch], repoRoot);
}

async function listFilesRecursive(dir: string, base = dir): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath, base)));
    } else {
      files.push(path.relative(base, fullPath));
    }
  }
  return files;
}

/**
 * Moves files from a real `.apl/` directory into the store and replaces the
 * directory with the link. Agents write into `.apl/` in a fresh checkout
 * before any apl command has created the link there, and those files would
 * otherwise be stranded. Refuses when a file would overwrite different
 * content already in the store.
 */
async function adoptStrayDirectory(linkPath: string, storeDir: string): Promise<void> {
  if (await pathExists(path.join(linkPath, ".git"))) {
    throw new StorePathOccupiedError(linkPath);
  }

  const files = await listFilesRecursive(linkPath);
  const conflicts: string[] = [];
  for (const file of files) {
    const existing = Bun.file(path.join(storeDir, file));
    if (!(await existing.exists())) continue;
    const incoming = await Bun.file(path.join(linkPath, file)).text();
    if ((await existing.text()) !== incoming) conflicts.push(file);
  }

  if (conflicts.length > 0) {
    throw new AgentPlanError(
      `${linkPath} is a directory instead of a link to the docs store, and these files in it ` +
        `differ from the store's copies: ${conflicts.join(", ")}. Move them out of the way, ` +
        "then run the command again.",
    );
  }

  await cp(linkPath, storeDir, { recursive: true, force: true });
  await rm(linkPath, { recursive: true });
  if (files.length > 0) {
    warn(`Moved ${files.length} file(s) from ${linkPath} into the docs store`);
  }
}

async function ensureStoreLink(repoRoot: string, storeDir: string): Promise<void> {
  const linkPath = getStoreLink(repoRoot);

  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(linkPath);
  } catch {
    // Missing: created below.
  }

  if (existing?.isSymbolicLink()) {
    if ((await realpathSafe(linkPath)) === (await realpathSafe(storeDir))) return;
    // Only the link itself is removed; the directory it pointed to is untouched.
    await rm(linkPath);
  } else if (existing?.isDirectory()) {
    await adoptStrayDirectory(linkPath, storeDir);
  } else if (existing) {
    throw new StorePathOccupiedError(linkPath);
  }

  await symlink(storeDir, linkPath);
}

/**
 * Ensures the docs store is ready and returns its path: the docs branch
 * checked out in the shared git directory, and a `.apl` link to it in this
 * checkout. Throws NotInitializedError when the branch doesn't exist and
 * cannot be fetched from the configured remote. Pass `isInit = true` when
 * called from `init`, which is about to create the branch.
 */
export async function ensureStore(
  repoRoot: string,
  config: PlanConfig,
  isInit = false,
): Promise<string> {
  const gitCommonDir = await getGitCommonDir(repoRoot);
  const storeDir = getStoreDir(gitCommonDir);

  await ensureInfoExclude(gitCommonDir);

  const resolvedStore = await realpathSafe(storeDir);
  const worktreePaths = await Promise.all(
    (await listWorktrees(repoRoot)).map((w) => realpathSafe(w.path)),
  );
  if (!worktreePaths.includes(resolvedStore) || !(await pathExists(storeDir))) {
    await addStoreWorktree(repoRoot, storeDir, config, isInit);
  }

  await ensureStoreLink(repoRoot, storeDir);
  return storeDir;
}

const IN_PROGRESS_OPERATIONS = [
  { marker: "rebase-merge", name: "rebase", command: "rebase" },
  { marker: "rebase-apply", name: "rebase", command: "rebase" },
  { marker: "MERGE_HEAD", name: "merge", command: "merge" },
  { marker: "CHERRY_PICK_HEAD", name: "cherry-pick", command: "cherry-pick" },
] as const;

/**
 * Throws when the store is in the middle of a rebase, merge, or cherry-pick.
 * Committing then would record conflict markers as document content and
 * leave the operation half-finished.
 */
export async function assertNoOperationInProgress(storeDir: string): Promise<void> {
  for (const operation of IN_PROGRESS_OPERATIONS) {
    if (await pathExists(await gitPath(storeDir, operation.marker))) {
      throw new AgentPlanError(
        `A ${operation.name} is in progress in ${storeDir}. Resolve the conflicts, stage the files, ` +
          `and run 'git -C ${storeDir} ${operation.command} --continue', or cancel with ` +
          `'git -C ${storeDir} ${operation.command} --abort'. Then run the command again.`,
      );
    }
  }
}
