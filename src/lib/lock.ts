import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { AgentPlanError } from "./errors";
import { getGitCommonDir } from "./paths";

const WAIT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 100;
/** A holder writes its pid right after creating the lock, so a lock this old with no pid was abandoned. */
const MISSING_PID_GRACE_MS = 10_000;

/**
 * Runs `fn` while holding the lock for the docs store, which every checkout of a
 * repo shares. The plugin's Stop hook runs in the background, so a sync can still
 * be running when the next turn ends, and other sessions in the same repo sync or
 * pull too. Overlapping commits and rebases in one store fail on git's index lock.
 * Callers wait rather than skip, so the latest edits are always published.
 */
export async function withStoreLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = path.join(await getGitCommonDir(repoRoot), "agent-plan", "store.lock");
  await acquire(lockDir);
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function acquire(lockDir: string): Promise<void> {
  await mkdir(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockDir);
      await Bun.write(path.join(lockDir, "pid"), String(process.pid));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (await holderIsGone(lockDir)) {
      await rm(lockDir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new AgentPlanError(
        `Another apl command has held ${lockDir} for over ${WAIT_TIMEOUT_MS / 1000}s. If no apl process is running, delete that directory and try again.`,
      );
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

async function holderIsGone(lockDir: string): Promise<boolean> {
  const pid = Number.parseInt(
    await Bun.file(path.join(lockDir, "pid"))
      .text()
      .catch(() => ""),
    10,
  );
  if (Number.isNaN(pid)) {
    const created = await stat(lockDir).catch(() => null);
    return created === null || Date.now() - created.mtimeMs > MISSING_PID_GRACE_MS;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}
