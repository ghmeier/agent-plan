import { describe, expect, test } from "bun:test";
import path from "node:path";
import { addPlans } from "../../src/commands/add";
import { GitPlumbing } from "../../src/lib/git";
import { createTestRepo, gitExec } from "../helpers";

async function initPlansBranch(dir: string): Promise<GitPlumbing> {
  const git = new GitPlumbing(dir);
  await git.createOrphanBranch();
  return git;
}

describe("addPlans", () => {
  test("adds a single file", async () => {
    const repo = await createTestRepo();
    try {
      const git = await initPlansBranch(repo.dir);
      await Bun.write(path.join(repo.dir, "plan.md"), "hello plan");

      await addPlans(["plan.md"], { cwd: repo.dir });

      const content = await git.readFile("plan.md");
      expect(content).toBe("hello plan");
    } finally {
      await repo.cleanup();
    }
  });

  test("adds multiple files at once", async () => {
    const repo = await createTestRepo();
    try {
      const git = await initPlansBranch(repo.dir);
      await Bun.write(path.join(repo.dir, "a.md"), "content a");
      await Bun.write(path.join(repo.dir, "b.md"), "content b");

      await addPlans(["a.md", "b.md"], { cwd: repo.dir });

      expect(await git.readFile("a.md")).toBe("content a");
      expect(await git.readFile("b.md")).toBe("content b");
    } finally {
      await repo.cleanup();
    }
  });

  test("overwrites an existing file with new content", async () => {
    const repo = await createTestRepo();
    try {
      const git = await initPlansBranch(repo.dir);
      const filePath = path.join(repo.dir, "plan.md");

      await Bun.write(filePath, "original content");
      await addPlans(["plan.md"], { cwd: repo.dir });

      await Bun.write(filePath, "updated content");
      await addPlans(["plan.md"], { cwd: repo.dir });

      expect(await git.readFile("plan.md")).toBe("updated content");
    } finally {
      await repo.cleanup();
    }
  });

  test("uses a custom commit message when provided", async () => {
    const repo = await createTestRepo();
    try {
      await initPlansBranch(repo.dir);
      await Bun.write(path.join(repo.dir, "plan.md"), "hello plan");

      await addPlans(["plan.md"], { cwd: repo.dir, message: "Custom commit message" });

      const log = await gitExec(repo.dir, ["log", "-1", "--pretty=%s", "plans"]);
      expect(log).toBe("Custom commit message");
    } finally {
      await repo.cleanup();
    }
  });

  test("throws when the file does not exist on disk", async () => {
    const repo = await createTestRepo();
    try {
      await initPlansBranch(repo.dir);

      await expect(addPlans(["missing.md"], { cwd: repo.dir })).rejects.toThrow();
    } finally {
      await repo.cleanup();
    }
  });
});
