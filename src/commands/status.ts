import type { Command } from "commander";
import { readConfig } from "../lib/config";
import { runGit } from "../lib/git";
import { colors } from "../lib/output";
import { findRepoRoot, getStoreLink } from "../lib/paths";
import { aheadBehind, hasRemote, upstreamRef } from "../lib/remote";
import { ensureStore, operationInProgress } from "../lib/worktree";

interface PendingFile {
  path: string;
  /** Two-letter code from `git status --porcelain`, such as " M" or "??". */
  status: string;
}

async function pendingFiles(storeDir: string): Promise<PendingFile[]> {
  const { stdout } = await runGit(
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    storeDir,
  );
  const entries = stdout.split("\0").filter(Boolean);
  const files: PendingFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    const status = entry.slice(0, 2);
    files.push({ path: entry.slice(3), status });
    // A rename's original path follows as its own NUL-separated entry.
    if (status.startsWith("R")) i++;
  }
  return files;
}

/**
 * Reports what an agent or person needs before working with docs: where the
 * store is, whether this checkout is behind or ahead of teammates (as of the
 * last fetch; `apl pull` refreshes it), uncommitted files, and any git
 * operation left unfinished. Running it also creates the `.apl` link, which
 * makes it a good command for a checkout's setup hook.
 */
export async function showStatus(options: { json?: boolean }): Promise<void> {
  const repoRoot = await findRepoRoot();
  const config = await readConfig(repoRoot);
  const storeDir = await ensureStore(repoRoot, config);

  const upstream = upstreamRef(config);
  const counts = (await hasRemote(repoRoot, config)) ? await aheadBehind(storeDir, upstream) : null;
  const pending = await pendingFiles(storeDir);
  const operation = (await operationInProgress(storeDir))?.name ?? null;

  if (options.json) {
    console.log(
      JSON.stringify({
        store: getStoreLink(repoRoot),
        branch: config.branch,
        upstream: counts ? { ref: upstream, ...counts } : null,
        pending,
        operation,
      }),
    );
    return;
  }

  console.log(`${colors.bold("Store:")}   ${getStoreLink(repoRoot)}`);
  const tracking = counts
    ? `${counts.ahead} ahead, ${counts.behind} behind ${upstream} as of the last fetch`
    : "not synced with a remote";
  console.log(`${colors.bold("Branch:")}  ${config.branch} (${tracking})`);
  if (operation) {
    console.log(
      colors.yellow(`A ${operation} is in progress. Finish or abort it before committing.`),
    );
  }
  if (pending.length === 0) {
    console.log("No uncommitted changes");
  } else {
    console.log(`${colors.bold("Uncommitted:")}`);
    for (const file of pending) console.log(`  ${file.status} ${file.path}`);
  }
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show uncommitted docs and how this checkout compares with the remote")
    .option("--json", "Output in JSON format")
    .action(async (options: { json?: boolean }) => {
      await showStatus(options);
    });
}
