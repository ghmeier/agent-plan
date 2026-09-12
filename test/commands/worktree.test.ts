import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createTestRepo } from "../helpers";
import { GitPlumbing } from "../../src/lib/git";
import { readConfig } from "../../src/lib/config";
import { initPlans } from "../../src/commands/init";
import { commitPlans } from "../../src/commands/commit";

describe("init --worktree", () => {
  test("creates .plans/ as a git worktree", async () => {
    const repo = await createTestRepo();

    await initPlans({ cwd: repo.dir, worktree: true });

    const plansGit = await stat(join(repo.dir, ".plans", ".git"));
    expect(plansGit.isFile()).toBe(true);

    await repo.cleanup();
  });

  test("sets config.worktree to true", async () => {
    const repo = await createTestRepo();

    await initPlans({ cwd: repo.dir, worktree: true });

    const config = await readConfig(repo.dir);
    expect(config.worktree).toBe(true);

    await repo.cleanup();
  });

  test("is idempotent", async () => {
    const repo = await createTestRepo();

    await initPlans({ cwd: repo.dir, worktree: true });
    await initPlans({ cwd: repo.dir, worktree: true });

    const plansGit = await stat(join(repo.dir, ".plans", ".git"));
    expect(plansGit.isFile()).toBe(true);

    const config = await readConfig(repo.dir);
    expect(config.worktree).toBe(true);

    await repo.cleanup();
  });
});

describe("commit", () => {
  test("commits a file written directly to .plans/ in worktree mode", async () => {
    const repo = await createTestRepo();
    await initPlans({ cwd: repo.dir, worktree: true });

    await Bun.write(join(repo.dir, ".plans", "notes.md"), "hello from worktree\n");
    await commitPlans({ cwd: repo.dir, message: "Add notes" });

    const git = new GitPlumbing(repo.dir, "plans");
    const content = await git.readFile("notes.md");
    expect(content).toBe("hello from worktree\n");

    await repo.cleanup();
  });

  test("prints placeholder message without worktree mode", async () => {
    const repo = await createTestRepo();
    await initPlans({ cwd: repo.dir });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      await commitPlans({ cwd: repo.dir });
    } finally {
      console.log = originalLog;
    }

    expect(logs.join("\n")).toContain("Nothing to commit");

    await repo.cleanup();
  });
});
