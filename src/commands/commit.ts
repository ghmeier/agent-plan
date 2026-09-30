import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { stampTimestamps } from "../lib/frontmatter";
import { execGit, runGit } from "../lib/git";
import { info, success } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { assertNoOperationInProgress, ensureStore } from "../lib/worktree";

/**
 * Stages all changes with `git add -A`, stamps updated timestamps into
 * modified markdown files that already have frontmatter, then re-stages them.
 * Returns true when there are staged changes ready to commit.
 */
async function stageAndStamp(storeDir: string): Promise<boolean> {
  await execGit(["add", "-A"], storeDir);

  // List added/modified markdown files in the index using NUL-delimited output
  // so paths with spaces or special characters are handled correctly.
  const { stdout: nameList } = await runGit(
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=AM"],
    storeDir,
  );

  const stagedPaths = nameList.split("\0").filter((p) => p.length > 0 && p.endsWith(".md"));

  const toRestage: string[] = [];

  for (const relPath of stagedPaths) {
    const fullPath = join(storeDir, relPath);
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
    await execGit(["add", "--", ...toRestage], storeDir);
  }

  const { exitCode: diffExitCode } = await runGit(["diff", "--cached", "--quiet"], storeDir);
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

  const storeDir = await ensureStore(repoRoot, config);

  await assertNoOperationInProgress(storeDir);
  const hasChanges = await stageAndStamp(storeDir);

  if (!hasChanges) {
    if (!options.quiet) info("Nothing to commit");
    return;
  }

  const message = options.message ?? "Update docs";
  await execGit(["commit", "-m", message], storeDir);

  success("Committed doc changes");
}

export function registerCommit(program: Command): void {
  program
    .command("commit")
    .description("Commit pending changes in .apl/")
    .option("-m, --message <msg>", "Commit message")
    .action(async (opts) => {
      await commitPlans(opts);
    });
}
