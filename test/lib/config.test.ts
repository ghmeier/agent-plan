import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../src/lib/config";
import { DEFAULT_CONFIG, type PlanConfig } from "../../src/types";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "plan-storage-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("readConfig", () => {
  test("returns defaults when no config file exists", async () => {
    const repoRoot = await makeTempRepo();

    const config = await readConfig(repoRoot);

    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("preserves a custom branch name from disk", async () => {
    const repoRoot = await makeTempRepo();
    const custom: PlanConfig = {
      branch: "my-plans",
      remote: "upstream",
      worktree: true,
    };
    await writeConfig(repoRoot, custom);

    const config = await readConfig(repoRoot);

    expect(config.branch).toBe("my-plans");
  });
});

describe("writeConfig", () => {
  test("round-trips through readConfig", async () => {
    const repoRoot = await makeTempRepo();
    const custom: PlanConfig = {
      branch: "feature-plans",
      remote: "origin",
      worktree: false,
    };

    await writeConfig(repoRoot, custom);
    const readBack = await readConfig(repoRoot);

    expect(readBack).toEqual(custom);
  });

  test("creates the .plans directory when missing", async () => {
    const repoRoot = await makeTempRepo();

    await writeConfig(repoRoot, DEFAULT_CONFIG);

    const file = Bun.file(join(repoRoot, ".plans", "config.json"));
    expect(await file.exists()).toBe(true);
  });
});
