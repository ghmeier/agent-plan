import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { GitPlumbing } from "../lib/git";
import { findRepoRoot } from "../lib/paths";

export async function showPlan(
  path: string,
  options: { version?: string; json?: boolean },
  cwd?: string,
): Promise<string> {
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);
  const git = new GitPlumbing(repoRoot, config.branch);

  if (!(await git.branchExists())) {
    throw new Error(`No plans branch found. Run "plan init" first.`);
  }

  let content: string;
  try {
    content = options.version
      ? await git.exec(["show", `${options.version}:${path}`])
      : await git.readFile(path);
  } catch {
    throw new Error(`Plan file not found: ${path}`);
  }

  if (options.json) {
    console.log(JSON.stringify({ path, content }));
  }

  return content;
}

export function registerShow(program: Command): void {
  program
    .command("show <path>")
    .description("Show the contents of a stored plan")
    .option("--version <ref>", "Show a historical version by commit hash")
    .option("--json", "Output in JSON format")
    .action(async (path: string, options: { version?: string; json?: boolean }) => {
      try {
        const content = await showPlan(path, options);
        if (!options.json) {
          process.stdout.write(content);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
