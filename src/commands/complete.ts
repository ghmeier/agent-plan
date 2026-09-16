import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { parseFrontmatter } from "../lib/frontmatter";
import { findRepoRoot, getPlansDir } from "../lib/paths";
import { listMarkdownFiles } from "../lib/plan-files";

const STATUSES = ["draft", "active", "completed", "archived"];

async function safeRepoRoot(cwd?: string): Promise<string | null> {
  try {
    return await findRepoRoot(cwd);
  } catch {
    return null;
  }
}

async function safeConfig(repoRoot: string): Promise<{ branch: string; remote: string } | null> {
  try {
    return await readConfig(repoRoot);
  } catch {
    return null;
  }
}

/** True when .plans/ exists and is readable as a directory without triggering worktree creation. */
async function plansDirReady(plansDir: string): Promise<boolean> {
  try {
    await readdir(plansDir);
    return true;
  } catch {
    return false;
  }
}

async function gitSpawn(
  repoRoot: string,
  args: string[],
): Promise<{ stdout: string; ok: boolean }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, ok: exitCode === 0 };
}

async function completeFiles(prefix: string, cwd?: string): Promise<void> {
  const repoRoot = await safeRepoRoot(cwd);
  if (!repoRoot) return;

  const config = await safeConfig(repoRoot);
  if (!config) return;

  const plansDir = getPlansDir(repoRoot);
  let files: string[];

  if (await plansDirReady(plansDir)) {
    files = await listMarkdownFiles(plansDir);
  } else {
    const { stdout, ok } = await gitSpawn(repoRoot, [
      "ls-tree",
      "-r",
      "--name-only",
      config.branch,
    ]);
    if (!ok) return;
    files = stdout
      .split("\n")
      .filter((f) => f.endsWith(".md") && f.length > 0)
      .sort();
  }

  for (const f of files) {
    if (!prefix || f.startsWith(prefix)) console.log(f);
  }
}

async function readTagsFromWorktree(plansDir: string): Promise<Set<string>> {
  const tags = new Set<string>();
  const files = await listMarkdownFiles(plansDir);
  for (const f of files) {
    try {
      const content = await Bun.file(join(plansDir, f)).text();
      const { meta } = parseFrontmatter(content);
      for (const tag of meta.tags ?? []) tags.add(tag);
    } catch {
      // skip unreadable files
    }
  }
  return tags;
}

async function readTagsFromBranch(repoRoot: string, branch: string): Promise<Set<string>> {
  const tags = new Set<string>();
  const { stdout, ok } = await gitSpawn(repoRoot, ["ls-tree", "-r", "--name-only", branch]);
  if (!ok) return tags;

  const files = stdout.split("\n").filter((f) => f.endsWith(".md") && f.length > 0);
  for (const f of files) {
    try {
      const { stdout: content, ok: showOk } = await gitSpawn(repoRoot, ["show", `${branch}:${f}`]);
      if (!showOk) continue;
      const { meta } = parseFrontmatter(content);
      for (const tag of meta.tags ?? []) tags.add(tag);
    } catch {
      // skip
    }
  }
  return tags;
}

async function completeTags(cwd?: string): Promise<void> {
  const repoRoot = await safeRepoRoot(cwd);
  if (!repoRoot) return;

  const config = await safeConfig(repoRoot);
  if (!config) return;

  const plansDir = getPlansDir(repoRoot);
  const tags = (await plansDirReady(plansDir))
    ? await readTagsFromWorktree(plansDir)
    : await readTagsFromBranch(repoRoot, config.branch);

  for (const tag of [...tags].sort()) console.log(tag);
}

async function completeStatuses(): Promise<void> {
  for (const s of STATUSES) console.log(s);
}

async function completeVersions(file?: string, cwd?: string): Promise<void> {
  const repoRoot = await safeRepoRoot(cwd);
  if (!repoRoot) return;

  const config = await safeConfig(repoRoot);
  if (!config) return;

  const args = ["log", "--pretty=format:%h", config.branch];
  if (file) args.push("--", file);

  const { stdout, ok } = await gitSpawn(repoRoot, args);
  if (!ok) return;

  for (const line of stdout.split("\n").filter((l) => l.length > 0)) console.log(line);
}

export async function runComplete(
  context: string,
  arg: string | undefined,
  opts: { cwd?: string } = {},
): Promise<void> {
  try {
    switch (context) {
      case "files":
        await completeFiles(arg ?? "", opts.cwd);
        break;
      case "tags":
        await completeTags(opts.cwd);
        break;
      case "statuses":
        await completeStatuses();
        break;
      case "versions":
        await completeVersions(arg, opts.cwd);
        break;
      default:
        break;
    }
  } catch {
    // Never fail — completions are best-effort
  }
}

export function registerComplete(program: Command): void {
  program
    .command("__complete <context> [arg]", { hidden: true })
    .description("Internal completion helper")
    .action(async (context: string, arg?: string) => {
      await runComplete(context, arg);
    });
}
