import path from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
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
    throw new Error(`No plans branch found. Run "plan init" first.`);
  }

  const absoluteFilePath = path.resolve(cwd ?? process.cwd(), file);
  const planPath = resolvePlanPath(repoRoot, absoluteFilePath);

  let diffOutput: string;
  try {
    diffOutput = await git.diff(planPath, absoluteFilePath);
  } catch {
    throw new Error(`Plan file not found on plans branch: ${planPath}`);
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
      try {
        const diffOutput = await diffPlan(file, undefined, options);
        if (!options.json) {
          console.log(diffOutput.length > 0 ? diffOutput : "No changes");
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
