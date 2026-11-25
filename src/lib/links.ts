import path, { join } from "node:path";
import type { PlanConfig } from "../types";
import { readConfig } from "./config";
import { AgentPlanError, FileNotFoundError } from "./errors";
import { fileExists, readTextIfExists } from "./fs";
import { branchExists, execGit, runGit, SKIP_CODE_HOOKS } from "./git";
import { realpathSafe, STORE_LINK_NAME } from "./paths";
import { isDocPath, listMarkdownFiles } from "./plan-files";

/**
 * A link between a code branch and the docs it implements has two parts.
 *
 * The working link is git config in the code repo, `branch.<name>.apl-doc`,
 * with one value per doc. Every checkout of a clone shares it and git drops
 * it when the branch is deleted. It tells apl which branches to watch, and
 * can name a branch that doesn't exist yet: git keeps the key when the branch
 * is created, so a plan can name its branches before any work starts.
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
} as const;

export interface BranchLink {
  branch: string;
  docs: string[];
  /** The branch tip when the link was last recorded. */
  commit: string | null;
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
 * The store-relative form of what a user typed for a doc: a path in the store,
 * a path with `.apl/` in front, or a path through any checkout's `.apl` link,
 * absolute or relative to the working directory.
 */
async function storeRelativeInput(storeDir: string, input: string): Promise<string> {
  const addressed = await storeRelativePath(storeDir, path.resolve(input));
  if (addressed) return addressed;
  const linkPrefix = `${STORE_LINK_NAME}/`;
  return input.startsWith(linkPrefix) ? input.slice(linkPrefix.length) : input;
}

/**
 * Maps what a user typed for a doc to its path in the store. Accepts any path
 * `storeRelativeInput` does, with or without `.md`.
 */
export async function resolveDocPath(storeDir: string, input: string): Promise<string> {
  const relative = await storeRelativeInput(storeDir, input);

  for (const candidate of [relative, `${relative}.md`]) {
    if (isDocPath(candidate) && (await fileExists(join(storeDir, candidate)))) {
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
 * The store-relative path of `filePath` when it is a file in the store, or
 * null. `filePath` is the path as it was addressed, so it may go through
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

interface LinkHistory {
  /** One per branch name, oldest first, including links whose docs were all unlinked. */
  links: BranchLink[];
  /** For each branch, the docs whose latest record is an unlink. */
  unlinked: Map<string, Set<string>>;
}

/**
 * Every link recorded on the docs branch, one per branch name, oldest first.
 * Nothing records that a branch was merged, so a name that is reused later
 * continues its old link. Links whose docs were all unlinked are left out.
 */
export async function readRecordedLinks(storeDir: string): Promise<BranchLink[]> {
  const { links } = await readLinkHistory(storeDir);
  return links.filter((link) => link.docs.length > 0);
}

async function readLinkHistory(storeDir: string): Promise<LinkHistory> {
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
  const unlinkedByBranch = new Map<string, Set<string>>();

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
    if (!link) {
      link = {
        branch,
        docs: [],
        commit: null,
        linkedAt: date,
        updatedAt: date,
      };
      links.push(link);
      latest.set(branch, link);
    }

    const branchUnlinked = unlinkedByBranch.get(branch) ?? new Set<string>();
    unlinkedByBranch.set(branch, branchUnlinked);
    for (const doc of allValues(TRAILER.linked)) {
      if (!link.docs.includes(doc)) link.docs.push(doc);
      branchUnlinked.delete(doc);
    }
    const unlinked = allValues(TRAILER.unlinked);
    link.docs = link.docs.filter((doc) => !unlinked.includes(doc));
    for (const doc of unlinked) branchUnlinked.add(doc);

    if (commit !== undefined) link.commit = commit;
    link.updatedAt = date;
  }

  return { links, unlinked: unlinkedByBranch };
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
 * The ticket key a branch name starts with, such as `sc-123` in
 * `sc-123-fix-login` or `ENG-42` in `ENG-42/retry`, or null. Docs often
 * name the ticket rather than the branch.
 */
function ticketKey(branch: string): string | null {
  return /^([A-Za-z]+-\d+)(?:[-_/]|$)/.exec(branch)?.[1] ?? null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A pattern for `term` as a whole token in prose. A branch name is not
 * matched inside a longer name or a path (`fix-login` in
 * `fix-login-page`), but a ticket key can be followed by the rest of a
 * branch name, since any branch for the ticket is for the same work.
 */
function mentionPattern(term: string, isTicketKey: boolean): RegExp {
  const after = isTicketKey ? "(?![\\w])" : "(?![\\w/-])";
  return new RegExp(`(?<![\\w./-])${escapeRegExp(term)}${after}`);
}

/**
 * The docs that name each branch, by its full name or by its ticket key.
 * A plan that names the branches that implement it is linked to them by
 * that alone, so neither an orchestrator nor its subagents run anything to
 * link. Single-word names such as `staging` are skipped, since they are
 * ordinary words in prose.
 */
async function findMentionedLinks(
  storeDir: string,
  branches: string[],
): Promise<Map<string, string[]>> {
  const terms = branches
    .filter((branch) => /[-/_]/.test(branch))
    .flatMap((branch) => {
      const key = ticketKey(branch);
      const byName = { branch, term: branch, pattern: mentionPattern(branch, false) };
      if (!key || key === branch) return [byName];
      return [byName, { branch, term: key, pattern: mentionPattern(key, true) }];
    });

  const mentioned = new Map<string, string[]>();
  if (terms.length === 0) return mentioned;

  for (const doc of await listMarkdownFiles(storeDir)) {
    const content = await readTextIfExists(join(storeDir, doc));
    if (content === null) continue;
    for (const { branch, term, pattern } of terms) {
      if (!content.includes(term) || !pattern.test(content)) continue;
      const docs = mentioned.get(branch) ?? [];
      if (!docs.includes(doc)) docs.push(doc);
      mentioned.set(branch, docs);
    }
  }
  return mentioned;
}

/**
 * Records, on the docs branch, each linked branch that is new or whose tip
 * has moved since it was last recorded. A branch is linked to the docs that
 * name it and to the docs linked to it with `apl link`. A doc that was
 * unlinked with `apl unlink` isn't linked again for naming the branch.
 * Returns how many branches were recorded. Callers hold the store lock and
 * have committed pending doc edits, so the commits this makes are empty.
 */
export async function recordLinks(repoRoot: string, storeDir: string): Promise<number> {
  const config = await readConfig(repoRoot);
  const tips = await localBranchTips(repoRoot);
  const ignored = new Set([config.branch, await defaultBranch(repoRoot, config)]);
  const workBranches = [...tips.keys()].filter((branch) => !ignored.has(branch));

  const working = await readWorkingLinks(repoRoot);
  const mentioned = await findMentionedLinks(storeDir, workBranches);
  const history = await readLinkHistory(storeDir);
  const recorded = latestLinkByBranch(history.links);
  let count = 0;

  for (const branch of workBranches) {
    const tip = tips.get(branch);
    if (!tip) continue;

    const docs: string[] = [];
    for (const doc of working.get(branch) ?? []) {
      if (await fileExists(join(storeDir, doc))) docs.push(doc);
    }
    const unlinked = history.unlinked.get(branch);
    for (const doc of mentioned.get(branch) ?? []) {
      if (!docs.includes(doc) && !unlinked?.has(doc)) docs.push(doc);
    }
    if (docs.length === 0) continue;

    const existing = recorded.get(branch);
    // A teammate can record a newer tip than this clone has. Recording the
    // older local tip over it would make the two clones overwrite each other.
    const tipMoved =
      existing?.commit !== tip &&
      !(existing?.commit && (await isAncestor(repoRoot, tip, existing.commit)));
    const newDocs = existing ? docs.filter((doc) => !existing.docs.includes(doc)) : docs;
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
    return storeRelativeInput(storeDir, input);
  }
}

/** A link as the `links` field of `show --json` and `ls --json` reports it. */
export interface DocLink {
  branch: string;
  commit: string | null;
}

/** The links that include `doc`, oldest first, as the `links` JSON field reports them. */
export function linksOfDoc(links: BranchLink[], doc: string): DocLink[] {
  return links
    .filter((link) => link.docs.includes(doc))
    .map(({ branch, commit }) => ({ branch, commit }));
}

/**
 * The link for `branch`, or undefined when the branch has no links.
 */
export function currentLinkOfBranch(links: BranchLink[], branch: string): BranchLink | undefined {
  return latestLinkByBranch(links).get(branch);
}

/**
 * The docs-branch commit that opened `link`, found by matching the link's
 * date against the commits that name its branch. Edits made since are then
 * found by commit ancestry rather than by clock time, which only has
 * one-second resolution. Null when the commit is not in this clone.
 */
export async function findFirstLinkCommit(
  storeDir: string,
  link: BranchLink,
): Promise<string | null> {
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
  for (const record of output.split(LOG_RECORD_SEP)) {
    const [hash, date, message] = record.trim().split(LOG_FIELD_SEP);
    if (!hash || !message?.split("\n").some((line) => line.trim() === branchLine)) continue;
    if (date === link.linkedAt) return hash;
  }
  return null;
}
