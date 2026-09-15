import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncPlans } from "../../src/commands/sync";
import { GitPlumbing } from "../../src/lib/git";
import { createTestRepo, gitExec } from "../helpers";

async function initPlansBranch(dir: string): Promise<GitPlumbing> {
  const git = new GitPlumbing(dir);
  await git.createOrphanBranch();
  return git;
}

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
      await initPlansBranch(repo.dir);

      await expect(syncPlans({ cwd: repo.dir })).resolves.toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  test("pushes the plans branch to the remote", async () => {
    const repo = await createTestRepo();
    const bare = await createBareRemote();
    try {
      await initPlansBranch(repo.dir);
      await gitExec(repo.dir, ["remote", "add", "origin", bare.dir]);

      await syncPlans({ cwd: repo.dir });

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
      const gitA = await initPlansBranch(repoA.dir);
      await gitExec(repoA.dir, ["remote", "add", "origin", bare.dir]);
      await gitA.writeFiles([{ path: "plan.md", content: "from repo A" }], "Add plan");
      await syncPlans({ cwd: repoA.dir });

      await initPlansBranch(repoB.dir);
      await gitExec(repoB.dir, ["remote", "add", "origin", bare.dir]);
      await syncPlans({ cwd: repoB.dir });

      const gitB = new GitPlumbing(repoB.dir);
      expect(await gitB.readFile("plan.md")).toBe("from repo A");
    } finally {
      await repoA.cleanup();
      await repoB.cleanup();
      await bare.cleanup();
    }
  });

  test("pushes successfully when the remote branch does not exist yet", async () => {
    const repo = await createTestRepo();
    const bare = await createBareRemote();
    try {
      await initPlansBranch(repo.dir);
      await gitExec(repo.dir, ["remote", "add", "origin", bare.dir]);

      await expect(syncPlans({ cwd: repo.dir })).resolves.toBeUndefined();

      const branches = await gitExec(bare.dir, ["branch"]);
      expect(branches).toContain("plans");
    } finally {
      await repo.cleanup();
      await bare.cleanup();
    }
  });
});
