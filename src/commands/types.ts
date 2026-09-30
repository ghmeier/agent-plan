import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { readDocTypes, resolveTemplate } from "../lib/doc-types";
import { colors } from "../lib/output";
import { findRepoRoot } from "../lib/paths";
import { ensureStore } from "../lib/worktree";

export async function listTypes(options: { json?: boolean }): Promise<void> {
  const repoRoot = await findRepoRoot();
  const config = await readConfig(repoRoot);
  const storeDir = await ensureStore(repoRoot, config);

  const types = await Promise.all(
    (await readDocTypes(storeDir)).map(async (type) => ({
      ...type,
      template: (await resolveTemplate(storeDir, type.name)).source,
    })),
  );

  if (options.json) {
    console.log(JSON.stringify({ types }));
    return;
  }

  for (const type of types) {
    const description = type.description ? `  ${type.description}` : "";
    console.log(`${colors.bold(type.name)}${description}`);
    console.log(
      colors.dim(`  statuses: ${type.statuses.join(", ")} (default ${type.defaultStatus})`),
    );
  }
}

export function registerTypes(program: Command): void {
  program
    .command("types")
    .description("List the doc types, their statuses, and where their templates come from")
    .option("--json", "Output in JSON format")
    .action(async (options: { json?: boolean }) => {
      await listTypes(options);
    });
}
