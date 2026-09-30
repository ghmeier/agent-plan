import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { stampTimestamps } from "../lib/frontmatter";
import { execGit, runGit } from "../lib/git";
import { info, success } from "../lib/output";
import { findRepoRoot, getPlansDir } from "../lib/paths";
import { assertNoOperationInProgress, ensurePlansWorktree } from "../lib/worktree";

/**
 * Stages all changes with `git add -A`, stamps updated timestamps into
 * modified markdown files that already have frontmatter, then re-stages them.
 * Returns true when there are staged changes ready to commit.
 */
async function stageAndStamp(plansDir: string): Promise<boolean> {
  await execGit(["add", "-A"], plansDir);

  // List added/modified markdown files in the index using NUL-delimited output
  // so paths with spaces or special characters are handled correctly.
  const { stdout: nameList } = await runGit(
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=AM"],
    plansDir,
  );

  const stagedPaths = nameList.split("\0").filter((p) => p.length > 0 && p.endsWith(".md"));

  const toRestage: string[] = [];

  for (const relPath of stagedPaths) {
    const fullPath = join(plansDir, relPath);
    const file = Bun.file(fullPath);
    if (!(await file.exists())) continue;

    const raw = await file.text();
    const stamped = stampTimestamps(raw);
    if (stamped !== raw) {
      await Bun.write(fullPath, stamped);
      toRestage.push(relPath);
    }
  }

  if (toRestage.length > 0) {
    await execGit(["add", "--", ...toRestage], plansDir);
  }

  const { exitCode: diffExitCode } = await runGit(["diff", "--cached", "--quiet"], plansDir);
  return diffExitCode !== 0;
}

export interface CommitOptions {
  message?: string;
  cwd?: string;
  /** Skip the "Nothing to commit" notice, for callers that commit as one step of a larger command. */
  quiet?: boolean;
}

export async function commitPlans(options: CommitOptions = {}): Promise<void> {
  const repoRoot = await findRepoRoot(options.cwd);
  const config = await readConfig(repoRoot);

  await ensurePlansWorktree(repoRoot, config);

  const plansDir = getPlansDir(repoRoot);
  await assertNoOperationInProgress(plansDir);
  const hasChanges = await stageAndStamp(plansDir);

  if (!hasChanges) {
    if (!options.quiet) info("Nothing to commit");
    return;
  }

  const message = options.message ?? "Update plans";
  await execGit(["commit", "-m", message], plansDir);

  success("Committed plan changes");
}

export function registerCommit(program: Command): void {
  program
    .command("commit")
    .description("Commit pending changes in .plans/")
    .option("-m, --message <msg>", "Commit message")
    .action(async (opts) => {
      await commitPlans(opts);
    });
}
