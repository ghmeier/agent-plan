import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { readDocTypes, typeOf, withValidStatus } from "../lib/doc-types";
import { AgentPlanError, FileNotFoundError } from "../lib/errors";
import { type PlanMeta, parseFrontmatter } from "../lib/frontmatter";
import { fileExists, readTextIfExists } from "../lib/fs";
import { runGit } from "../lib/git";
import { findHeadings, findSections, type Heading, type Section } from "../lib/headings";
import {
  type BranchLink,
  branchOrCurrent,
  currentLinkOfBranch,
  linkOnTouch,
  linksOfDoc,
  readRecordedLinks,
} from "../lib/links";
import { colors } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { ensureStore } from "../lib/worktree";

async function readFromHistory(storeDir: string, ref: string, planPath: string): Promise<string> {
  if (
    (await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], storeDir)).exitCode !== 0
  ) {
    throw new AgentPlanError(`Unknown revision: ${ref}`);
  }

  const { exitCode, stdout, stderr } = await runGit(["show", `${ref}:${planPath}`], storeDir);
  if (exitCode === 0) return stdout;
  if (stderr.includes("does not exist") || stderr.includes("exists on disk, but not in")) {
    throw new FileNotFoundError(`${planPath} at ${ref}`);
  }
  throw new Error(`git show ${ref}:${planPath} failed: ${stderr.trim()}`);
}

async function readFromWorktree(storeDir: string, planPath: string): Promise<string> {
  const content = await readTextIfExists(join(storeDir, planPath));
  if (content !== null) return content;

  if (!planPath.endsWith(".md")) {
    const withExtension = await readTextIfExists(join(storeDir, `${planPath}.md`));
    if (withExtension !== null) return withExtension;
  }

  if ((await stat(join(storeDir, planPath)).catch(() => null))?.isDirectory()) {
    throw new AgentPlanError(
      `${planPath} is a directory. List its docs with 'apl ls ${planPath}'.`,
    );
  }
  throw new FileNotFoundError(planPath);
}

export interface ShowOptions {
  at?: string;
  /** A branch name, or true when `--branch` was passed without one. */
  branch?: string | boolean;
  json?: boolean;
  outline?: boolean;
  raw?: boolean;
  section?: string;
}

function formatOutline(headings: Heading[]): string {
  return headings
    .map((h) => `L${h.line}  ${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.text}`)
    .join("\n");
}

/** Sections whose heading contains `query`, or an error listing the headings there are. */
function matchingSections(planPath: string, content: string, query: string): Section[] {
  const sections = findSections(content, query);
  if (sections.length > 0) return sections;

  const headings = findHeadings(content);
  const available =
    headings.length > 0 ? `Its headings are:\n${formatOutline(headings)}` : "It has no headings.";
  throw new AgentPlanError(`No heading in ${planPath} contains "${query}". ${available}`);
}

/**
 * Prints one doc, or with `--json` returns what it would print so a caller
 * can wrap it. `links` is read once by the caller, which has no use for it
 * unless it is printing JSON.
 */
async function renderDoc(
  storeDir: string,
  planPath: string,
  options: ShowOptions,
  links: BranchLink[],
): Promise<{ content: string; json?: object }> {
  const content = options.at
    ? await readFromHistory(storeDir, options.at, planPath)
    : await readFromWorktree(storeDir, planPath);

  if (options.raw && !options.outline && options.section === undefined) {
    process.stdout.write(content);
    return { content };
  }

  const type = typeOf(planPath, await readDocTypes(storeDir));
  const parsed = parseFrontmatter(content);
  const meta = withValidStatus(parsed.meta, type, planPath);
  const body = parsed.content;

  if (options.outline) {
    const headings = findHeadings(content);
    if (options.json) return { content, json: { path: planPath, headings } };
    if (!options.raw) printMetaHeader(meta, type?.name);
    if (headings.length > 0) console.log(formatOutline(headings));
    return { content };
  }

  if (options.section !== undefined) {
    const sections = matchingSections(planPath, content, options.section);
    if (options.json) return { content, json: { path: planPath, sections } };
    if (!options.raw) printMetaHeader(meta, type?.name);
    process.stdout.write(sections.map((section) => section.content).join("\n"));
    return { content };
  }

  if (options.json) {
    return {
      content,
      json: {
        path: planPath,
        type: type?.name ?? null,
        content,
        meta,
        body,
        links: linksOfDoc(links, planPath),
      },
    };
  }

  if (parsed.hasFrontmatter) {
    printMetaHeader(meta, type?.name);
    process.stdout.write(body);
  } else {
    process.stdout.write(content);
  }

  return { content };
}

function assertOutlineOrSection(options: ShowOptions): void {
  if (options.outline && options.section !== undefined) {
    throw new AgentPlanError("Pass --outline or --section, not both.");
  }
}

export async function showPlan(
  planPath: string,
  options: ShowOptions,
  cwd?: string,
): Promise<string> {
  assertOutlineOrSection(options);

  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);

  const storeDir = await ensureStore(repoRoot, config);

  const links = options.json ? await readRecordedLinks(storeDir) : [];
  const { content, json } = await renderDoc(storeDir, planPath, options, links);
  if (json) console.log(JSON.stringify(json));

  // Reading a doc from a work branch links it to that branch. `show` accepts a
  // path without `.md`, but links are keyed by the real path.
  await linkOnTouch(repoRoot, config, planPath.endsWith(".md") ? planPath : `${planPath}.md`);
  return content;
}

/**
 * Shows every doc linked to a branch, so a session started on the branch can
 * read its plan. Only reads: it never records a link.
 */
export async function showBranchDocs(options: ShowOptions, cwd?: string): Promise<string[]> {
  assertOutlineOrSection(options);
  if (options.at) throw new AgentPlanError("--at can't be combined with --branch.");

  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);
  const storeDir = await ensureStore(repoRoot, config);

  const branch = await branchOrCurrent(
    repoRoot,
    typeof options.branch === "string" ? options.branch : undefined,
  );
  const links = await readRecordedLinks(storeDir);

  const docs: string[] = [];
  for (const doc of currentLinkOfBranch(links, branch)?.docs ?? []) {
    // A doc can be deleted after it was linked.
    if (await fileExists(join(storeDir, doc))) docs.push(doc);
  }
  if (docs.length === 0) {
    throw new AgentPlanError(
      `No docs are linked to branch '${branch}'. Link one with 'apl link <doc>'.`,
    );
  }

  // The raw shortcut prints the file instead of the JSON object.
  const docOptions = options.json ? { ...options, raw: false } : options;
  const results: object[] = [];
  for (const [index, doc] of docs.entries()) {
    if (index > 0 && !options.json) console.log();
    const { json } = await renderDoc(storeDir, doc, docOptions, links);
    if (json) results.push(json);
  }
  if (options.json) console.log(JSON.stringify({ branch, docs: results }));
  return docs;
}

function printMetaHeader(meta: PlanMeta, typeName: string | undefined): void {
  const lines: string[] = [];

  if (typeName) lines.push(`${colors.bold("Type:")}    ${typeName}`);
  if (meta.title) lines.push(`${colors.bold("Title:")}   ${meta.title}`);
  if (meta.status) lines.push(`${colors.bold("Status:")}  ${meta.status}`);
  if (meta.tags?.length) lines.push(`${colors.bold("Tags:")}    ${meta.tags.join(", ")}`);
  if (meta.created) lines.push(`${colors.bold("Created:")} ${meta.created}`);
  if (meta.updated) lines.push(`${colors.bold("Updated:")} ${meta.updated}`);

  if (lines.length > 0) {
    console.log(colors.dim("─".repeat(40)));
    for (const line of lines) console.log(line);
    console.log(colors.dim("─".repeat(40)));
  }
}

export function registerShow(program: Command): void {
  program
    .command("show [path]")
    .description("Show the contents of a doc, or of every doc linked to a branch")
    .option("--at <ref>", "Show the file as of a commit ref")
    .option(
      "--branch [name]",
      "Show every doc linked to this branch (the current branch when no name) instead of a path",
    )
    .option("--json", "Output in JSON format")
    .option("--raw", "Print the file as-is, without the metadata header")
    .option("--outline", "List the doc's headings with their line numbers")
    .option("--section <heading>", "Print only the sections whose heading contains this text")
    .action(async (planPath: string | undefined, options: ShowOptions) => {
      if (planPath !== undefined && options.branch !== undefined) {
        throw new AgentPlanError("Pass a doc path or --branch, not both.");
      }
      if (options.branch !== undefined) {
        await showBranchDocs(options);
      } else if (planPath === undefined) {
        throw new AgentPlanError(
          "Pass a doc path, or --branch to show the docs linked to a branch.",
        );
      } else {
        await showPlan(planPath, options);
      }
    });
}
