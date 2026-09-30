import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { AgentPlanError, NotInitializedError } from "../lib/errors";
import { branchExists, runGit } from "../lib/git";
import { info, success } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { ensureStore } from "../lib/worktree";
import { commitPlans } from "./commit";

export interface SyncOptions {
  cwd?: string;
}

/**
 * Rebases local doc commits onto the remote branch. On a conflict the rebase
 * is aborted, so `.apl/` is never left mid-rebase, and the error names the
 * conflicting files and the steps to resolve them by hand.
 */
async function rebaseOntoRemote(storeDir: string, upstream: string): Promise<void> {
  const rebase = await runGit(["rebase", upstream], storeDir);
  if (rebase.exitCode === 0) return;

  const conflicted = await runGit(["diff", "--name-only", "--diff-filter=U"], storeDir);
  await runGit(["rebase", "--abort"], storeDir);

  const files = conflicted.stdout.trim().split("\n").filter(Boolean);
  if (files.length === 0) {
    throw new Error(`git rebase ${upstream} failed: ${rebase.stderr.trim()}`);
  }

  throw new AgentPlanError(
    `Your doc changes conflict with ${upstream} in: ${files.join(", ")}. ` +
      "Nothing was pushed and your local commits are unchanged. To resolve: " +
      `run 'git -C ${storeDir} rebase ${upstream}', fix the conflicts, ` +
      `'git -C ${storeDir} add' the files, 'git -C ${storeDir} rebase --continue', ` +
      "then 'apl sync' again.",
  );
}

/**
 * Syncs the docs branch: commits pending worktree changes, rebases them onto
 * the remote branch, then pushes. Skips gracefully when no remote is configured.
 */
export async function syncPlans(options: SyncOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);

  if (!(await branchExists(repoRoot, config.branch))) {
    throw new NotInitializedError();
  }

  if ((await runGit(["remote", "get-url", config.remote], repoRoot)).exitCode !== 0) {
    info("No remote configured, skipping sync");
    return;
  }

  const storeDir = await ensureStore(repoRoot, config);

  // Commit any pending edits in .apl/ before syncing, so they travel with this push.
  await commitPlans({ cwd, quiet: true });

  const upstream = `${config.remote}/${config.branch}`;

  // Fetch and push run from repoRoot so that relative remote URLs (like ../remote.git)
  // resolve relative to the repo root rather than the .apl/ worktree directory.
  const fetch = await runGit(["fetch", config.remote, config.branch], repoRoot);
  if (fetch.exitCode === 0) {
    await rebaseOntoRemote(storeDir, upstream);
  } else if (!fetch.stderr.includes("couldn't find remote ref")) {
    throw new AgentPlanError(`fetch failed: ${fetch.stderr.trim()}`);
  }

  const push = await runGit(
    ["push", config.remote, `refs/heads/${config.branch}:refs/heads/${config.branch}`],
    repoRoot,
  );
  if (push.exitCode !== 0) {
    throw new AgentPlanError(`push failed: ${push.stderr.trim()}`);
  }

  success(`Synced docs with ${config.remote}`);
}

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description("Commit pending changes, rebase onto the remote, and push")
    .action(async () => {
      await syncPlans();
    });
}
