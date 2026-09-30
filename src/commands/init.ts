import type { Command } from "commander";
import { readConfig, writeConfig } from "../lib/config";
import { branchExists, createOrphanBranch, execGit } from "../lib/git";
import { installAutoCommitHook, removeAutoCommitHook } from "../lib/hooks";
import { success } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { ensureStore } from "../lib/worktree";
import { DEFAULT_CONFIG } from "../types";

export async function initPlans(
  options: { branch?: string; cwd?: string; autoCommit?: boolean } = {},
): Promise<void> {
  const repoRoot = await findRepoRoot(options.cwd);

  const existingConfig = await readConfig(repoRoot);
  const branch = options.branch ?? existingConfig.branch ?? DEFAULT_CONFIG.branch;
  const remote = existingConfig.remote ?? DEFAULT_CONFIG.remote;

  const alreadyExisted = await branchExists(repoRoot, branch);

  if (!alreadyExisted) {
    // Prefer building on an existing remote branch so that teammates who init
    // independently end up with shared history rather than unrelated orphans.
    let builtFromRemote = false;
    try {
      await execGit(["remote", "get-url", remote], repoRoot);
      await execGit(["fetch", remote, branch], repoRoot);
      await execGit(["branch", branch, `${remote}/${branch}`], repoRoot);
      builtFromRemote = true;
    } catch {
      // No remote, or the branch doesn't exist there yet — create a fresh orphan.
    }

    if (!builtFromRemote) {
      await createOrphanBranch(repoRoot, branch);
    }
  }

  await ensureStore(repoRoot, { branch, remote }, true);

  await writeConfig(repoRoot, { branch, remote });

  if (options.autoCommit === true) {
    await installAutoCommitHook(repoRoot);
  } else if (options.autoCommit === false) {
    await removeAutoCommitHook(repoRoot);
  }

  if (alreadyExisted) {
    success(`Doc storage already initialized (branch '${branch}' exists)`);
  } else {
    success(`Initialized doc storage on branch '${branch}'`);
  }
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize doc storage in the current repository")
    .option("--branch <name>", "Branch name for doc storage (default: apl)")
    .option("--auto-commit", "Install a post-commit hook that auto-commits doc changes")
    .option("--no-auto-commit", "Remove the auto-commit hook if one is installed")
    .action(async (opts) => {
      await initPlans(opts);
    });
}
