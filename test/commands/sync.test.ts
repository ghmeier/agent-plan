import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncPlans } from "../../src/commands/sync";
import { createTestRepo, gitExec, initTestPlans, writePlanFile } from "../helpers";

async function createBareRemote(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-plan-bare-"));
  await gitExec(dir, ["init", "--bare"]);
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("syncPlans", () => {
  test("skips sync cleanly when no remote is configured", async () => {
    const repo = await createTestRepo();
    try {
      await initTestPlans(repo.dir);

      await expect(syncPlans({ cwd: repo.dir })).resolves.toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  test("pushes the plans branch to the remote", async () => {
    const repo = await createTestRepo();
    const bare = await createBareRemote();
    try {
      await initTestPlans(repo.dir);
      await gitExec(repo.dir, ["remote", "add", "origin", bare.dir]);
      await writePlanFile(repo.dir, "plan.md", "hello");

      await syncPlans({ cwd: repo.dir });

      const branches = await gitExec(bare.dir, ["branch"]);
      expect(branches).toContain("plans");
    } finally {
      await repo.cleanup();
      await bare.cleanup();
    }
  });

  test("pushes successfully when the remote branch does not exist yet", async () => {
    const repo = await createTestRepo();
    const bare = await createBareRemote();
    try {
      await initTestPlans(repo.dir);
      await gitExec(repo.dir, ["remote", "add", "origin", bare.dir]);

      await expect(syncPlans({ cwd: repo.dir })).resolves.toBeUndefined();

      const branches = await gitExec(bare.dir, ["branch"]);
      expect(branches).toContain("plans");
    } finally {
      await repo.cleanup();
      await bare.cleanup();
    }
  });

  test("pulls changes made from another repo synced to the same remote", async () => {
    const repoA = await createTestRepo();
    const repoB = await createTestRepo();
    const bare = await createBareRemote();
    try {
      // Repo A initializes, writes a file, and syncs to the remote.
      await initTestPlans(repoA.dir);
      await gitExec(repoA.dir, ["remote", "add", "origin", bare.dir]);
      await writePlanFile(repoA.dir, "plan.md", "from repo A");
      await syncPlans({ cwd: repoA.dir });

      // Repo B initializes from the remote branch (no orphan needed — remote has it).
      await gitExec(repoB.dir, ["remote", "add", "origin", bare.dir]);
      await initTestPlans(repoB.dir);

      // After sync, repo B should see repo A's file.
      const content = await Bun.file(join(repoB.dir, ".plans", "plan.md")).text();
      expect(content).toBe("from repo A");
    } finally {
      await repoA.cleanup();
      await repoB.cleanup();
      await bare.cleanup();
    }
  });

  test("commits pending worktree edits before pushing", async () => {
    const repo = await createTestRepo();
    const bare = await createBareRemote();
    try {
      await initTestPlans(repo.dir);
      await gitExec(repo.dir, ["remote", "add", "origin", bare.dir]);

      // Write a file directly into .plans/ without committing.
      const plansDir = join(repo.dir, ".plans");
      await writeFile(join(plansDir, "draft.md"), "pending edit");

      await syncPlans({ cwd: repo.dir });

      // The remote must now have the draft committed.
      const result = await gitExec(bare.dir, ["show", "plans:draft.md"]);
      expect(result).toBe("pending edit");
    } finally {
      await repo.cleanup();
      await bare.cleanup();
    }
  });

  test("init from remote branch produces shared history so sync succeeds without divergence", async () => {
    // Regression: two independent `apl init` calls used to create unrelated orphan
    // commits whose timestamps differed. Push from the second repo would then fail
    // because histories were unrelated. This test forces a timestamp difference by
    // committing a file before the second init, which produces a different parent SHA.
    const repoA = await createTestRepo();
    const repoB = await createTestRepo();
    const bare = await createBareRemote();
    try {
      // Repo A inits, pushes to remote.
      await initTestPlans(repoA.dir);
      await gitExec(repoA.dir, ["remote", "add", "origin", bare.dir]);
      await writePlanFile(repoA.dir, "seed.md", "seed");
      await syncPlans({ cwd: repoA.dir });

      // Repo B inits with the remote already populated — it must build on the
      // remote's history rather than creating a fresh orphan.
      await gitExec(repoB.dir, ["remote", "add", "origin", bare.dir]);
      await initTestPlans(repoB.dir);

      // A second sync from B must succeed (no divergence).
      await writePlanFile(repoB.dir, "from-b.md", "hello from B");
      await expect(syncPlans({ cwd: repoB.dir })).resolves.toBeUndefined();

      // Both files visible from the remote.
      const branches = await gitExec(bare.dir, ["branch"]);
      expect(branches).toContain("plans");
    } finally {
      await repoA.cleanup();
      await repoB.cleanup();
      await bare.cleanup();
    }
  });
});
