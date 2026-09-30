import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import {
  BUILTIN_TYPES,
  DEFAULT_STATUSES,
  type DocType,
  parseStoreConfig,
  readDocTypes,
  STORE_CONFIG_FILE,
} from "../lib/doc-types";
import { parseFrontmatter } from "../lib/frontmatter";
import { runGit } from "../lib/git";
import { findRepoRoot, getGitCommonDir, getStoreDir } from "../lib/paths";
import { isDocPath, listMarkdownFiles } from "../lib/plan-files";

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

/** True when the store exists and is readable, checked without triggering its creation. */
async function storeReady(storeDir: string): Promise<boolean> {
  try {
    await readdir(storeDir);
    return true;
  } catch {
    return false;
  }
}

async function gitSpawn(
  repoRoot: string,
  args: string[],
): Promise<{ stdout: string; ok: boolean }> {
  const { stdout, exitCode } = await runGit(args, repoRoot);
  return { stdout, ok: exitCode === 0 };
}

async function completeFiles(prefix: string, cwd?: string): Promise<void> {
  const repoRoot = await safeRepoRoot(cwd);
  if (!repoRoot) return;

  const config = await safeConfig(repoRoot);
  if (!config) return;

  const storeDir = getStoreDir(await getGitCommonDir(repoRoot));
  let files: string[];

  if (await storeReady(storeDir)) {
    files = await listMarkdownFiles(storeDir);
  } else {
    const { stdout, ok } = await gitSpawn(repoRoot, [
      "ls-tree",
      "-r",
      "--name-only",
      config.branch,
    ]);
    if (!ok) return;
    files = stdout.split("\n").filter(isDocPath).sort();
  }

  for (const f of files) {
    if (!prefix || f.startsWith(prefix)) console.log(f);
  }
}

async function readTagsFromWorktree(storeDir: string): Promise<Set<string>> {
  const tags = new Set<string>();
  const files = await listMarkdownFiles(storeDir);
  for (const f of files) {
    try {
      const content = await Bun.file(join(storeDir, f)).text();
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

  const files = stdout.split("\n").filter(isDocPath);
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

  const storeDir = getStoreDir(await getGitCommonDir(repoRoot));
  const tags = (await storeReady(storeDir))
    ? await readTagsFromWorktree(storeDir)
    : await readTagsFromBranch(repoRoot, config.branch);

  for (const tag of [...tags].sort()) console.log(tag);
}

/** Doc types from the store, or from the docs branch when no store exists yet. */
async function loadTypes(cwd?: string): Promise<DocType[]> {
  const repoRoot = await safeRepoRoot(cwd);
  if (!repoRoot) return BUILTIN_TYPES;

  const storeDir = getStoreDir(await getGitCommonDir(repoRoot));
  if (await storeReady(storeDir)) return readDocTypes(storeDir);

  const config = await safeConfig(repoRoot);
  if (!config) return BUILTIN_TYPES;
  const { stdout, ok } = await gitSpawn(repoRoot, [
    "show",
    `${config.branch}:${STORE_CONFIG_FILE}`,
  ]);
  return ok ? parseStoreConfig(stdout, STORE_CONFIG_FILE) : BUILTIN_TYPES;
}

async function completeTypes(cwd?: string): Promise<void> {
  for (const type of await loadTypes(cwd)) console.log(type.name);
}

/** Statuses for one type, or for all types plus untyped docs when no type is given. */
async function completeStatuses(typeName?: string, cwd?: string): Promise<void> {
  const types = await loadTypes(cwd);
  const statuses = typeName
    ? (types.find((t) => t.name === typeName)?.statuses ?? [])
    : new Set([...DEFAULT_STATUSES, ...types.flatMap((t) => t.statuses)]);
  for (const status of statuses) console.log(status);
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
        await completeStatuses(arg, opts.cwd);
        break;
      case "types":
        await completeTypes(opts.cwd);
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
