import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { AgentPlanError } from "../lib/errors";
import { parseFrontmatter } from "../lib/frontmatter";
import { info } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { ensureStore } from "../lib/worktree";
import {
  type DocFilters,
  findDocs,
  type PlanEntry,
  parseLimit,
  printDocTable,
  warnIfLimited,
} from "./ls";

export interface SearchOptions extends DocFilters {
  json?: boolean;
  limit?: number;
}

export interface LineMatch {
  line: number;
  text: string;
}

export interface SearchResult extends PlanEntry {
  matches: LineMatch[];
}

const DEFAULT_LIMIT = 20;
const MATCHES_PER_DOC = 2;
const MAX_LINE_LENGTH = 160;
/** How much text to keep ahead of the first match when a long line has to be cut. */
const LEAD_IN = 40;

function metadataText(entry: PlanEntry): string {
  return [entry.file, entry.meta.title ?? "", ...(entry.meta.tags ?? [])].join("\n").toLowerCase();
}

/**
 * Cuts a line to MAX_LINE_LENGTH, keeping the first match in view. Plans are
 * often written with one paragraph per line, so a match can sit far past
 * where a plain prefix would end.
 */
function excerpt(text: string, terms: string[]): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_LINE_LENGTH) return trimmed;

  const lower = trimmed.toLowerCase();
  const firstMatch = Math.min(
    ...terms.map((t) => lower.indexOf(t)).filter((index) => index >= 0),
    trimmed.length,
  );
  const start = Math.max(0, Math.min(firstMatch - LEAD_IN, trimmed.length - MAX_LINE_LENGTH));
  const end = start + MAX_LINE_LENGTH;
  return `${start > 0 ? "…" : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "…" : ""}`;
}

/** The body lines that best show why a doc matched: those with the most distinct terms, in file order. */
function bestMatchingLines(content: string, body: string, terms: string[]): LineMatch[] {
  const firstBodyLine = content.slice(0, content.length - body.length).split("\n").length;

  const scored = body.split("\n").flatMap((text, index) => {
    const lower = text.toLowerCase();
    const hits = terms.filter((term) => lower.includes(term)).length;
    return hits > 0 ? [{ line: firstBodyLine + index, text, hits }] : [];
  });

  return scored
    .sort((a, b) => b.hits - a.hits || a.line - b.line)
    .slice(0, MATCHES_PER_DOC)
    .sort((a, b) => a.line - b.line)
    .map(({ line, text }) => ({ line, text: excerpt(text, terms) }));
}

/**
 * Docs containing every term, case-insensitively, anywhere in their path,
 * title, tags, or body. Docs whose path, title, and tags alone contain every
 * term rank first; within each rank docs stay most recently updated first.
 */
export async function searchDocs(
  storeDir: string,
  terms: string[],
  filters: DocFilters = {},
): Promise<SearchResult[]> {
  const needles = terms.map((term) => term.toLowerCase());
  const titleMatches: SearchResult[] = [];
  const bodyMatches: SearchResult[] = [];

  for (const entry of await findDocs(storeDir, filters)) {
    const metadata = metadataText(entry);
    const body = parseFrontmatter(entry.content).content;
    const lowerBody = body.toLowerCase();
    if (!needles.every((n) => metadata.includes(n) || lowerBody.includes(n))) continue;

    const result = { ...entry, matches: bestMatchingLines(entry.content, body, needles) };
    if (needles.every((n) => metadata.includes(n))) titleMatches.push(result);
    else bodyMatches.push(result);
  }

  return [...titleMatches, ...bodyMatches];
}

export async function runSearch(
  terms: string[],
  options: SearchOptions,
  cwd?: string,
): Promise<SearchResult[]> {
  if (terms.every((term) => term.trim() === "")) {
    throw new AgentPlanError("Give at least one search term, for example 'apl search billing'.");
  }

  const repoRoot = await findRepoRoot(cwd);
  const storeDir = await ensureStore(repoRoot, await readConfig(repoRoot));
  const all = await searchDocs(
    storeDir,
    terms.filter((term) => term.trim() !== ""),
    options,
  );
  const shown = all.slice(0, options.limit ?? DEFAULT_LIMIT);

  if (options.json) {
    const files = shown.map(({ file, type, meta, matches }) => ({ file, type, meta, matches }));
    console.log(JSON.stringify({ files, total: all.length }));
    return shown;
  }

  if (shown.length === 0) {
    info("No docs match");
    return shown;
  }

  printDocTable(shown, (entry) => entry.matches.map((match) => `  L${match.line}: ${match.text}`));
  warnIfLimited(shown.length, all.length);
  return shown;
}

export function registerSearch(program: Command): void {
  program
    .command("search <terms...>")
    .description("Find docs containing every term in their path, title, tags, or body")
    .option("--path <dir>", "Only search docs under this directory")
    .option("--type <type>", "Filter by doc type (see 'apl types')")
    .option("--status <status>", "Filter by status")
    .option("--tag <tag>", "Filter by tag")
    .option("--limit <n>", `Show at most this many docs (default ${DEFAULT_LIMIT})`, parseLimit)
    .option("--json", "Output in JSON format")
    .action(async (terms: string[], options: SearchOptions) => {
      await runSearch(terms, options);
    });
}
