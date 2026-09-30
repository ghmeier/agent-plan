import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { execGit, runGit } from "../lib/git";
import { findRepoRoot, getPlansDir } from "../lib/paths";
import { ensurePlansWorktree } from "../lib/worktree";

/** git diff exits 0 (no diff) or 1 (diff found); anything else is a real error. */
async function runDiff(args: string[], plansDir: string): Promise<string> {
  const { exitCode, stdout, stderr } = await runGit(["diff", ...args], plansDir);
  if (exitCode > 1) {
    throw new Error(`git diff ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/** Diffs tracked files against HEAD, plus new files that `git diff` alone would leave out. */
async function gitDiff(plansDir: string, planPath?: string): Promise<string> {
  const pathspec = planPath ? ["--", planPath] : [];
  const tracked = await runDiff(["HEAD", ...pathspec], plansDir);

  const untrackedList = await execGit(
    ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec],
    plansDir,
  );
  const untracked = await Promise.all(
    untrackedList
      .split("\0")
      .filter(Boolean)
      .map((file) => runDiff(["--no-index", "--", "/dev/null", file], plansDir)),
  );

  return tracked + untracked.join("");
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
