import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { AgentPlanError, NotInitializedError } from "../lib/errors";
import { branchExists, runGit } from "../lib/git";
import { info, success } from "../lib/output";
import { findRepoRoot, getPlansDir } from "../lib/paths";
import { ensurePlansWorktree } from "../lib/worktree";
import { commitPlans } from "./commit";

export interface SyncOptions {
  cwd?: string;
}

/**
 * Rebases local plan commits onto the remote branch. On a conflict the rebase
 * is aborted, so `.plans/` is never left mid-rebase, and the error names the
 * conflicting files and the steps to resolve them by hand.
 */
async function rebaseOntoRemote(plansDir: string, upstream: string): Promise<void> {
  const rebase = await runGit(["rebase", upstream], plansDir);
  if (rebase.exitCode === 0) return;

  const conflicted = await runGit(["diff", "--name-only", "--diff-filter=U"], plansDir);
  await runGit(["rebase", "--abort"], plansDir);

  const files = conflicted.stdout.trim().split("\n").filter(Boolean);
  if (files.length === 0) {
    throw new Error(`git rebase ${upstream} failed: ${rebase.stderr.trim()}`);
  }

  throw new AgentPlanError(
    `Your plan changes conflict with ${upstream} in: ${files.join(", ")}. ` +
      "Nothing was pushed and your local commits are unchanged. To resolve: " +
      `run 'git -C ${plansDir} rebase ${upstream}', fix the conflicts, ` +
      `'git -C ${plansDir} add' the files, 'git -C ${plansDir} rebase --continue', ` +
      "then 'apl sync' again.",
  );
}

/**
 * Syncs the plans branch: commits pending worktree changes, rebases them onto
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

  await ensurePlansWorktree(repoRoot, config);

  // Commit any pending edits in .plans/ before syncing, so they travel with this push.
  await commitPlans({ cwd, quiet: true });

  const plansDir = getPlansDir(repoRoot);
  const upstream = `${config.remote}/${config.branch}`;

  // Fetch and push run from repoRoot so that relative remote URLs (like ../remote.git)
  // resolve relative to the repo root rather than the .plans/ worktree directory.
  const fetch = await runGit(["fetch", config.remote, config.branch], repoRoot);
  if (fetch.exitCode === 0) {
    await rebaseOntoRemote(plansDir, upstream);
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

  success(`Synced plans with ${config.remote}`);
}

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description("Commit pending changes, rebase onto the remote, and push")
    .action(async () => {
      await syncPlans();
    });
}
