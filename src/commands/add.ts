import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { FileNotFoundError, NotInitializedError } from "../lib/errors";
import { stampTimestamps } from "../lib/frontmatter";
import { branchExists, execGit, runGit } from "../lib/git";
import { info, success } from "../lib/output";
import { findRepoRoot, resolvePlanPath } from "../lib/paths";
import { assertNoOperationInProgress, ensureStore } from "../lib/worktree";

export interface AddOptions {
  message?: string;
  cwd?: string;
}

/**
 * Copies one or more files into `.apl/` at their repo-relative paths,
 * stamps frontmatter timestamps, then commits from inside the worktree.
 */
export async function addPlans(files: string[], options: AddOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);

  if (!(await branchExists(repoRoot, config.branch))) {
    throw new NotInitializedError();
  }

  const storeDir = await ensureStore(repoRoot, config);

  await assertNoOperationInProgress(storeDir);

  const planPaths: string[] = [];

  for (const file of files) {
    const absolutePath = path.resolve(cwd, file);
    const diskFile = Bun.file(absolutePath);

    if (!(await diskFile.exists())) {
      throw new FileNotFoundError(file);
    }

    const planPath = await resolvePlanPath(repoRoot, absolutePath);
    const destPath = path.join(storeDir, planPath);
    const content = stampTimestamps(await diskFile.text());

    await mkdir(path.dirname(destPath), { recursive: true });
    await Bun.write(destPath, content);
    planPaths.push(planPath);
  }

  await execGit(["add", "--", ...planPaths], storeDir);

  const { exitCode: unchanged } = await runGit(
    ["diff", "--cached", "--quiet", "--", ...planPaths],
    storeDir,
  );
  if (unchanged === 0) {
    info("Already up to date; nothing to commit");
    return;
  }

  const message = options.message ?? `Add ${planPaths.join(", ")}`;
  const commit = await runGit(["commit", "-m", message, "--", ...planPaths], storeDir);
  if (commit.exitCode !== 0) {
    // Unstage so a later `apl commit` doesn't sweep these files in under its own message.
    await runGit(["reset", "-q", "--", ...planPaths], storeDir);
    throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  }

  success(`Added ${planPaths.length} file(s) to docs`);
  for (const planPath of planPaths) {
    console.log(`  ${planPath}`);
  }
}

export function registerAdd(program: Command): void {
  program
    .command("add")
    .description("Add file(s) to doc storage")
    .argument("<file>", "file to add")
    .argument("[files...]", "additional files to add")
    .option("-m, --message <msg>", "custom commit message")
    .action(async (file: string, files: string[], options: { message?: string }) => {
      await addPlans([file, ...files], { message: options.message });
    });
}
