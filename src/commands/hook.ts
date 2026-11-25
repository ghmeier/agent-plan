import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { readDocTypes } from "../lib/doc-types";
import { AgentPlanError } from "../lib/errors";
import { parseFrontmatter } from "../lib/frontmatter";
import { readTextIfExists } from "../lib/fs";
import { branchExists } from "../lib/git";
import { currentBranch, currentLinkOfBranch, readRecordedLinks } from "../lib/links";
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
 * Brings in teammates' docs and prints a pointer to the plugin's skill and
 * the open handoffs, which Claude Code and Codex add to the session's context. Without
 * the pointer, agents that see `.apl/` mentioned elsewhere learn the CLI from
 * `--help` and miss the skill's conventions. A failed pull is reported in
 * that output rather than failing the hook, so the session still starts with
 * the list.
 */
async function sessionStart(): Promise<void> {
  try {
    await pullDocs({ quiet: true });
  } catch (err) {
    const message = err instanceof AgentPlanError ? err.message : String(err);
    console.log(`apl could not pull teammates' doc changes: ${message}`);
  }

  console.log(
    "This repo keeps plans, research, and handoffs in .apl/. Load the agent-plan:apl skill before reading or writing them.",
  );

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

/**
 * Lists the docs linked to the branch this checkout is on, so a session that
 * starts on a work branch is pointed at its plan. Only reads: it records no
 * link.
 */
async function printLinkedDocs(): Promise<void> {
  const repoRoot = await findRepoRoot();
  const branch = await currentBranch(repoRoot);
  if (!branch) return;

  const storeDir = await ensureStore(repoRoot, await readConfig(repoRoot));
  const link = currentLinkOfBranch(await readRecordedLinks(storeDir), branch);

  const lines: string[] = [];
  for (const doc of link?.docs ?? []) {
    const content = await readTextIfExists(join(storeDir, doc));
    // A doc can be deleted after it was linked.
    if (content === null) continue;
    const { title } = parseFrontmatter(content).meta;
    lines.push(`- ${doc}${title ? `: ${title}` : ""}`);
  }
  if (lines.length === 0) return;

  console.log("Docs linked to this branch (read them with `apl show --branch`):");
  for (const line of lines) console.log(line);
}

/**
 * Publishes doc edits made during the turn. The Claude Code plugin runs this
 * hook with `asyncRewake`, which drops a background hook's output unless it
 * exits with code 2, so every failure exits 2 to reach the agent, which then
 * tells the user about a conflict instead of leaving it unnoticed. Codex has
 * no equivalent for background hooks, so there a conflict surfaces at the
 * next session start, when the pull fails.
 */
async function stop(): Promise<void> {
  try {
    await syncPlans({ ifChanged: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AgentPlanError(`apl could not publish doc edits: ${message}`, 2);
  }
}

export function registerHook(program: Command): void {
  program
    .command("hook <event>", { hidden: true })
    .description("Run the agent plugin's hook for an event (session-start or stop)")
    .action(async (event: string) => {
      if (!(await docsEnabledHere())) return;
      if (event === "session-start") {
        await sessionStart();
        await printLinkedDocs();
      } else if (event === "stop") {
        await stop();
      } else {
        throw new AgentPlanError(`Unknown hook event "${event}". Use session-start or stop.`);
      }
    });
}
