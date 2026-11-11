import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { AgentPlanError } from "../lib/errors";
import { branchOrCurrent, docPathForLookup, recordUnlink, removeWorkingLink } from "../lib/links";
import { withStoreLock } from "../lib/lock";
import { success } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { assertNoOperationInProgress, ensureStore } from "../lib/worktree";

export interface UnlinkOptions {
  branch?: string;
}

/**
 * Removes a link, both from this clone's git config and, with a new commit,
 * from the record on the docs branch. The branch doesn't have to exist any
 * more, so a link to a deleted branch can still be removed.
 */
export async function unlinkDoc(docInput: string, options: UnlinkOptions = {}): Promise<void> {
  const repoRoot = await findRepoRoot();
  await withStoreLock(repoRoot, async () => {
    const config = await readConfig(repoRoot);
    const storeDir = await ensureStore(repoRoot, config);

    const doc = await docPathForLookup(storeDir, docInput);
    const branch = await branchOrCurrent(repoRoot, options.branch);

    const removed = await removeWorkingLink(repoRoot, branch, doc);
    await assertNoOperationInProgress(storeDir);
    const recorded = await recordUnlink(storeDir, branch, doc);

    if (!removed && !recorded) {
      throw new AgentPlanError(
        `${doc} is not linked to ${branch}. See what is with 'apl links --branch ${branch}'.`,
      );
    }
    success(`Unlinked ${doc} from ${branch}`);
  });
}

export function registerUnlink(program: Command): void {
  program
    .command("unlink <doc>")
    .description("Remove the link between a doc and a branch")
    .option("--branch <name>", "Unlink this branch instead of the current one")
    .action(async (doc: string, options: UnlinkOptions) => {
      await unlinkDoc(doc, options);
    });
}
