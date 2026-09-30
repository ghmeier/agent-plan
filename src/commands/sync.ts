import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { AgentPlanError } from "../lib/errors";
import { runGit, SKIP_CODE_HOOKS } from "../lib/git";
import { info, success } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import {
  aheadBehind,
  fetchDocsBranch,
  hasRemote,
  rebaseOntoRemote,
  upstreamRef,
} from "../lib/remote";
import { ensureStore } from "../lib/worktree";
import { commitPlans } from "./commit";

export interface SyncOptions {
  cwd?: string;
  /** Skip the network entirely when there's nothing local to publish. */
  ifChanged?: boolean;
}

/**
 * Syncs the docs branch: commits pending worktree changes, rebases them onto
 * the remote branch, then pushes. Skips gracefully when no remote is configured.
 */
export async function syncPlans(options: SyncOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);

  // Sets up the store first, which in a fresh clone fetches the docs branch.
  const storeDir = await ensureStore(repoRoot, config);

  if (!(await hasRemote(repoRoot, config))) {
    if (!options.ifChanged) info("No remote configured, skipping sync");
    return;
  }
  const upstream = upstreamRef(config);

  // Commit any pending edits in .apl/ before syncing, so they travel with this push.
  const committed = await commitPlans({ cwd, quiet: true });

  if (options.ifChanged && !committed && (await aheadBehind(storeDir, upstream))?.ahead === 0) {
    return;
  }

  if (await fetchDocsBranch(repoRoot, config)) {
    await rebaseOntoRemote(storeDir, upstream);
  }

  const push = await runGit(
    [
      "push",
      SKIP_CODE_HOOKS,
      config.remote,
      `refs/heads/${config.branch}:refs/heads/${config.branch}`,
    ],
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
    .option(
      "--if-changed",
      "Do nothing unless there are local changes to publish (for hooks that run often)",
    )
    .action(async (options: { ifChanged?: boolean }) => {
      await syncPlans(options);
    });
}
