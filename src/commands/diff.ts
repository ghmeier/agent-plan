import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { findRepoRoot, getPlansDir } from "../lib/paths";
import { ensurePlansWorktree } from "../lib/worktree";

async function gitDiff(plansDir: string, planPath?: string): Promise<string> {
  const args = ["diff", "HEAD"];
  if (planPath) args.push("--", planPath);

  const proc = Bun.spawn(["git", ...args], {
    cwd: plansDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // git diff exits 0 (no diff) or 1 (diff found); anything else is a real error.
  if (exitCode > 1) {
    throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  return stdout;
}

export async function diffPlan(
  file?: string,
  cwd?: string,
  options: { json?: boolean } = {},
): Promise<string> {
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);

  await ensurePlansWorktree(repoRoot, config);

  const plansDir = getPlansDir(repoRoot);
  const diffOutput = await gitDiff(plansDir, file);

  if (options.json) {
    console.log(
      JSON.stringify({ path: file ?? null, changed: diffOutput.length > 0, diff: diffOutput }),
    );
  }

  return diffOutput;
}

export function registerDiff(program: Command): void {
  program
    .command("diff [file]")
    .description("Show uncommitted changes in .plans/ against HEAD")
    .option("--json", "Output in JSON format")
    .action(async (file: string | undefined, options: { json?: boolean }) => {
      const diffOutput = await diffPlan(file, undefined, options);
      if (!options.json) {
        console.log(diffOutput.length > 0 ? diffOutput : "No changes");
      }
    });
}
