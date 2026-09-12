import path from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { FileNotFoundError, NotInitializedError } from "../lib/errors";
import { GitPlumbing } from "../lib/git";
import { findRepoRoot, resolvePlanPath } from "../lib/paths";

export async function diffPlan(
  file: string,
  cwd?: string,
  options: { json?: boolean } = {},
): Promise<string> {
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);
  const git = new GitPlumbing(repoRoot, config.branch);

  if (!(await git.branchExists())) {
    throw new NotInitializedError();
  }

  const absoluteFilePath = path.resolve(cwd ?? process.cwd(), file);
  const planPath = resolvePlanPath(repoRoot, absoluteFilePath);

  let diffOutput: string;
  try {
    diffOutput = await git.diff(planPath, absoluteFilePath);
  } catch {
    throw new FileNotFoundError(planPath);
  }

  if (options.json) {
    console.log(
      JSON.stringify({ path: planPath, changed: diffOutput.length > 0, diff: diffOutput }),
    );
  }

  return diffOutput;
}

export function registerDiff(program: Command): void {
  program
    .command("diff <file>")
    .description("Show differences between stored plan versions")
    .option("--json", "Output in JSON format")
    .action(async (file: string, options: { json?: boolean }) => {
      const diffOutput = await diffPlan(file, undefined, options);
      if (!options.json) {
        console.log(diffOutput.length > 0 ? diffOutput : "No changes");
      }
    });
}
