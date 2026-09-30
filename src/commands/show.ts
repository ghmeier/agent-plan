import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { readDocTypes, typeOf, withValidStatus } from "../lib/doc-types";
import { AgentPlanError, FileNotFoundError } from "../lib/errors";
import { type PlanMeta, parseFrontmatter } from "../lib/frontmatter";
import { runGit } from "../lib/git";
import { colors } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { ensureStore } from "../lib/worktree";

async function readFromHistory(storeDir: string, ref: string, planPath: string): Promise<string> {
  if (
    (await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], storeDir)).exitCode !== 0
  ) {
    throw new AgentPlanError(`Unknown revision: ${ref}`);
  }

  const { exitCode, stdout, stderr } = await runGit(["show", `${ref}:${planPath}`], storeDir);
  if (exitCode === 0) return stdout;
  if (stderr.includes("does not exist") || stderr.includes("exists on disk, but not in")) {
    throw new FileNotFoundError(`${planPath} at ${ref}`);
  }
  throw new Error(`git show ${ref}:${planPath} failed: ${stderr.trim()}`);
}

async function readFromWorktree(storeDir: string, planPath: string): Promise<string> {
  const file = Bun.file(join(storeDir, planPath));
  if (!(await file.exists())) throw new FileNotFoundError(planPath);
  return file.text();
}

export async function showPlan(
  planPath: string,
  options: { at?: string; json?: boolean; raw?: boolean },
  cwd?: string,
): Promise<string> {
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);

  const storeDir = await ensureStore(repoRoot, config);

  const content = options.at
    ? await readFromHistory(storeDir, options.at, planPath)
    : await readFromWorktree(storeDir, planPath);

  if (options.raw) {
    process.stdout.write(content);
    return content;
  }

  const type = typeOf(planPath, await readDocTypes(storeDir));
  const parsed = parseFrontmatter(content);
  const meta = withValidStatus(parsed.meta, type, planPath);
  const body = parsed.content;

  if (options.json) {
    console.log(JSON.stringify({ path: planPath, type: type?.name ?? null, content, meta, body }));
    return content;
  }

  if (parsed.hasFrontmatter) {
    printMetaHeader(meta, type?.name);
    process.stdout.write(body);
  } else {
    process.stdout.write(content);
  }

  return content;
}

function printMetaHeader(meta: PlanMeta, typeName: string | undefined): void {
  const lines: string[] = [];

  if (typeName) lines.push(`${colors.bold("Type:")}    ${typeName}`);
  if (meta.title) lines.push(`${colors.bold("Title:")}   ${meta.title}`);
  if (meta.status) lines.push(`${colors.bold("Status:")}  ${meta.status}`);
  if (meta.tags?.length) lines.push(`${colors.bold("Tags:")}    ${meta.tags.join(", ")}`);
  if (meta.created) lines.push(`${colors.bold("Created:")} ${meta.created}`);
  if (meta.updated) lines.push(`${colors.bold("Updated:")} ${meta.updated}`);

  if (lines.length > 0) {
    console.log(colors.dim("─".repeat(40)));
    for (const line of lines) console.log(line);
    console.log(colors.dim("─".repeat(40)));
  }
}

export function registerShow(program: Command): void {
  program
    .command("show <path>")
    .description("Show the contents of a doc")
    .option("--at <ref>", "Show the file as of a commit ref")
    .option("--json", "Output in JSON format")
    .option("--raw", "Print the file as-is, without the metadata header")
    .action(async (planPath: string, options: { at?: string; json?: boolean; raw?: boolean }) => {
      await showPlan(planPath, options);
    });
}
