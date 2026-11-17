import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { DEFAULT_STATUSES, readDocTypes, typeOf } from "../lib/doc-types";
import { AgentPlanError } from "../lib/errors";
import { parseFrontmatter, setFrontmatterFields, stampTimestamps } from "../lib/frontmatter";
import { readText } from "../lib/fs";
import { resolveDocPath } from "../lib/links";
import { withStoreLock } from "../lib/lock";
import { success } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { ensureStore } from "../lib/worktree";

export interface SetOptions {
  status?: string;
}

/** Changes front matter fields of a doc in place, leaving the change uncommitted like any other edit. */
export async function setDocFields(docInput: string, options: SetOptions): Promise<void> {
  if (options.status === undefined) {
    throw new AgentPlanError("Nothing to set. Pass --status <status>.");
  }
  const { status } = options;

  const repoRoot = await findRepoRoot();
  await withStoreLock(repoRoot, async () => {
    const config = await readConfig(repoRoot);
    const storeDir = await ensureStore(repoRoot, config);

    const doc = await resolveDocPath(storeDir, docInput);
    const type = typeOf(doc, await readDocTypes(storeDir));
    const allowed = type?.statuses ?? DEFAULT_STATUSES;
    if (!allowed.includes(status)) {
      const kind = type ? `${type.name} docs` : "docs outside a type directory";
      throw new AgentPlanError(
        `"${status}" is not a status of ${kind} (${doc}). Use one of: ${allowed.join(", ")}.`,
      );
    }

    const docFile = join(storeDir, doc);
    const raw = await readText(docFile);
    if (!parseFrontmatter(raw).hasFrontmatter) {
      throw new AgentPlanError(`${doc} has no front matter to set a status in.`);
    }

    await writeFile(docFile, stampTimestamps(setFrontmatterFields(raw, { status })));
    success(`Set ${doc} status to ${status}`);
  });
}

export function registerSet(program: Command): void {
  program
    .command("set <doc>")
    .description("Set fields in a doc's front matter")
    .option("--status <status>", "Status to set; must be one the doc's type lists")
    .action(async (doc: string, options: SetOptions) => {
      await setDocFields(doc, options);
    });
}
