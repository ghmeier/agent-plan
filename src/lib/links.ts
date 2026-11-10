import path, { join } from "node:path";
import type { PlanConfig } from "../types";
import { AgentPlanError, FileNotFoundError } from "./errors";
import { branchExists, execGit, runGit, SKIP_CODE_HOOKS } from "./git";
import { runGh } from "./github";
import { realpathSafe, STORE_LINK_NAME } from "./paths";
import { isDocPath } from "./plan-files";

/**
 * A link between a code branch and the docs it implements has two parts.
 *
 * The working link is git config in the code repo, `branch.<name>.apl-doc`,
 * with one value per doc. Every checkout of a clone shares it and git drops
 * it when the branch is deleted. It tells apl which branches to watch.
 *
 * The record is an empty commit on the docs branch whose trailers name the
 * branch, its tip, and the docs. It is shared with teammates and outlives the
 * branch. Queries read only the record, so there is no file to keep in step.
 */
const WORKING_LINK_KEY = "apl-doc";

const TRAILER = {
  branch: "Code-Branch",
  commit: "Code-Commit",
  linked: "Linked-Doc",
  unlinked: "Unlinked-Doc",
  pullRequest: "Code-PR",
  merged: "Code-Merged",
  pullRequestState: "Code-PR-State",
} as const;

export interface BranchLink {
  branch: string;
  docs: string[];
  /** The branch tip when the link was last recorded. */
  commit: string | null;
  pr: number | null;
  /** The commit on the default branch that the pull request was squashed into. */
  merged: string | null;
  prState: string | null;
  linkedAt: string;
  updatedAt: string;
}

/** The branch checked out at `repoRoot`, or null on a detached HEAD. */
export async function currentBranch(repoRoot: string): Promise<string | null> {
  const head = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot);
  return head.exitCode === 0 ? head.stdout.trim() : null;
}

/**
 * The branch work is merged into, which never links to a doc. Taken from the
 * remote's HEAD, which a clone sets, then from `init.defaultBranch`, then
 * from whichever of `main` and `master` exists.
 */
export async function defaultBranch(repoRoot: string, config: PlanConfig): Promise<string> {
  const remoteHead = await runGit(
    ["symbolic-ref", "--quiet", "--short", `refs/remotes/${config.remote}/HEAD`],
    repoRoot,
  );
  const prefix = `${config.remote}/`;
  if (remoteHead.exitCode === 0 && remoteHead.stdout.startsWith(prefix)) {
    return remoteHead.stdout.trim().slice(prefix.length);
  }

  const configured = await runGit(["config", "--get", "init.defaultBranch"], repoRoot);
  if (configured.exitCode === 0 && configured.stdout.trim()) return configured.stdout.trim();

  if (!(await branchExists(repoRoot, "main")) && (await branchExists(repoRoot, "master"))) {
    return "master";
  }
  return "main";
}

/** Throws unless `branch` is a branch that work happens on. */
export async function assertWorkBranch(
  repoRoot: string,
  branch: string,
  config: PlanConfig,
): Promise<void> {
  if (branch === config.branch) {
    throw new AgentPlanError(`'${branch}' is the docs branch, which can't be linked to a doc.`);
  }
  if (branch === (await defaultBranch(repoRoot, config))) {
    throw new AgentPlanError(
      `'${branch}' is the default branch. Docs link to the branches that implement them; ` +
        "pass --branch <name> to link one.",
    );
  }
}

/**
 * Maps what a user typed for a doc to its path in the store. Accepts a path
 * with or without `.apl/` in front and with or without `.md`.
 */
export async function resolveDocPath(storeDir: string, input: string): Promise<string> {
  const linkPrefix = `${STORE_LINK_NAME}/`;
  const relative = input.startsWith(linkPrefix) ? input.slice(linkPrefix.length) : input;

  for (const candidate of [relative, `${relative}.md`]) {
    if (isDocPath(candidate) && (await Bun.file(join(storeDir, candidate)).exists())) {
      return candidate;
    }
  }
  throw new FileNotFoundError(relative);
}

function workingLinkKey(branch: string): string {
  return `branch.${branch}.${WORKING_LINK_KEY}`;
}

/** Docs linked to each branch in this clone's git config. */
export async function readWorkingLinks(repoRoot: string): Promise<Map<string, string[]>> {
  const links = new Map<string, string[]>();
  const result = await runGit(
    ["config", "--local", "-z", "--get-regexp", `^branch\\..*\\.${WORKING_LINK_KEY}$`],
    repoRoot,
  );
  // Git exits 1 when no key matches.
  if (result.exitCode !== 0) return links;

  // With -z each entry is the key, a newline, the value, then a NUL.
  for (const entry of result.stdout.split("\0").filter(Boolean)) {
    const newline = entry.indexOf("\n");
    if (newline === -1) continue;
    const key = entry.slice(0, newline);
    const branch = key.slice("branch.".length, -`.${WORKING_LINK_KEY}`.length);
    const docs = links.get(branch) ?? [];
    docs.push(entry.slice(newline + 1));
    links.set(branch, docs);
  }
  return links;
}

/** Links `doc` to `branch` in git config. Returns false when it was already linked. */
export async function addWorkingLink(
  repoRoot: string,
  branch: string,
  doc: string,
): Promise<boolean> {
  if ((await readWorkingLinks(repoRoot)).get(branch)?.includes(doc)) return false;
  await execGit(["config", "--local", "--add", workingLinkKey(branch), doc], repoRoot);
  return true;
}

/**
 * Links `doc` to the branch checked out at `repoRoot` because the doc was just
 * read or edited from there. Only the working link is written: no docs-branch
 * commit and no store lock, so the next commit or sync records it. Linking is
 * best-effort, so this never throws and the read or edit that triggered it is
 * never disturbed.
 */
export async function linkOnTouch(
  repoRoot: string,
  config: PlanConfig,
  doc: string,
): Promise<void> {
  try {
    if (!isDocPath(doc)) return;
    const branch = await currentBranch(repoRoot);
    if (!branch || branch === config.branch) return;
    if (branch === (await defaultBranch(repoRoot, config))) return;
    await addWorkingLink(repoRoot, branch, doc);
  } catch {
    // Best-effort: a failed link must not fail a read.
  }
}

/**
 * The store-relative path of `filePath` when it is a file in the store, or
 * null. `filePath` is the path as an agent addressed it, so it may go through
 * any checkout's `.apl` link or the store's real path. Both sides are
 * compared by their real paths too, since macOS paths can differ only by a
 * symlinked prefix such as /var and /private/var.
 */
export async function storeRelativePath(
  storeDir: string,
  filePath: string,
): Promise<string | null> {
  const storeReal = await realpathSafe(storeDir);
  for (const candidate of [filePath, await realpathSafe(filePath)]) {
    for (const root of [storeDir, storeReal]) {
      const relative = path.relative(root, candidate);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative.split(path.sep).join("/");
      }
    }
  }
  return null;
}

/** Removes the link from git config. Returns false when there was none. */
export async function removeWorkingLink(
  repoRoot: string,
  branch: string,
  doc: string,
): Promise<boolean> {
  const result = await runGit(
    ["config", "--local", "--fixed-value", "--unset-all", workingLinkKey(branch), doc],
    repoRoot,
  );
  return result.exitCode === 0;
}

async function localBranchTips(repoRoot: string): Promise<Map<string, string>> {
  const output = await execGit(
    ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"],
    repoRoot,
  );
  const tips = new Map<string, string>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [branch, commit] = line.split("\0");
    if (branch && commit) tips.set(branch, commit);
  }
  return tips;
}

async function isAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  // Also non-zero when either commit isn't in this clone, which counts as "not known to be".
  const result = await runGit(["merge-base", "--is-ancestor", ancestor, descendant], repoRoot);
  return result.exitCode === 0;
}

const LOG_FIELD_SEP = "\x1f";
const LOG_RECORD_SEP = "\x1e";
const TRAILER_LINE = /^([A-Za-z-]+): (.*)$/;

function isResolved(link: BranchLink): boolean {
  return link.merged !== null || link.prState === "closed";
}

/**
 * Every link recorded on the docs branch, oldest first. A branch name that is
 * reused after its pull request was merged or closed starts a new link, so
 * one name can appear more than once. Links whose docs were all unlinked are
 * left out.
 */
export async function readRecordedLinks(storeDir: string): Promise<BranchLink[]> {
  // The message is parsed here rather than with git's %(trailers) format,
  // whose options differ between git versions.
  const output = await execGit(
    [
      "log",
      "--reverse",
      `--grep=^${TRAILER.branch}: `,
      `--format=%aI${LOG_FIELD_SEP}%B${LOG_RECORD_SEP}`,
    ],
    storeDir,
  );

  const links: BranchLink[] = [];
  const latest = new Map<string, BranchLink>();

  for (const record of output.split(LOG_RECORD_SEP)) {
    const [date, message] = record.trim().split(LOG_FIELD_SEP);
    if (!date || !message) continue;

    const trailers = message
      .split("\n")
      .map((line) => TRAILER_LINE.exec(line))
      .filter((match) => match !== null)
      .map((match) => ({ key: match[1], value: (match[2] ?? "").trim() }));
    const allValues = (key: string) => trailers.filter((t) => t.key === key).map((t) => t.value);
    const lastValue = (key: string) => allValues(key).at(-1);

    const branch = lastValue(TRAILER.branch);
    if (!branch) continue;
    const commit = lastValue(TRAILER.commit);

    let link = latest.get(branch);
    if (!link || (isResolved(link) && commit !== undefined && commit !== link.commit)) {
      link = {
        branch,
        docs: [],
        commit: null,
        pr: null,
        merged: null,
        prState: null,
        linkedAt: date,
        updatedAt: date,
      };
      links.push(link);
      latest.set(branch, link);
    }

    for (const doc of allValues(TRAILER.linked)) {
      if (!link.docs.includes(doc)) link.docs.push(doc);
    }
    const unlinked = allValues(TRAILER.unlinked);
    link.docs = link.docs.filter((doc) => !unlinked.includes(doc));

    if (commit !== undefined) link.commit = commit;
    const pr = Number(lastValue(TRAILER.pullRequest));
    if (Number.isInteger(pr) && pr > 0) link.pr = pr;
    link.merged = lastValue(TRAILER.merged) ?? link.merged;
    link.prState = lastValue(TRAILER.pullRequestState) ?? link.prState;
    link.updatedAt = date;
  }

  return links.filter((link) => link.docs.length > 0);
}

function latestLinkByBranch(links: BranchLink[]): Map<string, BranchLink> {
  return new Map(links.map((link) => [link.branch, link]));
}

async function writeLinkCommit(
  storeDir: string,
  subject: string,
  trailers: Array<[key: string, value: string]>,
): Promise<void> {
  const message = `${subject}\n\n${trailers.map(([key, value]) => `${key}: ${value}`).join("\n")}\n`;
  await execGit(["commit", "--allow-empty", SKIP_CODE_HOOKS, "-m", message], storeDir);
}

function describeDocs(docs: string[]): string {
  const [first = "", ...rest] = docs;
  return rest.length > 0 ? `${first} and ${rest.length} more` : first;
}

/**
 * Records, on the docs branch, each linked branch that is new or whose tip
 * has moved since it was last recorded. Returns how many branches were
 * recorded. Callers hold the store lock and have committed pending doc edits,
 * so the commits this makes are empty.
 */
export async function recordLinks(repoRoot: string, storeDir: string): Promise<number> {
  const working = await readWorkingLinks(repoRoot);
  if (working.size === 0) return 0;

  const tips = await localBranchTips(repoRoot);
  const recorded = latestLinkByBranch(await readRecordedLinks(storeDir));
  let count = 0;

  for (const [branch, linkedDocs] of working) {
    const tip = tips.get(branch);
    if (!tip) continue;

    const docs: string[] = [];
    for (const doc of linkedDocs) {
      if (await Bun.file(join(storeDir, doc)).exists()) docs.push(doc);
    }
    if (docs.length === 0) continue;

    const existing = recorded.get(branch);
    // A teammate can record a newer tip than this clone has. Recording the
    // older local tip over it would make the two clones overwrite each other.
    const tipMoved =
      existing?.commit !== tip &&
      !(existing?.commit && (await isAncestor(repoRoot, tip, existing.commit)));
    const startsNewLink = !existing || (isResolved(existing) && tipMoved);
    const newDocs = startsNewLink ? docs : docs.filter((doc) => !existing.docs.includes(doc));
    if (newDocs.length === 0 && !tipMoved) continue;

    const subject =
      newDocs.length > 0
        ? `Link ${branch} to ${describeDocs(newDocs)}`
        : `Record ${branch} at ${tip.slice(0, 7)}`;
    await writeLinkCommit(storeDir, subject, [
      ...newDocs.map((doc): [string, string] => [TRAILER.linked, doc]),
      [TRAILER.branch, branch],
      [TRAILER.commit, tip],
    ]);
    count += 1;
  }

  return count;
}

/** Records that `doc` is no longer linked to `branch`. Returns false when no link was recorded. */
export async function recordUnlink(
  storeDir: string,
  branch: string,
  doc: string,
): Promise<boolean> {
  const link = latestLinkByBranch(await readRecordedLinks(storeDir)).get(branch);
  if (!link?.docs.includes(doc)) return false;

  await writeLinkCommit(storeDir, `Unlink ${branch} from ${doc}`, [
    [TRAILER.unlinked, doc],
    [TRAILER.branch, branch],
  ]);
  return true;
}

/** The branch named by `--branch`, or the one checked out at `repoRoot`. */
export async function branchOrCurrent(repoRoot: string, named?: string): Promise<string> {
  if (named) return named;
  const branch = await currentBranch(repoRoot);
  if (!branch) {
    throw new AgentPlanError("This checkout is not on a branch. Pass --branch <name>.");
  }
  return branch;
}

/**
 * Like `resolveDocPath`, but for looking up links: a doc that has since been
 * deleted still has links on record, so a missing file is not an error.
 */
export async function docPathForLookup(storeDir: string, input: string): Promise<string> {
  try {
    return await resolveDocPath(storeDir, input);
  } catch (err) {
    if (!(err instanceof FileNotFoundError)) throw err;
    const linkPrefix = `${STORE_LINK_NAME}/`;
    return input.startsWith(linkPrefix) ? input.slice(linkPrefix.length) : input;
  }
}

/** A link as the `links` field of `show --json` and `ls --json` reports it. */
export interface DocLink {
  branch: string;
  commit: string | null;
  pr: number | null;
  merged: string | null;
  prState: string | null;
}

/** The links that include `doc`, oldest first, as the `links` JSON field reports them. */
export function linksOfDoc(links: BranchLink[], doc: string): DocLink[] {
  return links
    .filter((link) => link.docs.includes(doc))
    .map(({ branch, commit, pr, merged, prState }) => ({ branch, commit, pr, merged, prState }));
}

/**
 * The link that is current for `branch`: the newest one, since a reused
 * branch name starts a new link. Undefined when the branch has no links.
 */
export function currentLinkOfBranch(links: BranchLink[], branch: string): BranchLink | undefined {
  return latestLinkByBranch(links).get(branch);
}

/**
 * The docs-branch commits that opened and last updated `link`, found by
 * matching the link's dates against the commits that name its branch. Edits
 * are then bounded by commit ancestry rather than by clock time, which only
 * has one-second resolution. Null when the commits are not in this clone.
 */
export async function findLinkCommitRange(
  storeDir: string,
  link: BranchLink,
): Promise<{ first: string; last: string } | null> {
  const output = await execGit(
    [
      "log",
      "--reverse",
      `--grep=^${TRAILER.branch}: `,
      `--format=%H${LOG_FIELD_SEP}%aI${LOG_FIELD_SEP}%B${LOG_RECORD_SEP}`,
    ],
    storeDir,
  );

  const branchLine = `${TRAILER.branch}: ${link.branch}`;
  let first: string | undefined;
  let last: string | undefined;
  for (const record of output.split(LOG_RECORD_SEP)) {
    const [hash, date, message] = record.trim().split(LOG_FIELD_SEP);
    if (!hash || !message?.split("\n").some((line) => line.trim() === branchLine)) continue;
    if (date === link.linkedAt) first ??= hash;
    if (date === link.updatedAt) last = hash;
  }
  return first && last ? { first, last } : null;
}

interface PullRequest {
  number: number;
  state: string;
  headRefOid: string;
  mergeCommit: { oid: string } | null;
  createdAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}

/** gh reports a pull request that is still open as having no end time, or as year 1. */
function endedAt(pullRequest: PullRequest): number | null {
  const ended = [pullRequest.closedAt, pullRequest.mergedAt]
    .filter((value): value is string => !!value && !value.startsWith("0001"))
    .map((value) => Date.parse(value))
    .filter((time) => !Number.isNaN(time));
  return ended.length > 0 ? Math.min(...ended) : null;
}

function newestFirst(a: PullRequest, b: PullRequest): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

/**
 * Finds the pull request a link's branch produced, or null when there is none
 * or gh could not be asked. The pull request whose head is the recorded tip
 * wins. Commits pushed after the last record leave no exact match, so the
 * fallback is the newest pull request for the branch that had not ended before
 * the link was made. Branch names get reused, and an older pull request that
 * closed before this link existed belongs to a different piece of work.
 */
async function findPullRequest(repoRoot: string, link: BranchLink): Promise<PullRequest | null> {
  const result = await runGh(
    [
      "pr",
      "list",
      "--head",
      link.branch,
      "--state",
      "all",
      "--json",
      "number,state,headRefOid,mergeCommit,createdAt,closedAt,mergedAt",
    ],
    repoRoot,
  );
  if (result.exitCode !== 0) return null;

  let pullRequests: PullRequest[];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return null;
    pullRequests = parsed as PullRequest[];
  } catch {
    return null;
  }

  const exact = pullRequests.filter((pr) => link.commit !== null && pr.headRefOid === link.commit);
  if (exact.length > 0) return exact.sort(newestFirst)[0] ?? null;

  const linkedAt = Date.parse(link.linkedAt);
  const current = pullRequests.filter((pr) => {
    const ended = endedAt(pr);
    return ended === null || ended >= linkedAt;
  });
  return current.sort(newestFirst)[0] ?? null;
}

export interface ResolveOptions {
  /** Only resolve the link for this branch. */
  branch?: string;
  /** Only resolve this many of the most recently updated unresolved links. */
  limit?: number;
}

/**
 * Asks GitHub about each unresolved link and records what it finds: the pull
 * request number, then the squash commit once merged or `closed` once closed
 * without merging. The team squash-merges, so a branch's own commits never
 * reach the default branch and the pull request is the only handle to the
 * squash commit. Nothing is written when the record already says the same
 * thing, so an open pull request costs one commit in total.
 *
 * Returns how many links changed. Any gh failure resolves nothing and never
 * throws, because gh is often missing or signed out. Callers hold the store
 * lock and have checked that the store is not mid-rebase.
 */
export async function resolveLinks(
  repoRoot: string,
  storeDir: string,
  options: ResolveOptions = {},
): Promise<number> {
  let pending = (await readRecordedLinks(storeDir))
    .filter((link) => !isResolved(link))
    .filter((link) => options.branch === undefined || link.branch === options.branch)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (options.limit !== undefined) pending = pending.slice(0, options.limit);

  const found = await Promise.all(
    pending.map(async (link) => ({ link, pullRequest: await findPullRequest(repoRoot, link) })),
  );

  let count = 0;
  for (const { link, pullRequest } of found) {
    if (!pullRequest) continue;

    const trailers: Array<[key: string, value: string]> = [[TRAILER.branch, link.branch]];
    const numberChanged = link.pr !== pullRequest.number;
    if (numberChanged) trailers.push([TRAILER.pullRequest, String(pullRequest.number)]);

    let subject = `Record pull request #${pullRequest.number} for ${link.branch}`;
    const squashCommit = pullRequest.mergeCommit?.oid;
    if (pullRequest.state === "MERGED" && squashCommit) {
      trailers.push([TRAILER.merged, squashCommit], [TRAILER.pullRequestState, "merged"]);
      subject = `Record ${link.branch} merged as ${squashCommit.slice(0, 7)}`;
    } else if (pullRequest.state === "CLOSED") {
      trailers.push([TRAILER.pullRequestState, "closed"]);
      subject = `Record pull request #${pullRequest.number} closed for ${link.branch}`;
    } else if (!numberChanged) {
      continue;
    }

    await writeLinkCommit(storeDir, subject, trailers);
    count += 1;
  }
  return count;
}
