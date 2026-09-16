import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { type PlanMeta, parseFrontmatter } from "../lib/frontmatter";
import { colors, info } from "../lib/output";
import { findRepoRoot, getPlansDir } from "../lib/paths";
import { listMarkdownFiles } from "../lib/plan-files";
import { ensurePlansWorktree } from "../lib/worktree";

export interface LsOptions {
  json?: boolean;
  short?: boolean;
  status?: string;
  tag?: string;
}

export interface PlanEntry {
  file: string;
  meta: PlanMeta;
}

export async function listPlans(
  path?: string,
  cwd?: string,
  options: LsOptions = {},
): Promise<string[]> {
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);

  await ensurePlansWorktree(repoRoot, config);

  const plansDir = getPlansDir(repoRoot);
  const searchDir = path ? join(plansDir, path) : plansDir;

  const allFiles = await listMarkdownFiles(searchDir, plansDir);

  const entries: PlanEntry[] = await Promise.all(
    allFiles.map(async (file) => {
      const raw = await Bun.file(join(plansDir, file)).text();
      const { meta } = parseFrontmatter(raw);
      return { file, meta };
    }),
  );

  // AND-combine filters: both must match when both are provided.
  const filtered = entries.filter((entry) => {
    if (options.status && entry.meta.status !== options.status) return false;
    if (options.tag && !entry.meta.tags?.includes(options.tag)) return false;
    return true;
  });

  const files = filtered.map((e) => e.file);

  if (options.json) {
    const jsonEntries = filtered.map((e) => ({ file: e.file, meta: e.meta }));
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
  const headers = ["FILE", "TITLE", "STATUS", "TAGS"];

  const rows = entries.map((e) => [
    e.file,
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
    .description("List plan files in .plans/")
    .option("--json", "Output in JSON format")
    .option("--short", "Filename-only output (one per line)")
    .option("--status <status>", "Filter by status (draft, active, completed, archived)")
    .option("--tag <tag>", "Filter by tag")
    .action(
      async (
        path: string | undefined,
        options: { json?: boolean; short?: boolean; status?: string; tag?: string },
      ) => {
        await listPlans(path, undefined, options);
      },
    );
}
