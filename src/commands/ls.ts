import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { NotInitializedError } from "../lib/errors";
import { GitPlumbing } from "../lib/git";
import { info } from "../lib/output";
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
    throw new NotInitializedError();
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
      const files = await listPlans(path, undefined, options);
      if (!options.json) {
        if (files.length === 0) {
          info("No files found");
        } else {
          for (const file of files) {
            console.log(file);
          }
        }
      }
    });
}
