import { describe, expect, test } from "bun:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { initPlans } from "../../src/commands/init";
import { readConfig } from "../../src/lib/config";
import { GitPlumbing } from "../../src/lib/git";
import { createTestRepo } from "../helpers";

describe("initPlans", () => {
  test("creates the orphan branch and config file in a fresh repo", async () => {
    const repo = await createTestRepo();

    try {
      await initPlans({ cwd: repo.dir });

      const git = new GitPlumbing(repo.dir, "plans");
      expect(await git.branchExists()).toBe(true);

      const config = await readConfig(repo.dir);
      expect(config.branch).toBe("plans");
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

  test("adds .plans/ to .gitignore", async () => {
    const repo = await createTestRepo();

    try {
      await initPlans({ cwd: repo.dir });

      const gitignore = await readFile(path.join(repo.dir, ".gitignore"), "utf8");
      expect(gitignore).toContain(".plans/");
    } finally {
      await repo.cleanup();
    }
  });

  test("does not duplicate .plans/ in .gitignore if already present", async () => {
    const repo = await createTestRepo();

    try {
      await initPlans({ cwd: repo.dir });
      await initPlans({ cwd: repo.dir });

      const gitignore = await readFile(path.join(repo.dir, ".gitignore"), "utf8");
      const occurrences = gitignore.split("\n").filter((line) => line.trim() === ".plans/").length;
      expect(occurrences).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });
});
