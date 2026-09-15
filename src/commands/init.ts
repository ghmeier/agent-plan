import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { readConfig, writeConfig } from "../lib/config";
import { NotARepoError } from "../lib/errors";
import { GitPlumbing } from "../lib/git";
import { installAutoCommitHook, removeAutoCommitHook } from "../lib/hooks";
import { success } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { ensurePlansWorktree } from "../lib/worktree";
import { DEFAULT_CONFIG } from "../types";

async function ensureGitignoreEntry(repoRoot: string): Promise<void> {
  const gitignorePath = join(repoRoot, ".gitignore");

  let contents = "";
  try {
    contents = await readFile(gitignorePath, "utf8");
  } catch {
    contents = "";
  }

  const lines = contents.split("\n");

  // Replace an existing `.plans/` entry with `.plans` (no trailing slash so
  // git also ignores the symlink that secondary worktrees create).
  const replaced = lines.map((l) => (l.trim() === ".plans/" ? ".plans" : l));

  if (replaced.some((l) => l.trim() === ".plans")) {
    if (replaced.join("\n") !== lines.join("\n")) {
      await writeFile(gitignorePath, replaced.join("\n"));
    }
    return;
  }

  // Not present at all — append.
  const prefix = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  await writeFile(gitignorePath, `${contents}${prefix}.plans\n`);
}

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

  const git = new GitPlumbing(repoRoot, branch);
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
    .option("--auto-commit", "Install a post-commit hook that auto-commits plan changes")
    .option("--no-auto-commit", "Remove the auto-commit hook if one is installed")
    .action(async (opts) => {
      await initPlans(opts);
    });
}
