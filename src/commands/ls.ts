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

export async function listPlans(
  path?: string,
  cwd?: string,
  options: LsOptions = {},
): Promise<string[]> {
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);

  const storeDir = await ensureStore(repoRoot, config);
  const types = await readDocTypes(storeDir);
  const typeFilter = options.type ? findType(types, options.type) : null;

  const searchDir = path ? join(storeDir, path) : storeDir;
  const allFiles = await listMarkdownFiles(searchDir, storeDir);

  const entries: PlanEntry[] = await Promise.all(
    allFiles.map(async (file) => {
      const type = typeOf(file, types);
      const raw = await Bun.file(join(storeDir, file)).text();
      const meta = withValidStatus(parseFrontmatter(raw).meta, type, file);
      return { file, type: type?.name ?? null, meta };
    }),
  );

  // Filters AND-combine: an entry must match every one that's given.
  const filtered = entries.filter((entry) => {
    if (typeFilter && entry.type !== typeFilter.name) return false;
    if (options.status && entry.meta.status !== options.status) return false;
    if (options.tag && !entry.meta.tags?.includes(options.tag)) return false;
    return true;
  });

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
  const headers = ["FILE", "TYPE", "TITLE", "STATUS", "TAGS"];

  const rows = entries.map((e) => [
    e.file,
    e.type ?? "",
    e.meta.title ?? "",
    e.meta.status ?? "",
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
