import type { PlanConfig } from "../types";
import { AgentPlanError } from "./errors";
import { runGit } from "./git";

export function upstreamRef(config: PlanConfig): string {
  return `${config.remote}/${config.branch}`;
}

export async function hasRemote(repoRoot: string, config: PlanConfig): Promise<boolean> {
  return (await runGit(["remote", "get-url", config.remote], repoRoot)).exitCode === 0;
}

/**
 * Fetches the docs branch. Returns false when the remote doesn't have it yet.
 * Runs from the checkout rather than the store so that relative remote URLs
 * (like ../remote.git) resolve against the checkout, as they do for git itself.
 */
export async function fetchDocsBranch(repoRoot: string, config: PlanConfig): Promise<boolean> {
  const fetch = await runGit(["fetch", config.remote, config.branch], repoRoot);
  if (fetch.exitCode === 0) return true;
  if (fetch.stderr.includes("couldn't find remote ref")) return false;
  throw new AgentPlanError(`fetch failed: ${fetch.stderr.trim()}`);
}

/**
 * Rebases local doc commits onto the remote branch. Callers commit pending
 * edits first, since rebasing needs a clean store. On a conflict the rebase
 * is aborted, so the store is never left mid-rebase, and the error names the
 * conflicting files and the steps to resolve them by hand.
 */
export async function rebaseOntoRemote(storeDir: string, upstream: string): Promise<void> {
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
 * Commits on each side of the last-fetched remote branch, or null when it
 * has never been fetched. Uses no network, so it reflects the last fetch.
 */
export async function aheadBehind(
  storeDir: string,
  upstream: string,
): Promise<{ ahead: number; behind: number } | null> {
  const counts = await runGit(
    ["rev-list", "--left-right", "--count", `HEAD...refs/remotes/${upstream}`],
    storeDir,
  );
  if (counts.exitCode !== 0) return null;
  const [ahead = 0, behind = 0] = counts.stdout.trim().split(/\s+/).map(Number);
  return { ahead, behind };
}
