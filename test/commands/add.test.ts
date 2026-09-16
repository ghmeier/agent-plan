import { describe, expect, test } from "bun:test";
import path, { join } from "node:path";
import { addPlans } from "../../src/commands/add";
import { createTestRepoWithPlans, gitExec } from "../helpers";

/** Reads a plan file's content as committed on the plans branch, not just what's on disk. */
async function readCommittedPlan(repoDir: string, planPath: string): Promise<string> {
  return gitExec(join(repoDir, ".plans"), ["show", `HEAD:${planPath}`]);
}

describe("addPlans", () => {
  test("adds a single file and commits it to the plans branch", async () => {
    const repo = await createTestRepoWithPlans();
    try {
      await Bun.write(path.join(repo.dir, "plan.md"), "hello plan");

      await addPlans(["plan.md"], { cwd: repo.dir });

      const content = await readCommittedPlan(repo.dir, "plan.md");
      expect(content).toBe("hello plan");
    } finally {
      await repo.cleanup();
    }
  });

  test("adds multiple files at once in a single commit", async () => {
    const repo = await createTestRepoWithPlans();
    try {
      await Bun.write(path.join(repo.dir, "a.md"), "content a");
      await Bun.write(path.join(repo.dir, "b.md"), "content b");

      await addPlans(["a.md", "b.md"], { cwd: repo.dir });

      expect(await readCommittedPlan(repo.dir, "a.md")).toBe("content a");
      expect(await readCommittedPlan(repo.dir, "b.md")).toBe("content b");
    } finally {
      await repo.cleanup();
    }
  });

  test("overwrites an existing file with new content", async () => {
    const repo = await createTestRepoWithPlans();
    try {
      const filePath = path.join(repo.dir, "plan.md");

      await Bun.write(filePath, "original content");
      await addPlans(["plan.md"], { cwd: repo.dir });

      await Bun.write(filePath, "updated content");
      await addPlans(["plan.md"], { cwd: repo.dir });

      expect(await readCommittedPlan(repo.dir, "plan.md")).toBe("updated content");
    } finally {
      await repo.cleanup();
    }
  });

  test("uses a custom commit message when provided", async () => {
    const repo = await createTestRepoWithPlans();
    try {
      await Bun.write(path.join(repo.dir, "plan.md"), "hello plan");

      await addPlans(["plan.md"], { cwd: repo.dir, message: "Custom commit message" });

      const log = await gitExec(join(repo.dir, ".plans"), ["log", "-1", "--pretty=%s"]);
      expect(log).toBe("Custom commit message");
    } finally {
      await repo.cleanup();
    }
  });

  test("added file is still present in .plans/ after a subsequent commit", async () => {
    const repo = await createTestRepoWithPlans();
    try {
      await Bun.write(path.join(repo.dir, "keep.md"), "keep me");
      await addPlans(["keep.md"], { cwd: repo.dir });

      // Write and commit a second file — keep.md must not disappear.
      await Bun.write(path.join(repo.dir, "other.md"), "other");
      await addPlans(["other.md"], { cwd: repo.dir });

      const keepFile = Bun.file(join(repo.dir, ".plans", "keep.md"));
      expect(await keepFile.exists()).toBe(true);
      expect(await keepFile.text()).toBe("keep me");
    } finally {
      await repo.cleanup();
    }
  });

  test("throws when the file does not exist on disk", async () => {
    const repo = await createTestRepoWithPlans();
    try {
      await expect(addPlans(["missing.md"], { cwd: repo.dir })).rejects.toThrow();
    } finally {
      await repo.cleanup();
    }
  });
});
