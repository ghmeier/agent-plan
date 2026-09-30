import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { execGit } from "../lib/git";
import { info } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { ensureStore } from "../lib/worktree";

export interface LogEntry {
  hash: string;
  message: string;
  date: string;
  author: string;
}

const DEFAULT_LIMIT = 20;

const LOG_FIELD_SEP = "\x1f";
const LOG_RECORD_SEP = "\x1e";

async function getLogFromWorktree(
  storeDir: string,
  file?: string,
  limit?: number,
): Promise<LogEntry[]> {
  const format = `%H${LOG_FIELD_SEP}%s${LOG_FIELD_SEP}%aI${LOG_FIELD_SEP}%an${LOG_RECORD_SEP}`;
  const args = ["log", `--pretty=format:${format}`];
  if (limit !== undefined) args.push("-n", String(limit));
  if (file) args.push("--", file);

  const stdout = await execGit(args, storeDir);

  return stdout
    .split(LOG_RECORD_SEP)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const parts = record.split(LOG_FIELD_SEP);
      return {
        hash: parts[0] ?? "",
        message: parts[1] ?? "",
        date: parts[2] ?? "",
        author: parts[3] ?? "",
      };
    });
}

export async function getPlanLog(
  file?: string,
  limit: number = DEFAULT_LIMIT,
  cwd?: string,
  options: { json?: boolean } = {},
): Promise<LogEntry[]> {
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);

  const storeDir = await ensureStore(repoRoot, config);

  const entries = await getLogFromWorktree(storeDir, file, limit);

  if (options.json) {
    console.log(JSON.stringify({ entries }));
  }

  return entries;
}

function formatLogEntry(entry: LogEntry): string {
  return `${entry.hash.slice(0, 7)} ${entry.date} ${entry.message}`;
}

export function registerLog(program: Command): void {
  program
    .command("log [file]")
    .description("Show the commit history of the docs branch")
    .option("-n, --limit <number>", "Limit number of entries", String(DEFAULT_LIMIT))
    .option("--json", "Output in JSON format")
    .action(async (file: string | undefined, options: { limit: string; json?: boolean }) => {
      const limit = Number.parseInt(options.limit, 10);
      const entries = await getPlanLog(file, limit, undefined, options);
      if (!options.json) {
        if (entries.length === 0) {
          info("No history found");
        } else {
          for (const entry of entries) {
            console.log(formatLogEntry(entry));
          }
        }
      }
    });
}
