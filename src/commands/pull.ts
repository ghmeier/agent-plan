import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { execGit } from "../lib/git";
import { info, success } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { fetchDocsBranch, hasRemote, rebaseOntoRemote, upstreamRef } from "../lib/remote";
import { ensureStore } from "../lib/worktree";
import { commitPlans } from "./commit";

/**
 * Brings in teammates' doc changes without publishing anything. Pending
 * edits are committed locally first, because rebasing needs a clean store.
 */
export async function pullDocs(options: { quiet?: boolean } = {}): Promise<void> {
  const repoRoot = await findRepoRoot();
  const config = await readConfig(repoRoot);

  // Sets up the store first, which in a fresh clone fetches the docs branch.
  const storeDir = await ensureStore(repoRoot, config);

  if (!(await hasRemote(repoRoot, config))) {
    if (!options.quiet) info("No remote configured, skipping pull");
    return;
  }
  await commitPlans({ quiet: true });

  const before = await execGit(["rev-parse", "HEAD"], storeDir);
  if (await fetchDocsBranch(repoRoot, config)) {
    await rebaseOntoRemote(storeDir, upstreamRef(config));
  }
  const after = await execGit(["rev-parse", "HEAD"], storeDir);

  if (options.quiet) return;
  if (before === after) {
    info(`Already up to date with ${config.remote}`);
  } else {
    success(`Pulled doc changes from ${config.remote}`);
  }
}

export function registerPull(program: Command): void {
  program
    .command("pull")
    .description("Rebase onto teammates' doc changes from the remote, without pushing")
    .option("-q, --quiet", "Print nothing unless something goes wrong")
    .action(async (options: { quiet?: boolean }) => {
      await pullDocs(options);
    });
}
