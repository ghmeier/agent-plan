import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { FileNotFoundError, NotInitializedError } from "../lib/errors";
import { stampTimestamps } from "../lib/frontmatter";
import { GitPlumbing } from "../lib/git";
import { success } from "../lib/output";
import { findRepoRoot, getPlansDir, resolvePlanPath } from "../lib/paths";
import { ensurePlansWorktree } from "../lib/worktree";

export interface AddOptions {
  message?: string;
  cwd?: string;
}

async function runGit(args: string[], cwd: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr };
}

/**
 * Copies one or more files into `.plans/` at their repo-relative paths,
 * stamps frontmatter timestamps, then commits from inside the worktree.
 */
export async function addPlans(files: string[], options: AddOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);
  const git = new GitPlumbing(repoRoot, config.branch);

  if (!(await git.branchExists())) {
    throw new NotInitializedError();
  }

  await ensurePlansWorktree(repoRoot, config);

  const plansDir = getPlansDir(repoRoot);
  const resolved: { planPath: string; destPath: string }[] = [];

  for (const file of files) {
    const absolutePath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    const diskFile = Bun.file(absolutePath);

    if (!(await diskFile.exists())) {
      throw new FileNotFoundError(file);
    }

    const rawContent = await diskFile.text();
    const content = stampTimestamps(rawContent);
    const planPath = resolvePlanPath(repoRoot, absolutePath);
    const destPath = path.join(plansDir, planPath);

    await mkdir(path.dirname(destPath), { recursive: true });
    await Bun.write(destPath, content);
    resolved.push({ planPath, destPath });
  }

  // Stage only the files we just wrote, then commit.
  const relPaths = resolved.map((f) => f.planPath);
  const { exitCode: addCode, stderr: addErr } = await runGit(["add", "--", ...relPaths], plansDir);
  if (addCode !== 0) throw new Error(`git add failed: ${addErr.trim()}`);

  const message = options.message ?? `Add ${relPaths.join(", ")}`;
  const { exitCode: commitCode, stderr: commitErr } = await runGit(
    ["commit", "-m", message],
    plansDir,
  );
  if (commitCode !== 0) throw new Error(`git commit failed: ${commitErr.trim()}`);

  success(`Added ${resolved.length} file(s) to plans`);
  for (const f of resolved) {
    console.log(`  ${f.planPath}`);
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
