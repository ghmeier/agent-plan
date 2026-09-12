import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { GitPlumbing } from "../lib/git";
import { findRepoRoot } from "../lib/paths";

export async function listPlans(
  path?: string,
  cwd?: string,
  options: { json?: boolean } = {},
): Promise<string[]> {
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);
  const git = new GitPlumbing(repoRoot, config.branch);

  if (!(await git.branchExists())) {
    throw new Error(`No plans branch found. Run "plan init" first.`);
  }

  const files = await git.listFiles(path);

  if (options.json) {
    console.log(JSON.stringify({ files }));
  }

  return files;
}

export function registerLs(program: Command): void {
  program
    .command("ls [path]")
    .description("List stored plans")
    .option("--json", "Output in JSON format")
    .action(async (path: string | undefined, options: { json?: boolean }) => {
      try {
        const files = await listPlans(path, undefined, options);
        if (!options.json) {
          for (const file of files) {
            console.log(file);
          }
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
