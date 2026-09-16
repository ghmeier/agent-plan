import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diffPlan } from "../../src/commands/diff";
import { getPlanLog } from "../../src/commands/log";
import { listPlans } from "../../src/commands/ls";
import { showPlan } from "../../src/commands/show";
import { createTestRepoWithPlans, type TestRepo, writePlanFile } from "../helpers";

describe("read commands", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepoWithPlans();
    await writePlanFile(repo.dir, "plan.md", "# My Plan\n");
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("show returns file content including uncommitted edits", async () => {
    const content = await showPlan("plan.md", {}, repo.dir);

    expect(content).toBe("# My Plan\n");
  });

  test("show with --version returns historical content", async () => {
    // Record the current HEAD hash before adding a second commit.
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: join(repo.dir, ".plans"),
      stdout: "pipe",
      stderr: "ignore",
    });
    const oldHash = (await new Response(proc.stdout).text()).trim();
    await proc.exited;

    await writePlanFile(repo.dir, "plan.md", "# Updated Plan\n", "Update plan");

    const historical = await showPlan("plan.md", { version: oldHash }, repo.dir);
    const current = await showPlan("plan.md", {}, repo.dir);

    expect(historical).toContain("My Plan");
    expect(current).toBe("# Updated Plan\n");
  });

  test("show nonexistent file gives error", async () => {
    await expect(showPlan("missing.md", {}, repo.dir)).rejects.toThrow();
  });

  test("show returns uncommitted edits written directly to .plans/", async () => {
    const plansDir = join(repo.dir, ".plans");
    await writeFile(join(plansDir, "plan.md"), "# Edited Plan\n");

    const content = await showPlan("plan.md", {}, repo.dir);

    expect(content).toBe("# Edited Plan\n");
  });

  test("ls returns list of committed files", async () => {
    await writePlanFile(repo.dir, "other.md", "other");

    const files = await listPlans(undefined, repo.dir);

    expect(files.sort()).toEqual(["other.md", "plan.md"]);
  });

  test("ls returns uncommitted files in .plans/", async () => {
    const plansDir = join(repo.dir, ".plans");
    await writeFile(join(plansDir, "draft.md"), "work in progress");

    const files = await listPlans(undefined, repo.dir);

    expect(files).toContain("draft.md");
  });

  test("ls with subdirectory scope works", async () => {
    await writePlanFile(repo.dir, "research/notes.md", "notes");

    const files = await listPlans("research", repo.dir);

    expect(files).toEqual(["research/notes.md"]);
  });

  test("log returns entries with hash, date, message", async () => {
    const entries = await getPlanLog(undefined, 20, repo.dir);

    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[0];
    if (!entry) throw new Error("Expected at least one log entry");
    expect(entry.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(new Date(entry.date).toString()).not.toBe("Invalid Date");
  });

  test("log with file filter only shows commits for that file", async () => {
    await writePlanFile(repo.dir, "other.md", "other", "Add other");

    const entries = await getPlanLog("other.md", 20, repo.dir);

    expect(entries.map((e) => e.message)).toEqual(["Add other"]);
  });

  test("log respects limit", async () => {
    await writePlanFile(repo.dir, "plan.md", "v2", "Update plan");
    await writePlanFile(repo.dir, "plan.md", "v3", "Update plan again");

    const entries = await getPlanLog(undefined, 1, repo.dir);

    expect(entries.length).toBe(1);
    const entry = entries[0];
    if (!entry) throw new Error("Expected a log entry");
    expect(entry.message).toBe("Update plan again");
  });

  test("diff shows uncommitted changes against HEAD", async () => {
    const plansDir = join(repo.dir, ".plans");
    await writeFile(join(plansDir, "plan.md"), "# My Plan\n\nNew local content.\n");

    const diffOutput = await diffPlan("plan.md", repo.dir);

    expect(diffOutput).toContain("New local content.");
  });

  test("diff with no uncommitted changes returns empty output", async () => {
    const diffOutput = await diffPlan("plan.md", repo.dir);

    expect(diffOutput).toBe("");
  });

  test("diff without file argument shows all uncommitted changes", async () => {
    const plansDir = join(repo.dir, ".plans");
    await writeFile(join(plansDir, "plan.md"), "# Changed\n");

    const diffOutput = await diffPlan(undefined, repo.dir);

    expect(diffOutput).toContain("Changed");
  });
});
