import { describe, expect, test } from "bun:test";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { initPlans } from "../../src/commands/init";
import { readConfig } from "../../src/lib/config";
import { GitPlumbing } from "../../src/lib/git";
import { createTestRepo, gitExec } from "../helpers";

describe("initPlans", () => {
  test("creates the orphan branch and .plans/ worktree in a fresh repo", async () => {
    const repo = await createTestRepo();
    try {
      await initPlans({ cwd: repo.dir });

      const git = new GitPlumbing(repo.dir, "plans");
      expect(await git.branchExists()).toBe(true);

      const plansGit = await lstat(path.join(repo.dir, ".plans", ".git"));
      expect(plansGit.isFile()).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  test("stores config in .git/agent-plan/, not committed to the plans branch", async () => {
    const repo = await createTestRepo();
    try {
      await initPlans({ cwd: repo.dir });

      const config = await readConfig(repo.dir);
      expect(config.branch).toBe("plans");

      // Config must not appear in the plans branch tree.
      const tree = await gitExec(repo.dir, ["ls-tree", "-r", "--name-only", "plans"]);
      expect(tree).not.toContain("config.json");
    } finally {
      await repo.cleanup();
    }
  });

  test("is idempotent when run twice", async () => {
    const repo = await createTestRepo();
    try {
      await initPlans({ cwd: repo.dir });
      await expect(initPlans({ cwd: repo.dir })).resolves.toBeUndefined();

      const git = new GitPlumbing(repo.dir, "plans");
      expect(await git.branchExists()).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  test("creates a branch with a custom name via --branch", async () => {
    const repo = await createTestRepo();
    try {
      await initPlans({ cwd: repo.dir, branch: "custom" });

      const git = new GitPlumbing(repo.dir, "custom");
      expect(await git.branchExists()).toBe(true);

      const config = await readConfig(repo.dir);
      expect(config.branch).toBe("custom");
    } finally {
      await repo.cleanup();
    }
  });

  test("adds .plans to .gitignore (without trailing slash)", async () => {
    const repo = await createTestRepo();
    try {
      await initPlans({ cwd: repo.dir });

      const gitignore = await readFile(path.join(repo.dir, ".gitignore"), "utf8");
      const lines = gitignore.split("\n").map((l) => l.trim());
      expect(lines).toContain(".plans");
    } finally {
      await repo.cleanup();
    }
  });

  test("replaces an existing .plans/ entry with .plans in .gitignore", async () => {
    const repo = await createTestRepo();
    try {
      // Write an old-style entry.
      await Bun.write(path.join(repo.dir, ".gitignore"), ".plans/\n");

      await initPlans({ cwd: repo.dir });

      const gitignore = await readFile(path.join(repo.dir, ".gitignore"), "utf8");
      const lines = gitignore.split("\n").map((l) => l.trim());
      expect(lines).toContain(".plans");
      expect(lines).not.toContain(".plans/");
    } finally {
      await repo.cleanup();
    }
  });

  test("does not duplicate .plans in .gitignore if already present", async () => {
    const repo = await createTestRepo();
    try {
      await initPlans({ cwd: repo.dir });
      await initPlans({ cwd: repo.dir });

      const gitignore = await readFile(path.join(repo.dir, ".gitignore"), "utf8");
      const occurrences = gitignore.split("\n").filter((l) => l.trim() === ".plans").length;
      expect(occurrences).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });

  test("builds on remote branch when remote has it, producing shared history", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const bareDir = await mkdtemp(path.join(tmpdir(), "agent-plan-bare-"));
    try {
      await gitExec(bareDir, ["init", "--bare"]);

      const repoA = await createTestRepo();
      try {
        // Repo A inits and pushes.
        await initPlans({ cwd: repoA.dir });
        await gitExec(repoA.dir, ["remote", "add", "origin", bareDir]);
        await gitExec(path.join(repoA.dir, ".plans"), ["push", "origin", "HEAD:plans"]);

        const repoB = await createTestRepo();
        try {
          // Repo B inits with the remote already having the branch.
          await gitExec(repoB.dir, ["remote", "add", "origin", bareDir]);
          await initPlans({ cwd: repoB.dir });

          // Verify repo B's branch is rooted at the same commit as repo A's.
          const hashA = await gitExec(repoA.dir, ["rev-parse", "plans"]);
          const hashB = await gitExec(repoB.dir, ["rev-parse", "plans"]);
          expect(hashA).toBe(hashB);
        } finally {
          await repoB.cleanup();
        }
      } finally {
        await repoA.cleanup();
      }
    } finally {
      await rm(bareDir, { recursive: true, force: true });
    }
  });
});
