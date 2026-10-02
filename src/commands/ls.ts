import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { findType, readDocTypes, typeOf, withValidStatus } from "../lib/doc-types";
import { type PlanMeta, parseFrontmatter } from "../lib/frontmatter";
import { colors, info } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { listMarkdownFiles } from "../lib/plan-files";
import { ensureStore } from "../lib/worktree";

export interface LsOptions {
  json?: boolean;
  short?: boolean;
  status?: string;
  tag?: string;
  type?: string;
}

export interface PlanEntry {
  file: string;
  type: string | null;
  meta: PlanMeta;
}

function lastUpdated(entry: PlanEntry): string | undefined {
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
      const raw = await Bun.file(join(storeDir, file)).text();
      const meta = withValidStatus(parseFrontmatter(raw).meta, type, file);
      return { file, type: type?.name ?? null, meta };
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
  const filtered = await findDocs(storeDir, { ...options, path });

  const files = filtered.map((e) => e.file);

  if (options.json) {
    const jsonEntries = filtered.map((e) => ({ file: e.file, type: e.type, meta: e.meta }));
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

  printTable(filtered);
  return files;
}

function printTable(entries: PlanEntry[]): void {
  const headers = ["FILE", "TYPE", "TITLE", "STATUS", "UPDATED", "TAGS"];

  const rows = entries.map((e) => [
    e.file,
    e.type ?? "",
    e.meta.title ?? "",
    e.meta.status ?? "",
    lastUpdated(e) ?? "",
    e.meta.tags?.join(", ") ?? "",
  ]);

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));

  function pad(s: string, w: number): string {
    return s.padEnd(w);
  }

  const headerLine = headers.map((h, i) => colors.bold(pad(h, widths[i] ?? h.length))).join("  ");
  console.log(headerLine);

  for (const row of rows) {
    const line = row.map((cell, i) => pad(cell, widths[i] ?? cell.length)).join("  ");
    console.log(line);
  }
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
    .action(async (path: string | undefined, options: LsOptions) => {
      await listPlans(path, undefined, options);
    });
}
