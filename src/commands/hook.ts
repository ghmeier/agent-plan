import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { readDocTypes } from "../lib/doc-types";
import { AgentPlanError } from "../lib/errors";
import { branchExists } from "../lib/git";
import { findRepoRoot } from "../lib/paths";
import { ensureStore } from "../lib/worktree";
import { findDocs } from "./ls";
import { pullDocs } from "./pull";
import { syncPlans } from "./sync";

/**
 * The plugin enables these hooks in every repo, so they act only where the
 * docs branch exists, and check that without fetching or creating anything.
 */
async function docsEnabledHere(): Promise<boolean> {
  try {
    const repoRoot = await findRepoRoot();
    return await branchExists(repoRoot, (await readConfig(repoRoot)).branch);
  } catch {
    return false;
  }
}

/**
 * Brings in teammates' docs and prints the open handoffs, which Claude Code
 * adds to the session's context. A failed pull is reported in that output
 * rather than failing the hook, so the session still starts with the list.
 */
async function sessionStart(): Promise<void> {
  try {
    await pullDocs({ quiet: true });
  } catch (err) {
    const message = err instanceof AgentPlanError ? err.message : String(err);
    console.log(`apl could not pull teammates' doc changes: ${message}`);
  }

  const repoRoot = await findRepoRoot();
  const storeDir = await ensureStore(repoRoot, await readConfig(repoRoot));
  const handoff = (await readDocTypes(storeDir)).find((t) => t.name === "handoff");
  if (!handoff) return;

  const open = await findDocs(storeDir, { type: handoff.name, status: handoff.defaultStatus });
  if (open.length === 0) return;

  console.log("Open handoffs in .apl/ (read one with `apl show <path>`):");
  for (const doc of open) {
    console.log(`- ${doc.file}${doc.meta.title ? `: ${doc.meta.title}` : ""}`);
  }
}

export function registerHook(program: Command): void {
  program
    .command("hook <event>", { hidden: true })
    .description("Run the Claude Code plugin's hook for an event (session-start or stop)")
    .action(async (event: string) => {
      if (!(await docsEnabledHere())) return;
      if (event === "session-start") {
        await sessionStart();
      } else if (event === "stop") {
        await syncPlans({ ifChanged: true });
      } else {
        throw new AgentPlanError(`Unknown hook event "${event}". Use session-start or stop.`);
      }
    });
}
