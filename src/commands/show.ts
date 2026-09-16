import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { FileNotFoundError } from "../lib/errors";
import { type PlanMeta, parseFrontmatter } from "../lib/frontmatter";
import { colors } from "../lib/output";
import { findRepoRoot, getPlansDir } from "../lib/paths";
import { ensurePlansWorktree } from "../lib/worktree";

async function readFromHistory(plansDir: string, ref: string, planPath: string): Promise<string> {
  const proc = Bun.spawn(["git", "show", `${ref}:${planPath}`], {
    cwd: plansDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`No such file at ${ref}`);
  return stdout;
}

export async function showPlan(
  planPath: string,
  options: { version?: string; json?: boolean; raw?: boolean },
  cwd?: string,
): Promise<string> {
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);

  await ensurePlansWorktree(repoRoot, config);

  const plansDir = getPlansDir(repoRoot);

  let content: string;
  try {
    if (options.version) {
      content = await readFromHistory(plansDir, options.version, planPath);
    } else {
      const file = Bun.file(join(plansDir, planPath));
      if (!(await file.exists())) throw new Error("not found");
      content = await file.text();
    }
  } catch {
    throw new FileNotFoundError(planPath);
  }

  if (options.json) {
    const { meta, content: body } = parseFrontmatter(content);
    console.log(JSON.stringify({ path: planPath, content, meta, body }));
    return content;
  }

  if (options.raw) {
    process.stdout.write(content);
    return content;
  }

  const { meta, content: body, hasFrontmatter } = parseFrontmatter(content);

  if (hasFrontmatter) {
    printMetaHeader(meta);
    process.stdout.write(body);
  } else {
    process.stdout.write(content);
  }

  return content;
}

function printMetaHeader(meta: PlanMeta): void {
  const lines: string[] = [];

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
    .description("Show the contents of a plan file")
    .option("--version <ref>", "Show a historical version by commit ref")
    .option("--json", "Output in JSON format")
    .option("--raw", "Print the file as-is, without the metadata header")
    .action(
      async (planPath: string, options: { version?: string; json?: boolean; raw?: boolean }) => {
        await showPlan(planPath, options);
      },
    );
}
