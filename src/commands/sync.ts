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

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
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

  // Fetch and push run from repoRoot so that relative remote URLs (like ../remote.git)
  // resolve relative to the repo root rather than the .plans/ worktree directory.
  const { exitCode: fetchCode, stderr: fetchErr } = await runGit(
    ["fetch", config.remote, config.branch],
    repoRoot,
  );

  const remoteHasBranch = fetchCode === 0;

  if (!remoteHasBranch) {
    const missingRef = fetchErr.includes("couldn't find remote ref");
    if (!missingRef) {
      logError(`fetch failed: ${fetchErr.trim()}`);
      process.exitCode = 1;
      return;
    }
  }

  if (remoteHasBranch) {
    // Merge must run inside .plans/ to update that worktree's HEAD.
    const { exitCode: pullCode } = await runGit(
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

  // Use the full local refspec so this works from any CWD.
  const { exitCode: pushCode, stderr: pushErr } = await runGit(
    ["push", config.remote, `refs/heads/${config.branch}:refs/heads/${config.branch}`],
    repoRoot,
  );

  if (pushCode !== 0) {
    logError(`push failed: ${pushErr.trim()}`);
    process.exitCode = 1;
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
