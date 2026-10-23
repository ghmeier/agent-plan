import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { readDocTypes, typeOf, withValidStatus } from "../lib/doc-types";
import { AgentPlanError, FileNotFoundError } from "../lib/errors";
import { type PlanMeta, parseFrontmatter } from "../lib/frontmatter";
import { runGit } from "../lib/git";
import { findHeadings, findSections, type Heading, type Section } from "../lib/headings";
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
  const file = Bun.file(join(storeDir, planPath));
  if (await file.exists()) return file.text();

  const withExtension = Bun.file(join(storeDir, `${planPath}.md`));
  if (!planPath.endsWith(".md") && (await withExtension.exists())) return withExtension.text();

  if ((await stat(join(storeDir, planPath)).catch(() => null))?.isDirectory()) {
    throw new AgentPlanError(
      `${planPath} is a directory. List its docs with 'apl ls ${planPath}'.`,
    );
  }
  throw new FileNotFoundError(planPath);
}

export interface ShowOptions {
  at?: string;
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

export async function showPlan(
  planPath: string,
  options: ShowOptions,
  cwd?: string,
): Promise<string> {
  if (options.outline && options.section !== undefined) {
    throw new AgentPlanError("Pass --outline or --section, not both.");
  }

  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);

  const storeDir = await ensureStore(repoRoot, config);

  const content = options.at
    ? await readFromHistory(storeDir, options.at, planPath)
    : await readFromWorktree(storeDir, planPath);

  if (options.raw && !options.outline && options.section === undefined) {
    process.stdout.write(content);
    return content;
  }

  const type = typeOf(planPath, await readDocTypes(storeDir));
  const parsed = parseFrontmatter(content);
  const meta = withValidStatus(parsed.meta, type, planPath);
  const body = parsed.content;

  if (options.outline) {
    const headings = findHeadings(content);
    if (options.json) {
      console.log(JSON.stringify({ path: planPath, headings }));
      return content;
    }
    if (!options.raw) printMetaHeader(meta, type?.name);
    if (headings.length > 0) console.log(formatOutline(headings));
    return content;
  }

  if (options.section !== undefined) {
    const sections = matchingSections(planPath, content, options.section);
    if (options.json) {
      console.log(JSON.stringify({ path: planPath, sections }));
      return content;
    }
    if (!options.raw) printMetaHeader(meta, type?.name);
    process.stdout.write(sections.map((section) => section.content).join("\n"));
    return content;
  }

  if (options.json) {
    console.log(JSON.stringify({ path: planPath, type: type?.name ?? null, content, meta, body }));
    return content;
  }

  if (parsed.hasFrontmatter) {
    printMetaHeader(meta, type?.name);
    process.stdout.write(body);
  } else {
    process.stdout.write(content);
  }

  return content;
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
    .command("show <path>")
    .description("Show the contents of a doc")
    .option("--at <ref>", "Show the file as of a commit ref")
    .option("--json", "Output in JSON format")
    .option("--raw", "Print the file as-is, without the metadata header")
    .option("--outline", "List the doc's headings with their line numbers")
    .option("--section <heading>", "Print only the sections whose heading contains this text")
    .action(async (planPath: string, options: ShowOptions) => {
      await showPlan(planPath, options);
    });
}
