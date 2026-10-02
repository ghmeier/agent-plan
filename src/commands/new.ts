import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import {
  findType,
  readDocTypes,
  renderTemplate,
  resolveTemplate,
  yamlFlowList,
} from "../lib/doc-types";
import { AgentPlanError, FileExistsError } from "../lib/errors";
import { setFrontmatterFields, stampTimestamps, today } from "../lib/frontmatter";
import { runGit } from "../lib/git";
import { findRepoRoot, getStoreLink } from "../lib/paths";
import { ensureStore } from "../lib/worktree";

export interface NewOptions {
  title?: string;
  tag: string[];
  json?: boolean;
}

/**
 * Validates a doc name like `billing/stripe-webhooks` and returns it with a
 * `.md` extension. A leading `<type>/` is dropped, because the type directory
 * is added anyway and agents often include it.
 */
function normalizeDocName(name: string, typeName: string): string {
  const withoutType = name.startsWith(`${typeName}/`) ? name.slice(typeName.length + 1) : name;
  const withExtension = withoutType.endsWith(".md") ? withoutType : `${withoutType}.md`;
  const segments = withExtension.split("/");
  const invalid =
    path.posix.isAbsolute(withExtension) ||
    segments.some((segment) => segment === "" || segment === ".." || segment.startsWith("."));
  if (invalid) {
    throw new AgentPlanError(
      `Invalid doc name "${name}": use a relative path like "billing/stripe-webhooks", ` +
        "without '..', empty segments, or segments starting with '.'",
    );
  }
  return withExtension;
}

/** Turns a file name like `2026-10-01-stripe-webhooks.md` into "Stripe webhooks". */
function titleFromDocPath(docPath: string): string {
  const words = path.posix
    .basename(docPath, ".md")
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (words === "") return path.posix.basename(docPath, ".md");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function currentBranch(repoRoot: string): Promise<string> {
  const { exitCode, stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  return exitCode === 0 ? stdout.trim() : "";
}

/**
 * Creates `<type>/<name>.md` in the store from the type's template and
 * returns its path. Doesn't commit: the doc is meant to be filled in first,
 * and `commit`, `sync`, or the auto-commit hook records it after that.
 */
export async function newDoc(typeName: string, name: string, options: NewOptions): Promise<void> {
  const repoRoot = await findRepoRoot();
  const config = await readConfig(repoRoot);
  const storeDir = await ensureStore(repoRoot, config);
  const type = findType(await readDocTypes(storeDir), typeName);

  const docPath = `${type.name}/${normalizeDocName(name, type.name)}`;
  const destPath = path.join(storeDir, docPath);
  if (await Bun.file(destPath).exists()) {
    throw new FileExistsError(docPath);
  }

  const template = await resolveTemplate(storeDir, type.name);
  let content = renderTemplate(template.text, {
    title: options.title ?? titleFromDocPath(docPath),
    status: type.defaultStatus,
    type: type.name,
    name: docPath.slice(type.name.length + 1, -".md".length),
    date: today(),
    branch: await currentBranch(repoRoot),
  });
  if (options.tag.length > 0) {
    content = setFrontmatterFields(content, { tags: yamlFlowList(options.tag) });
  }
  content = stampTimestamps(content);

  await mkdir(path.dirname(destPath), { recursive: true });
  await Bun.write(destPath, content);

  // The path through the checkout's `.apl` link, not the store under `.git/`,
  // so editors and agents open it where users expect it.
  const absolutePath = path.join(getStoreLink(repoRoot), docPath);
  if (options.json) {
    console.log(JSON.stringify({ path: docPath, absolutePath, type: type.name }));
  } else {
    console.log(absolutePath);
  }
}

export function registerNew(program: Command): void {
  program
    .command("new <type> <name>")
    .description("Create a doc from its type's template and print its path")
    .option("--title <title>", "Title for the doc (default: from the file name)")
    .option(
      "--tag <tag>",
      "Tag to add (repeatable)",
      (tag: string, tags: string[]) => [...tags, tag],
      [],
    )
    .option("--json", "Output in JSON format")
    .action(async (typeName: string, name: string, options: NewOptions) => {
      await newDoc(typeName, name, options);
    });
}
