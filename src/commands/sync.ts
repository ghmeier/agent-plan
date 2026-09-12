import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { GitPlumbing } from "../lib/git";
import { findRepoRoot } from "../lib/paths";

export interface SyncOptions {
  cwd?: string;
}

/**
 * Syncs the plans branch with the configured remote: fetches and
 * fast-forwards from the remote when possible, then pushes local changes.
 * Exported separately from the Commander action so it can be exercised
 * directly in tests without going through the CLI.
 */
export async function syncPlans(options: SyncOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);
  const git = new GitPlumbing(repoRoot, config.branch);

  if (!(await git.branchExists())) {
    throw new Error(`Plans branch '${config.branch}' does not exist. Run 'plan init' first.`);
  }

  try {
    await git.exec(["remote", "get-url", config.remote]);
  } catch {
    console.log("No remote configured, skipping sync");
    return;
  }

  const remoteRef = `${config.remote}/${config.branch}`;

  let fetched = true;
  try {
    await git.exec(["fetch", config.remote, config.branch]);
  } catch {
    fetched = false;
  }

  if (fetched) {
    let isAncestor = true;
    try {
      await git.exec(["merge-base", "--is-ancestor", config.branch, remoteRef]);
    } catch {
      isAncestor = false;
    }

    if (isAncestor) {
      await git.exec(["update-ref", `refs/heads/${config.branch}`, remoteRef]);
    } else {
      console.warn("Local plans have diverged from remote, push may fail");
    }
  }

  try {
    await git.exec(["push", config.remote, config.branch]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }

  console.log(`Synced plans with ${config.remote}`);
}

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description("Sync plan storage with the remote")
    .action(async () => {
      try {
        await syncPlans();
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
