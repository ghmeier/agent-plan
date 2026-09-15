import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { info, success } from "../lib/output";
import { findRepoRoot, getPlansDir } from "../lib/paths";

const PLACEHOLDER_MESSAGE =
  "Nothing to commit. Use 'apl add <file>' to add files to plans.\n" +
  "In worktree mode, 'apl commit' commits all changes in .plans/";

async function run(args: string[], cwd: string): Promise<{ exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  return { exitCode };
}

export async function commitPlans(options: { message?: string; cwd?: string } = {}): Promise<void> {
  const repoRoot = await findRepoRoot(options.cwd);
  const config = await readConfig(repoRoot);

  if (!config.worktree) {
    info(PLACEHOLDER_MESSAGE);
    return;
  }

  const plansDir = getPlansDir(repoRoot);

  await run(["add", "-A"], plansDir);

  const { exitCode: diffExitCode } = await run(["diff", "--cached", "--quiet"], plansDir);
  if (diffExitCode === 0) {
    info("Nothing to commit");
    return;
  }

  const message = options.message ?? "Update plans";
  await run(["commit", "-m", message], plansDir);

  success("Committed plan changes");
}

export function registerCommit(program: Command): void {
  program
    .command("commit")
    .description("Commit staged plan changes")
    .option("-m, --message <msg>", "Commit message")
    .action(async (opts) => {
      await commitPlans(opts);
    });
}
