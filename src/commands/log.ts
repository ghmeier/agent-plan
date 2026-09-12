import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { GitPlumbing, type LogEntry } from "../lib/git";
import { findRepoRoot } from "../lib/paths";

const DEFAULT_LIMIT = 20;

export async function getPlanLog(
  file?: string,
  limit: number = DEFAULT_LIMIT,
  cwd?: string,
  options: { json?: boolean } = {},
): Promise<LogEntry[]> {
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);
  const git = new GitPlumbing(repoRoot, config.branch);

  if (!(await git.branchExists())) {
    throw new Error(`No plans branch found. Run "plan init" first.`);
  }

  const entries = await git.getLog(file, limit);

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
    .description("Show the history of plan changes")
    .option("-n, --limit <number>", "Limit number of entries", String(DEFAULT_LIMIT))
    .option("--json", "Output in JSON format")
    .action(async (file: string | undefined, options: { limit: string; json?: boolean }) => {
      try {
        const limit = Number.parseInt(options.limit, 10);
        const entries = await getPlanLog(file, limit, undefined, options);
        if (!options.json) {
          for (const entry of entries) {
            console.log(formatLogEntry(entry));
          }
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
