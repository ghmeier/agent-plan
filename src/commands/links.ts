import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { AgentPlanError } from "../lib/errors";
import {
  type BranchLink,
  branchOrCurrent,
  docPathForLookup,
  findLinkCommitRange,
  readRecordedLinks,
  recordLinks,
} from "../lib/links";
import { withStoreLock } from "../lib/lock";
import { info, printTable } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { ensureStore, operationInProgress } from "../lib/worktree";
import { formatLogEntry, getLogFromWorktree, type LogEntry } from "./log";

export interface LinksOptions {
  /** A branch name, or true when `--branch` was passed without one. */
  branch?: string | boolean;
  json?: boolean;
  edits?: boolean;
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
    ["BRANCH", "DOC", "COMMIT", "UPDATED"],
    links.flatMap((link) =>
      link.docs.map((doc) => [
        link.branch,
        doc,
        link.commit?.slice(0, 7) ?? "",
        link.updatedAt.slice(0, 10),
      ]),
    ),
  );
  return links;
}

/**
 * Prints the docs-branch commits that changed `docInput` while `--branch` was
 * being worked on: from the commit that linked it to the commit that last
 * updated the link, which is the merge once the branch has merged and
 * otherwise the latest commit on the docs branch.
 */
export async function listLinkEdits(
  docInput: string | undefined,
  options: LinksOptions = {},
): Promise<LogEntry[]> {
  if (docInput === undefined || options.branch === undefined) {
    throw new AgentPlanError(
      "--edits needs a doc and --branch: apl links <doc> --branch <name> --edits",
    );
  }

  const repoRoot = await findRepoRoot();
  const entries = await withStoreLock(repoRoot, async () => {
    const config = await readConfig(repoRoot);
    const storeDir = await ensureStore(repoRoot, config);
    if (!(await operationInProgress(storeDir))) await recordLinks(repoRoot, storeDir);

    const doc = await docPathForLookup(storeDir, docInput);
    const branch = await branchOrCurrent(
      repoRoot,
      typeof options.branch === "string" ? options.branch : undefined,
    );
    const link = (await readRecordedLinks(storeDir))
      .filter((candidate) => candidate.branch === branch && candidate.docs.includes(doc))
      .at(-1);
    if (!link) throw new AgentPlanError(`${doc} is not linked to branch '${branch}'.`);

    const range = await findLinkCommitRange(storeDir, link);
    if (!range) return [];
    return getLogFromWorktree(storeDir, doc, undefined, {
      after: range.first,
      until: link.merged ? range.last : undefined,
    });
  });

  if (options.json) {
    console.log(JSON.stringify({ edits: entries }));
  } else if (entries.length === 0) {
    info("No edits found");
  } else {
    for (const entry of entries) console.log(formatLogEntry(entry));
  }
  return entries;
}

export function registerLinks(program: Command): void {
  program
    .command("links [doc]")
    .description("List the code branches linked to docs")
    .option("--branch [name]", "Only links for this branch (the current branch when no name)")
    .option("--edits", "Show the edits made to <doc> while --branch was being worked on")
    .option("--json", "Output in JSON format")
    .action(async (doc: string | undefined, options: LinksOptions) => {
      if (options.edits) {
        await listLinkEdits(doc, options);
      } else {
        await listLinks(doc, options);
      }
    });
}
