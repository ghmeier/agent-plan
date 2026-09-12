import { readFile, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { readConfig, writeConfig } from "../lib/config";
import { NotARepoError } from "../lib/errors";
import { GitPlumbing } from "../lib/git";
import { installAutoCommitHook, removeAutoCommitHook } from "../lib/hooks";
import { success } from "../lib/output";
import { findRepoRoot, getPlansDir } from "../lib/paths";
import { DEFAULT_CONFIG } from "../types";

async function ensureGitignoreEntry(repoRoot: string): Promise<void> {
  const gitignorePath = join(repoRoot, ".gitignore");

  let contents = "";
  try {
    contents = await readFile(gitignorePath, "utf8");
  } catch {
    contents = "";
  }

  const alreadyIgnored = contents
    .split("\n")
    .some((line) => line.trim() === ".plans" || line.trim() === ".plans/");

  if (alreadyIgnored) {
    return;
  }

  const prefix = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  await writeFile(gitignorePath, `${contents}${prefix}.plans/\n`);
}

async function realpathSafe(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function isWorktree(repoRoot: string, plansDir: string): Promise<boolean> {
  const git = new GitPlumbing(repoRoot);
  const output = await git.exec(["worktree", "list", "--porcelain"]);
  const resolvedPlansDir = await realpathSafe(plansDir);

  const worktreePaths = await Promise.all(
    output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => realpathSafe(line.slice("worktree ".length))),
  );

  return worktreePaths.includes(resolvedPlansDir);
}

async function addWorktree(repoRoot: string, plansDir: string, branch: string): Promise<void> {
  const git = new GitPlumbing(repoRoot);

  if (await isWorktree(repoRoot, plansDir)) {
    return;
  }

  // .plans/ may already exist as a plain directory (e.g. holding config.json);
  // it needs to be gone before `git worktree add` can claim the path.
  await rm(plansDir, { recursive: true, force: true });

  await git.exec(["worktree", "add", plansDir, branch]);
}

async function removeWorktree(repoRoot: string, plansDir: string): Promise<void> {
  const git = new GitPlumbing(repoRoot);

  if (!(await isWorktree(repoRoot, plansDir))) {
    return;
  }

  await git.exec(["worktree", "remove", "--force", plansDir]);
}

export async function initPlans(
  options: { branch?: string; cwd?: string; worktree?: boolean; autoCommit?: boolean } = {},
): Promise<void> {
  let repoRoot: string;
  try {
    repoRoot = await findRepoRoot(options.cwd);
  } catch {
    throw new NotARepoError();
  }

  const existingConfig = await readConfig(repoRoot);
  const branch = options.branch ?? existingConfig.branch ?? DEFAULT_CONFIG.branch;
  const plansDir = getPlansDir(repoRoot);

  const git = new GitPlumbing(repoRoot, branch);
  const alreadyExisted = await git.branchExists();

  if (!alreadyExisted) {
    await git.createOrphanBranch();
  }

  const wantsWorktree = options.worktree ?? existingConfig.worktree;

  if (wantsWorktree) {
    await addWorktree(repoRoot, plansDir, branch);
  } else if (existingConfig.worktree) {
    await removeWorktree(repoRoot, plansDir);
  }

  await writeConfig(repoRoot, { ...existingConfig, branch, worktree: wantsWorktree });
  await ensureGitignoreEntry(repoRoot);

  if (options.autoCommit === true) {
    await installAutoCommitHook(repoRoot);
  } else if (options.autoCommit === false) {
    await removeAutoCommitHook(repoRoot);
  }

  if (alreadyExisted) {
    success(`Plan storage already initialized (branch '${branch}' exists)`);
  } else {
    success(`Initialized plan storage on branch '${branch}'`);
  }
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize plan storage in the current repository")
    .option("--branch <name>", "Branch name for plan storage", "plans")
    .option("--worktree", "Check out .plans/ as a git worktree for direct file access")
    .option("--no-worktree", "Tear down the .plans/ worktree if one exists")
    .option("--auto-commit", "Install a post-commit hook that auto-commits plan changes")
    .action(async (opts) => {
      await initPlans(opts);
    });
}
