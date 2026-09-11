import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { createTestRepo, gitExec } from "./helpers";

describe("createTestRepo", () => {
  test("creates a valid git repo", async () => {
    const { dir, cleanup } = await createTestRepo();

    try {
      expect(existsSync(path.join(dir, ".git"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("cleanup removes the temporary directory", async () => {
    const { dir, cleanup } = await createTestRepo();

    await cleanup();

    expect(existsSync(dir)).toBe(false);
  });
});

describe("gitExec", () => {
  test("runs git status in the test repo", async () => {
    const { dir, cleanup } = await createTestRepo();

    try {
      const output = await gitExec(dir, ["status"]);
      expect(output).toContain("nothing to commit");
    } finally {
      await cleanup();
    }
  });
});
