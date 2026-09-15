import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { NotInitializedError } from "../lib/errors";
import { GitPlumbing } from "../lib/git";
import { info, error as logError, success, warn } from "../lib/output";
import { findRepoRoot, getPlansDir } from "../lib/paths";
import { ensurePlansWorktree } from "../lib/worktree";
import { commitPlans } from "./commit";

export interface SyncOptions {
  cwd?: string;
}

async function runGitInPlans(
  args: string[],
  plansDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: plansDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Syncs the plans branch: commits pending worktree changes, fast-forward pulls
 * from the remote, then pushes. Exits with a warning when histories have
 * diverged. Skips gracefully when no remote is configured.
 */
export async function syncPlans(options: SyncOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);
  const git = new GitPlumbing(repoRoot, config.branch);

  if (!(await git.branchExists())) {
    throw new NotInitializedError();
  }

  // Confirm a remote is configured before doing anything.
  try {
    await git.exec(["remote", "get-url", config.remote]);
  } catch {
    info("No remote configured, skipping sync");
    return;
  }

  await ensurePlansWorktree(repoRoot, config);

  // Commit any pending edits in .plans/ before syncing, so they travel with this push.
  await commitPlans({ cwd });

  const plansDir = getPlansDir(repoRoot);

  const { exitCode: fetchCode, stderr: fetchErr } = await runGitInPlans(
    ["fetch", config.remote, config.branch],
    plansDir,
  );

  const remoteHasBranch = fetchCode === 0;

  if (!remoteHasBranch) {
    // If fetch failed for a reason other than the branch not existing on the remote,
    // report the error but still attempt to push (which will also fail with a clear message).
    const missingRef = fetchErr.includes("couldn't find remote ref");
    if (!missingRef) {
      logError(`fetch failed: ${fetchErr.trim()}`);
    }
  }

  if (remoteHasBranch) {
    // Attempt a fast-forward merge from the remote ref.
    const { exitCode: pullCode } = await runGitInPlans(
      ["merge", "--ff-only", `${config.remote}/${config.branch}`],
      plansDir,
    );

    if (pullCode !== 0) {
      warn(
        `Local plans have diverged from ${config.remote}/${config.branch}. ` +
          "Resolve the conflict manually, then sync again.",
      );
      process.exitCode = 1;
      return;
    }
  }

  const { exitCode: pushCode, stderr: pushErr } = await runGitInPlans(
    ["push", config.remote, `HEAD:${config.branch}`],
    plansDir,
  );

  if (pushCode !== 0) {
    logError(`push failed: ${pushErr.trim()}`);
    return;
  }

  success(`Synced plans with ${config.remote}`);
}

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description("Commit pending changes, pull from remote, and push")
    .action(async () => {
      await syncPlans();
    });
}
