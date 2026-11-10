import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { findType, readDocTypes, typeOf, withValidStatus } from "../lib/doc-types";
import { AgentPlanError } from "../lib/errors";
import { type PlanMeta, parseFrontmatter } from "../lib/frontmatter";
import { linksOfDoc, readRecordedLinks } from "../lib/links";
import { colors, hint, info } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { listMarkdownFiles } from "../lib/plan-files";
import { ensureStore } from "../lib/worktree";

export interface LsOptions {
  branch?: string;
  json?: boolean;
  limit?: number;
  short?: boolean;
  status?: string;
  tag?: string;
  type?: string;
}

export interface PlanEntry {
  file: string;
  type: string | null;
  meta: PlanMeta;
  /** The whole file as stored, frontmatter included. */
  content: string;
}

export function lastUpdated(entry: PlanEntry): string | undefined {
  return entry.meta.updated ?? entry.meta.created;
}

/** Newest first, so the doc someone is most likely looking for is at the top. Undated docs go last. */
function byMostRecentlyUpdated(a: PlanEntry, b: PlanEntry): number {
  const [dateA, dateB] = [lastUpdated(a) ?? "", lastUpdated(b) ?? ""];
  if (dateA !== dateB) return dateA < dateB ? 1 : -1;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

export interface DocFilters {
  path?: string;
  status?: string;
  tag?: string;
  type?: string;
}

/** Docs in the store matching every given filter, most recently updated first. */
export async function findDocs(storeDir: string, filters: DocFilters = {}): Promise<PlanEntry[]> {
  const types = await readDocTypes(storeDir);
  const typeFilter = filters.type ? findType(types, filters.type) : null;

  const searchDir = filters.path ? join(storeDir, filters.path) : storeDir;
  const allFiles = await listMarkdownFiles(searchDir, storeDir);

  const entries: PlanEntry[] = await Promise.all(
    allFiles.map(async (file) => {
      const type = typeOf(file, types);
      const content = await Bun.file(join(storeDir, file)).text();
      const meta = withValidStatus(parseFrontmatter(content).meta, type, file);
      return { file, type: type?.name ?? null, meta, content };
    }),
  );

  return entries.sort(byMostRecentlyUpdated).filter((entry) => {
    if (typeFilter && entry.type !== typeFilter.name) return false;
    if (filters.status && entry.meta.status !== filters.status) return false;
    if (filters.tag && !entry.meta.tags?.includes(filters.tag)) return false;
    return true;
  });
}

export async function listPlans(
  path?: string,
  cwd?: string,
  options: LsOptions = {},
): Promise<string[]> {
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);
  const storeDir = await ensureStore(repoRoot, config);
  // Links are read once, whatever the number of docs. Listing never records any.
  const links = options.json || options.branch ? await readRecordedLinks(storeDir) : [];
  const linkedToBranch = options.branch
    ? new Set(links.filter((link) => link.branch === options.branch).flatMap((link) => link.docs))
    : null;
  const matching = (await findDocs(storeDir, { ...options, path })).filter(
    (entry) => !linkedToBranch || linkedToBranch.has(entry.file),
  );
  const filtered = matching.slice(0, options.limit);
  if (!options.json) warnIfLimited(filtered.length, matching.length);

  const files = filtered.map((e) => e.file);

  if (options.json) {
    const jsonEntries = filtered.map((e) => ({
      file: e.file,
      type: e.type,
      meta: e.meta,
      links: linksOfDoc(links, e.file),
    }));
    console.log(JSON.stringify({ files: jsonEntries }));
    return files;
  }

  if (options.short) {
    if (files.length === 0) {
      info("No files found");
    } else {
      for (const file of files) {
        console.log(file);
      }
    }
    return files;
  }

  if (filtered.length === 0) {
    info("No files found");
    return files;
  }

  printDocTable(filtered);
  return files;
}

/** Tells a reader that output was cut off, on stderr so piped results stay clean. */
export function warnIfLimited(shown: number, total: number): void {
  if (shown < total) {
    hint(`Showing ${shown} of ${total} matching docs. Pass --limit ${total} to see them all.`);
  }
}

/**
 * Prints one row per doc, with any detail lines for a row printed beneath it.
 * A terminal gets an aligned table. Anything else, usually an agent or a
 * script, gets tab-separated rows, because padding every column to its longest
 * value made the output twice as large without making it easier to parse.
 */
export function printDocTable<T extends PlanEntry>(
  entries: T[],
  detailLines: (entry: T) => string[] = () => [],
): void {
  const headers = ["FILE", "TYPE", "TITLE", "STATUS", "UPDATED", "TAGS"];

  const rows = entries.map((e) => [
    e.file,
    e.type ?? "",
    e.meta.title ?? "",
    e.meta.status ?? "",
    lastUpdated(e) ?? "",
    e.meta.tags?.join(", ") ?? "",
  ]);

  if (process.stdout.isTTY !== true) {
    console.log(headers.join("\t"));
    rows.forEach((row, i) => {
      console.log(row.join("\t"));
      for (const line of detailLines(entries[i] as T)) console.log(line);
    });
    return;
  }

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const pad = (s: string, i: number) => s.padEnd(widths[i] ?? s.length);

  console.log(headers.map((h, i) => colors.bold(pad(h, i))).join("  "));
  rows.forEach((row, i) => {
    console.log(row.map(pad).join("  ").trimEnd());
    for (const line of detailLines(entries[i] as T)) console.log(colors.dim(line));
  });
}

/** Parses a `--limit` value, which must be a positive whole number. */
export function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AgentPlanError(`--limit must be a positive whole number, got "${value}".`);
  }
  return limit;
}

export function registerLs(program: Command): void {
  program
    .command("ls [path]")
    .alias("list")
    .description("List docs in .apl/")
    .option("--json", "Output in JSON format")
    .option("--short", "Filename-only output (one per line)")
    .option("--type <type>", "Filter by doc type (see 'apl types')")
    .option("--status <status>", "Filter by status")
    .option("--tag <tag>", "Filter by tag")
    .option("--branch <name>", "Only docs linked to this branch")
    .option("--limit <n>", "Show at most this many docs", parseLimit)
    .action(async (path: string | undefined, options: LsOptions) => {
      await listPlans(path, undefined, options);
    });
}
