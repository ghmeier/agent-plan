import {
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import type { PlanConfig } from "../types";
import { AgentPlanError, NotInitializedError, StorePathOccupiedError } from "./errors";
import { branchExists, execGit, gitPath, runGit } from "./git";
import { warn } from "./output";
import { getGitCommonDir, getStoreDir, getStoreLink, realpathSafe, STORE_LINK_NAME } from "./paths";

async function lstatSafe(p: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  return (await lstatSafe(p)) !== null;
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

  const existing = await lstatSafe(storeDir);
  if (existing?.isSymbolicLink()) {
    // A link here points at some other store. Only the link itself is removed.
    await rm(storeDir);
  } else if (existing?.isDirectory() && !(await pathExists(path.join(storeDir, ".git")))) {
    await checkOutOverStrayDirectory(repoRoot, storeDir, config.branch);
    return;
  } else if (existing) {
    throw new StorePathOccupiedError(storeDir);
  }

  await mkdir(path.dirname(storeDir), { recursive: true });
  await execGit(["worktree", "add", "--quiet", storeDir, config.branch], repoRoot);
}

/**
 * Checks the docs branch out at the store path when a plain directory is
 * already there, keeping the files in it. Agents write into `.apl/` in the
 * main checkout before any apl command has created the store, and git
 * refuses to check out into a non-empty directory. Refuses before moving
 * anything when a file would overwrite different content on the branch.
 */
async function checkOutOverStrayDirectory(
  repoRoot: string,
  storeDir: string,
  branch: string,
): Promise<void> {
  const files = await listFilesRecursive(storeDir);
  await assertNoConflicts(storeDir, files, async (file) => {
    const { exitCode, stdout } = await runGit(["show", `${branch}:${file}`], repoRoot);
    return exitCode === 0 ? stdout : null;
  });

  const asideDir = await mkdtemp(path.join(await getGitCommonDir(repoRoot), "apl-stray-"));
  const strayDir = path.join(asideDir, STORE_LINK_NAME);
  await rename(storeDir, strayDir);
  try {
    await execGit(["worktree", "add", "--quiet", storeDir, branch], repoRoot);
  } catch (err) {
    await rename(strayDir, storeDir);
    await rm(asideDir, { recursive: true });
    throw err;
  }

  await cp(strayDir, storeDir, { recursive: true, force: true });
  await rm(asideDir, { recursive: true });
  if (files.length > 0) {
    warn(`Moved ${files.length} file(s) from ${storeDir} into the docs store`);
  }
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
 * Throws when any of `files` in `strayDir` differs from the store's copy.
 * `readStored` returns the store's content for a file, or null when the
 * store has no such file.
 */
async function assertNoConflicts(
  strayDir: string,
  files: string[],
  readStored: (file: string) => Promise<string | null>,
): Promise<void> {
  const conflicts: string[] = [];
  for (const file of files) {
    const stored = await readStored(file);
    if (stored === null) continue;
    if (stored !== (await Bun.file(path.join(strayDir, file)).text())) conflicts.push(file);
  }

  if (conflicts.length > 0) {
    throw new AgentPlanError(
      `${strayDir} is a directory that isn't the docs store, and these files in it ` +
        `differ from the store's copies: ${conflicts.join(", ")}. Move them out of the way, ` +
        "then run the command again.",
    );
  }
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
  await assertNoConflicts(linkPath, files, async (file) => {
    const existing = Bun.file(path.join(storeDir, file));
    return (await existing.exists()) ? existing.text() : null;
  });

  await cp(linkPath, storeDir, { recursive: true, force: true });
  await rm(linkPath, { recursive: true });
  if (files.length > 0) {
    warn(`Moved ${files.length} file(s) from ${linkPath} into the docs store`);
  }
}

async function ensureStoreLink(repoRoot: string, storeDir: string): Promise<void> {
  const linkPath = getStoreLink(repoRoot);
  // True in the main checkout, where `.apl` is the store itself, and in a
  // checkout whose link is already correct.
  if ((await realpathSafe(linkPath)) === (await realpathSafe(storeDir))) return;

  const existing = await lstatSafe(linkPath);
  if (existing?.isSymbolicLink()) {
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
 * checked out at `.apl` in the main checkout, and a `.apl` link to it in
 * every other checkout. Throws NotInitializedError when the branch doesn't exist and
 * cannot be fetched from the configured remote. Pass `isInit = true` when
 * called from `init`, which is about to create the branch.
 */
export async function ensureStore(
  repoRoot: string,
  config: PlanConfig,
  isInit = false,
): Promise<string> {
  const storeDir = await getStoreDir(repoRoot);

  await ensureInfoExclude(await getGitCommonDir(repoRoot));

  // Only the parent is resolved, so a symlink sitting at the store path, such
  // as one to a store elsewhere, doesn't count as the store.
  const storeInResolvedParent = path.join(
    await realpathSafe(path.dirname(storeDir)),
    path.basename(storeDir),
  );
  const worktreePaths = await Promise.all(
    (await listWorktrees(repoRoot)).map((w) => realpathSafe(w.path)),
  );
  const existing = await lstatSafe(storeDir);
  if (!worktreePaths.includes(storeInResolvedParent) || !existing || existing.isSymbolicLink()) {
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

/** The git operation the store is in the middle of, if any. */
export async function operationInProgress(
  storeDir: string,
): Promise<(typeof IN_PROGRESS_OPERATIONS)[number] | null> {
  for (const operation of IN_PROGRESS_OPERATIONS) {
    if (await pathExists(await gitPath(storeDir, operation.marker))) return operation;
  }
  return null;
}

/**
 * Throws when the store is in the middle of a rebase, merge, or cherry-pick.
 * Committing then would record conflict markers as document content and
 * leave the operation half-finished.
 */
export async function assertNoOperationInProgress(storeDir: string): Promise<void> {
  const operation = await operationInProgress(storeDir);
  if (!operation) return;
  throw new AgentPlanError(
    `A ${operation.name} is in progress in ${storeDir}. Resolve the conflicts, stage the files, ` +
      `and run 'git -C ${storeDir} ${operation.command} --continue', or cancel with ` +
      `'git -C ${storeDir} ${operation.command} --abort'. Then run the command again.`,
  );
}
