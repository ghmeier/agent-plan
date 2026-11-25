import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { AgentPlanError } from "../lib/errors";
import { branchExists, runGit } from "../lib/git";
import {
  addWorkingLink,
  assertWorkBranch,
  branchOrCurrent,
  recordLinks,
  resolveDocPath,
} from "../lib/links";
import { withStoreLock } from "../lib/lock";
import { info, success } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { assertNoOperationInProgress, ensureStore } from "../lib/worktree";

export interface LinkOptions {
  branch?: string;
}

/**
 * Links a doc to the branch that implements it and records the link on the
 * docs branch. The branch can be one that doesn't exist yet, so a plan can be
 * linked to the branches it names before they are created. Its link is then
 * recorded by the first commit or sync after the branch is created.
 */
export async function linkDoc(docInput: string, options: LinkOptions = {}): Promise<void> {
  const repoRoot = await findRepoRoot();
  await withStoreLock(repoRoot, async () => {
    const config = await readConfig(repoRoot);
    const storeDir = await ensureStore(repoRoot, config);

    const doc = await resolveDocPath(storeDir, docInput);
    const branch = await branchOrCurrent(repoRoot, options.branch);
    const exists = await branchExists(repoRoot, branch);
    if (!exists && !(await isValidBranchName(repoRoot, branch))) {
      throw new AgentPlanError(`'${branch}' is not a valid branch name.`);
    }
    await assertWorkBranch(repoRoot, branch, config);

    const added = await addWorkingLink(repoRoot, branch, doc);
    await assertNoOperationInProgress(storeDir);
    await recordLinks(repoRoot, storeDir);

    if (added && exists) {
      success(`Linked ${doc} to ${branch}`);
    } else if (added) {
      success(`Linked ${doc} to ${branch}, which will be recorded once the branch is created`);
    } else {
      info(`${doc} is already linked to ${branch}`);
    }
  });
}

async function isValidBranchName(repoRoot: string, branch: string): Promise<boolean> {
  const result = await runGit(["check-ref-format", "--branch", branch], repoRoot);
  return result.exitCode === 0;
}

export function registerLink(program: Command): void {
  program
    .command("link <doc>")
    .description("Link a doc to the branch that implements it")
    .option("--branch <name>", "Link this branch instead of the current one")
    .action(async (doc: string, options: LinkOptions) => {
      await linkDoc(doc, options);
    });
}
