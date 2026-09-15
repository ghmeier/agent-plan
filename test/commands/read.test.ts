import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diffPlan } from "../../src/commands/diff";
import { getPlanLog } from "../../src/commands/log";
import { listPlans } from "../../src/commands/ls";
import { showPlan } from "../../src/commands/show";
import { GitPlumbing } from "../../src/lib/git";
import { createTestRepo, type TestRepo } from "../helpers";

describe("read commands", () => {
  let repo: TestRepo;
  let git: GitPlumbing;

  beforeEach(async () => {
    repo = await createTestRepo();
    git = new GitPlumbing(repo.dir);
    await git.createOrphanBranch();
    await git.writeFiles([{ path: "plan.md", content: "# My Plan\n" }], "Add plan");
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("show returns file content", async () => {
    const content = await showPlan("plan.md", {}, repo.dir);

    expect(content).toBe("# My Plan\n");
  });

  test("show with --version returns historical content", async () => {
    const oldLog = await git.getLog("plan.md");
    const oldVersion = oldLog[0]?.hash;

    await git.writeFiles([{ path: "plan.md", content: "# Updated Plan\n" }], "Update plan");

    const historical = await showPlan("plan.md", { version: oldVersion }, repo.dir);
    const current = await showPlan("plan.md", {}, repo.dir);

    expect(historical).toBe("# My Plan");
    expect(current).toBe("# Updated Plan\n");
  });

  test("show nonexistent file gives error", async () => {
    expect(showPlan("missing.md", {}, repo.dir)).rejects.toThrow();
  });

  test("ls returns list of files", async () => {
    await git.writeFiles([{ path: "other.md", content: "other" }], "Add other");

    const files = await listPlans(undefined, repo.dir);

    expect(files.sort()).toEqual(["other.md", "plan.md"]);
  });

  test("ls with subdirectory scope works", async () => {
    await git.writeFiles([{ path: "research/notes.md", content: "notes" }], "Add research notes");

    const files = await listPlans("research", repo.dir);

    expect(files).toEqual(["research/notes.md"]);
  });

  test("log returns entries with hash, date, message", async () => {
    const entries = await getPlanLog(undefined, 20, repo.dir);

    expect(entries.length).toBe(2);
    const entry = entries[0];
    if (!entry) throw new Error("Expected at least one log entry");
    expect(entry.message).toBe("Add plan");
    expect(entry.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(new Date(entry.date).toString()).not.toBe("Invalid Date");
  });

  test("log with file filter only shows commits for that file", async () => {
    await git.writeFiles([{ path: "other.md", content: "other" }], "Add other");

    const entries = await getPlanLog("other.md", 20, repo.dir);

    expect(entries.map((entry) => entry.message)).toEqual(["Add other"]);
  });

  test("log respects limit", async () => {
    await git.writeFiles([{ path: "plan.md", content: "v2" }], "Update plan");
    await git.writeFiles([{ path: "plan.md", content: "v3" }], "Update plan again");

    const entries = await getPlanLog(undefined, 1, repo.dir);

    expect(entries.length).toBe(1);
    const entry = entries[0];
    if (!entry) throw new Error("Expected a log entry");
    expect(entry.message).toBe("Update plan again");
  });

  test("diff shows changes between local file and plans branch version", async () => {
    const localPath = join(repo.dir, "plan.md");
    await writeFile(localPath, "# My Plan\n\nNew local content.\n");

    const diffOutput = await diffPlan(localPath, repo.dir);

    expect(diffOutput).toContain("New local content.");
  });

  test("diff with no changes returns empty output", async () => {
    const localPath = join(repo.dir, "plan.md");
    await writeFile(localPath, "# My Plan\n");

    const diffOutput = await diffPlan(localPath, repo.dir);

    expect(diffOutput).toBe("");
  });
});
