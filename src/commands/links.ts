import type { Command } from "commander";
import { readConfig } from "../lib/config";
import {
  type BranchLink,
  branchOrCurrent,
  docPathForLookup,
  readRecordedLinks,
  recordLinks,
} from "../lib/links";
import { withStoreLock } from "../lib/lock";
import { info, printTable } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { ensureStore, operationInProgress } from "../lib/worktree";

export interface LinksOptions {
  /** A branch name, or true when `--branch` was passed without one. */
  branch?: string | boolean;
  json?: boolean;
}

/**
 * Lists the links between docs and code branches, newest first: every link,
 * the links of one doc, or the links of one branch. Links made since the last
 * commit are recorded first, so the list never lags behind a doc an agent
 * just read.
 */
export async function listLinks(
  docInput: string | undefined,
  options: LinksOptions = {},
): Promise<BranchLink[]> {
  const repoRoot = await findRepoRoot();
  const links = await withStoreLock(repoRoot, async () => {
    const config = await readConfig(repoRoot);
    const storeDir = await ensureStore(repoRoot, config);

    // Recording needs a store that isn't mid-rebase. Listing doesn't.
    if (!(await operationInProgress(storeDir))) await recordLinks(repoRoot, storeDir);

    const doc = docInput === undefined ? undefined : await docPathForLookup(storeDir, docInput);
    const branch =
      options.branch === undefined
        ? undefined
        : await branchOrCurrent(
            repoRoot,
            typeof options.branch === "string" ? options.branch : undefined,
          );

    return (await readRecordedLinks(storeDir))
      .filter((link) => doc === undefined || link.docs.includes(doc))
      .filter((link) => branch === undefined || link.branch === branch)
      .reverse();
  });

  if (options.json) {
    console.log(JSON.stringify({ links }));
    return links;
  }

  if (links.length === 0) {
    info("No links found");
    return links;
  }

  printTable(
    ["BRANCH", "DOC", "COMMIT", "PR", "MERGED", "UPDATED"],
    links.flatMap((link) =>
      link.docs.map((doc) => [
        link.branch,
        doc,
        link.commit?.slice(0, 7) ?? "",
        link.pr === null ? "" : `#${link.pr}`,
        link.merged?.slice(0, 7) ?? (link.prState === "closed" ? "closed" : ""),
        link.updatedAt.slice(0, 10),
      ]),
    ),
  );
  return links;
}

export function registerLinks(program: Command): void {
  program
    .command("links [doc]")
    .description("List the code branches linked to docs")
    .option("--branch [name]", "Only links for this branch (the current branch when no name)")
    .option("--json", "Output in JSON format")
    .action(async (doc: string | undefined, options: LinksOptions) => {
      await listLinks(doc, options);
    });
}
