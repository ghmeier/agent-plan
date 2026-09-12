import path from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { FileNotFoundError, NotInitializedError } from "../lib/errors";
import { GitPlumbing } from "../lib/git";
import { success } from "../lib/output";
import { findRepoRoot, resolvePlanPath } from "../lib/paths";

export interface AddOptions {
  message?: string;
  cwd?: string;
}

/**
 * Reads the given files from disk and writes them to the plans branch in a
 * single commit. Exported separately from the Commander action so it can be
 * exercised directly in tests without going through the CLI.
 */
export async function addPlans(files: string[], options: AddOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);
  const git = new GitPlumbing(repoRoot, config.branch);

  if (!(await git.branchExists())) {
    throw new NotInitializedError();
  }

  const resolved: { path: string; content: string }[] = [];

  for (const file of files) {
    const absolutePath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    const diskFile = Bun.file(absolutePath);

    if (!(await diskFile.exists())) {
      throw new FileNotFoundError(file);
    }

    const content = await diskFile.text();
    const planPath = resolvePlanPath(repoRoot, absolutePath);
    resolved.push({ path: planPath, content });
  }

  const message = options.message ?? `Add ${resolved.map((f) => f.path).join(", ")}`;

  await git.writeFiles(resolved, message);

  success(`Added ${resolved.length} file(s) to plans`);
  for (const file of resolved) {
    console.log(`  ${file.path}`);
  }
}

export function registerAdd(program: Command): void {
  program
    .command("add")
    .description("Add plan file(s) to storage")
    .argument("<file>", "file to add")
    .argument("[files...]", "additional files to add")
    .option("-m, --message <msg>", "custom commit message")
    .action(async (file: string, files: string[], options: { message?: string }) => {
      await addPlans([file, ...files], { message: options.message });
    });
}
