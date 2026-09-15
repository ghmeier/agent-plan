import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../src/lib/config";
import { DEFAULT_CONFIG, type PlanConfig } from "../../src/types";
import { createTestRepo } from "../helpers";

describe("readConfig", () => {
  test("returns defaults when no config file exists", async () => {
    const repo = await createTestRepo();

    try {
      const config = await readConfig(repo.dir);

      expect(config).toEqual(DEFAULT_CONFIG);
    } finally {
      await repo.cleanup();
    }
  });

  test("preserves a custom branch name from disk", async () => {
    const repo = await createTestRepo();

    try {
      const custom: PlanConfig = { branch: "my-plans", remote: "upstream" };
      await writeConfig(repo.dir, custom);

      const config = await readConfig(repo.dir);

      expect(config.branch).toBe("my-plans");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("writeConfig", () => {
  test("round-trips through readConfig", async () => {
    const repo = await createTestRepo();

    try {
      const custom: PlanConfig = { branch: "feature-plans", remote: "origin" };

      await writeConfig(repo.dir, custom);
      const readBack = await readConfig(repo.dir);

      expect(readBack).toEqual(custom);
    } finally {
      await repo.cleanup();
    }
  });

  test("stores config inside .git, not in the working tree", async () => {
    const repo = await createTestRepo();

    try {
      await writeConfig(repo.dir, DEFAULT_CONFIG);

      // Config must live in .git/agent-plan/, never in the working tree.
      const insideGit = Bun.file(join(repo.dir, ".git", "agent-plan", "config.json"));
      expect(await insideGit.exists()).toBe(true);

      // The working tree must not contain a config.json from this write.
      const inWorktree = Bun.file(join(repo.dir, ".plans", "config.json"));
      expect(await inWorktree.exists()).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});
