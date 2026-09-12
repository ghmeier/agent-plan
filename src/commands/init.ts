import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { readConfig, writeConfig } from "../lib/config";
import { GitPlumbing } from "../lib/git";
import { installAutoCommitHook, removeAutoCommitHook } from "../lib/hooks";
import { findRepoRoot } from "../lib/paths";
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

export async function initPlans(
  options: { branch?: string; cwd?: string; autoCommit?: boolean } = {},
): Promise<void> {
  const repoRoot = await findRepoRoot(options.cwd);

  const existingConfig = await readConfig(repoRoot);
  const branch = options.branch ?? existingConfig.branch ?? DEFAULT_CONFIG.branch;

  const git = new GitPlumbing(repoRoot, branch);
  const alreadyExisted = await git.branchExists();

  if (!alreadyExisted) {
    await git.createOrphanBranch();
  }

  await writeConfig(repoRoot, { ...existingConfig, branch });
  await ensureGitignoreEntry(repoRoot);

  if (options.autoCommit === true) {
    await installAutoCommitHook(repoRoot);
  } else if (options.autoCommit === false) {
    await removeAutoCommitHook(repoRoot);
  }

  if (alreadyExisted) {
    console.log(`Plan storage already initialized (branch '${branch}' exists)`);
  } else {
    console.log(`Initialized plan storage on branch '${branch}'`);
  }
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize plan storage in the current repository")
    .option("--branch <name>", "Branch name for plan storage", "plans")
    .option("--auto-commit", "Install a post-commit hook that auto-commits plan changes")
    .action(async (opts) => {
      try {
        await initPlans(opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to initialize plan storage: ${message}`);
        process.exit(1);
      }
    });
}
