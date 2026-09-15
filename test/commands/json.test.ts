import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diffPlan } from "../../src/commands/diff";
import { getPlanLog } from "../../src/commands/log";
import { listPlans } from "../../src/commands/ls";
import { showPlan } from "../../src/commands/show";
import { createTestRepo, initTestPlans, type TestRepo, writePlanFile } from "../helpers";

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  let output = "";
  console.log = (...args: unknown[]) => {
    output += `${args.join(" ")}\n`;
  };
  return fn()
    .then(() => {
      console.log = originalLog;
      return output.trim();
    })
    .catch((e) => {
      console.log = originalLog;
      throw e;
    });
}

describe("--json output", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo();
    await initTestPlans(repo.dir);
    await writePlanFile(repo.dir, "plan.md", "# Plan\n", "Add plan");
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("show --json returns valid JSON with path and content fields", async () => {
    const output = await captureStdout(async () => {
      await showPlan("plan.md", { json: true }, repo.dir);
    });

    const parsed = JSON.parse(output);
    expect(parsed.path).toBe("plan.md");
    expect(parsed.content).toBe("# Plan\n");
  });

  test("ls --json returns valid JSON with files array of entries including meta", async () => {
    const output = await captureStdout(async () => {
      await listPlans(undefined, repo.dir, { json: true });
    });

    const parsed = JSON.parse(output);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].file).toBe("plan.md");
    expect(parsed.files[0].meta).toBeDefined();
  });

  test("log --json returns valid JSON with entries containing hash, message, date, author", async () => {
    const output = await captureStdout(async () => {
      await getPlanLog(undefined, 20, repo.dir, { json: true });
    });

    const parsed = JSON.parse(output);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(1);
    const entry = parsed.entries[0];
    expect(entry.message).toBe("Add plan");
    expect(entry.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.author).toBe("Test");
    expect(new Date(entry.date).toString()).not.toBe("Invalid Date");
  });

  test("diff --json with uncommitted changes returns changed true and non-empty diff", async () => {
    const plansDir = join(repo.dir, ".plans");
    await writeFile(join(plansDir, "plan.md"), "# Plan\n\nNew local content.\n");

    const output = await captureStdout(async () => {
      await diffPlan("plan.md", repo.dir, { json: true });
    });

    const parsed = JSON.parse(output);
    expect(parsed.path).toBe("plan.md");
    expect(parsed.changed).toBe(true);
    expect(parsed.diff.length).toBeGreaterThan(0);
  });

  test("diff --json with no changes returns changed false", async () => {
    const output = await captureStdout(async () => {
      await diffPlan("plan.md", repo.dir, { json: true });
    });

    const parsed = JSON.parse(output);
    expect(parsed.changed).toBe(false);
    expect(parsed.diff).toBe("");
  });
});
