import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { NotInitializedError } from "../lib/errors";
import { type PlanMeta, parseFrontmatter } from "../lib/frontmatter";
import { GitPlumbing } from "../lib/git";
import { colors, info } from "../lib/output";
import { findRepoRoot } from "../lib/paths";

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
  const git = new GitPlumbing(repoRoot, config.branch);

  if (!(await git.branchExists())) {
    throw new NotInitializedError();
  }

  const allFiles = await git.listFiles(path);

  // Build entries with parsed metadata so we can filter and display them.
  const entries: PlanEntry[] = await Promise.all(
    allFiles.map(async (file) => {
      const raw = await git.readFile(file);
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
    // Legacy filename-only output.
    if (files.length === 0) {
      info("No files found");
    } else {
      for (const file of files) {
        console.log(file);
      }
    }
    return files;
  }

  // Default: aligned table.
  if (filtered.length === 0) {
    info("No files found");
    return files;
  }

  printTable(filtered);
  return files;
}

function printTable(entries: PlanEntry[]): void {
  // Column headers.
  const headers = ["FILE", "TITLE", "STATUS", "TAGS"];

  const rows = entries.map((e) => [
    e.file,
    e.meta.title ?? "",
    e.meta.status ?? "",
    e.meta.tags?.join(", ") ?? "",
  ]);

  // Compute column widths as the max of header and all row values.
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));

  function pad(s: string, w: number): string {
    return s.padEnd(w);
  }

  // Header row in bold.
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
    .description("List stored plans")
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
