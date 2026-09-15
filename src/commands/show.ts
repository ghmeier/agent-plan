import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { FileNotFoundError, NotInitializedError } from "../lib/errors";
import { type PlanMeta, parseFrontmatter } from "../lib/frontmatter";
import { GitPlumbing } from "../lib/git";
import { colors } from "../lib/output";
import { findRepoRoot } from "../lib/paths";

export async function showPlan(
  path: string,
  options: { version?: string; json?: boolean; raw?: boolean },
  cwd?: string,
): Promise<string> {
  const repoRoot = await findRepoRoot(cwd);
  const config = await readConfig(repoRoot);
  const git = new GitPlumbing(repoRoot, config.branch);

  if (!(await git.branchExists())) {
    throw new NotInitializedError();
  }

  let content: string;
  try {
    content = options.version
      ? await git.exec(["show", `${options.version}:${path}`])
      : await git.readFile(path);
  } catch {
    throw new FileNotFoundError(path);
  }

  if (options.json) {
    const { meta, content: body } = parseFrontmatter(content);
    console.log(JSON.stringify({ path, content, meta, body }));
    return content;
  }

  if (options.raw) {
    process.stdout.write(content);
    return content;
  }

  // Default: print a header block then the body (without the frontmatter fence).
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
    .description("Show the contents of a stored plan")
    .option("--version <ref>", "Show a historical version by commit hash")
    .option("--json", "Output in JSON format")
    .option("--raw", "Print the file as-is, without the metadata header")
    .action(async (path: string, options: { version?: string; json?: boolean; raw?: boolean }) => {
      await showPlan(path, options);
    });
}
