import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { stampTimestamps } from "../lib/frontmatter";
import { info, success } from "../lib/output";
import { findRepoRoot, getPlansDir } from "../lib/paths";

const PLACEHOLDER_MESSAGE =
  "Nothing to commit. Use 'apl add <file>' to add files to plans.\n" +
  "In worktree mode, 'apl commit' commits all changes in .plans/";

async function run(args: string[], cwd: string): Promise<{ exitCode: number; stdout?: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, stdout };
}

/**
 * For each modified markdown file in the plans worktree that already has
 * frontmatter, rewrite the file with an updated `updated` timestamp so
 * agents that edit files directly still get timestamp tracking.
 */
async function stampChangedFiles(plansDir: string): Promise<void> {
  const { stdout } = await run(["status", "--porcelain"], plansDir);
  const lines = (stdout ?? "").split("\n").filter((l) => l.length > 0);

  for (const line of lines) {
    // Columns 0-1 are the XY status; column 2 is a space; path follows.
    const filePath = line.slice(3).trim();
    if (!filePath.endsWith(".md")) continue;

    const fullPath = join(plansDir, filePath);
    const file = Bun.file(fullPath);
    if (!(await file.exists())) continue;

    const raw = await file.text();
    const stamped = stampTimestamps(raw);
    if (stamped !== raw) {
      await Bun.write(fullPath, stamped);
    }
  }
}

export async function commitPlans(options: { message?: string; cwd?: string } = {}): Promise<void> {
  const repoRoot = await findRepoRoot(options.cwd);
  const config = await readConfig(repoRoot);

  if (!config.worktree) {
    info(PLACEHOLDER_MESSAGE);
    return;
  }

  const plansDir = getPlansDir(repoRoot);

  await stampChangedFiles(plansDir);

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
