import type { Command } from "commander";
import { readConfig, writeConfig } from "../lib/config";
import { NotARepoError } from "../lib/errors";
import { Git } from "../lib/git";
import { installAutoCommitHook, removeAutoCommitHook } from "../lib/hooks";
import { success } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { ensurePlansWorktree } from "../lib/worktree";
import { DEFAULT_CONFIG } from "../types";

export async function initPlans(
  options: { branch?: string; cwd?: string; autoCommit?: boolean } = {},
): Promise<void> {
  let repoRoot: string;
  try {
    repoRoot = await findRepoRoot(options.cwd);
  } catch {
    throw new NotARepoError();
  }

  const existingConfig = await readConfig(repoRoot);
  const branch = options.branch ?? existingConfig.branch ?? DEFAULT_CONFIG.branch;
  const remote = existingConfig.remote ?? DEFAULT_CONFIG.remote;

  const git = new Git(repoRoot, branch);
  const alreadyExisted = await git.branchExists();

  if (!alreadyExisted) {
    // Prefer building on an existing remote branch so that teammates who init
    // independently end up with shared history rather than unrelated orphans.
    let builtFromRemote = false;
    try {
      await git.exec(["remote", "get-url", remote]);
      await git.exec(["fetch", remote, branch]);
      await git.exec(["branch", branch, `${remote}/${branch}`]);
      builtFromRemote = true;
    } catch {
      // No remote, or the branch doesn't exist there yet — create a fresh orphan.
    }

    if (!builtFromRemote) {
      await git.createOrphanBranch();
    }
  }

  await ensurePlansWorktree(repoRoot, { branch, remote }, true);

  await writeConfig(repoRoot, { branch, remote });

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
    .option("--branch <name>", "Branch name for plan storage (default: plans)")
    .option("--auto-commit", "Install a post-commit hook that auto-commits plan changes")
    .option("--no-auto-commit", "Remove the auto-commit hook if one is installed")
    .action(async (opts) => {
      await initPlans(opts);
    });
}
