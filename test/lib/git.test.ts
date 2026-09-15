import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitPlumbing } from "../../src/lib/git";
import { initTestPlans, writePlanFile } from "../helpers";

async function createTestRepo() {
  const dir = await mkdtemp(join(tmpdir(), "plan-test-"));
  const proc = Bun.spawn(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: dir }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: dir }).exited;
  // Create an initial commit so HEAD exists.
  await writeFile(join(dir, ".gitkeep"), "");
  await Bun.spawn(["git", "add", ".gitkeep"], { cwd: dir }).exited;
  await Bun.spawn(["git", "commit", "-m", "Initial commit"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("GitPlumbing", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let git: GitPlumbing;

  beforeEach(async () => {
    ({ dir, cleanup } = await createTestRepo());
    git = new GitPlumbing(dir, "plans");
  });

  afterEach(async () => {
    await cleanup();
  });

  test("branchExists returns false before creation and true after", async () => {
    expect(await git.branchExists()).toBe(false);

    await git.createOrphanBranch();

    expect(await git.branchExists()).toBe(true);
  });

  test("createOrphanBranch creates a branch with no files", async () => {
    await git.createOrphanBranch();

    const files = await git.listFiles();
    expect(files).toEqual([]);
  });

  test("listFiles returns committed files", async () => {
    await initTestPlans(dir);
    await writePlanFile(dir, "note.md", "hello");

    const files = await git.listFiles();
    expect(files).toContain("note.md");
  });

  test("readFile returns committed content", async () => {
    await initTestPlans(dir);
    await writePlanFile(dir, "hello.md", "# Hello Plan\n\nSome content here.\n");

    const content = await git.readFile("hello.md");
    expect(content).toBe("# Hello Plan\n\nSome content here.\n");
  });

  test("readFile on nonexistent file throws", async () => {
    await git.createOrphanBranch();

    expect(git.readFile("missing.md")).rejects.toThrow();
  });

  test("getLog returns entries in reverse chronological order with correct fields", async () => {
    await initTestPlans(dir);
    await writePlanFile(dir, "a.md", "a1", "First commit");
    await writePlanFile(dir, "a.md", "a2", "Second commit");

    const log = await git.getLog();

    expect(log.length).toBeGreaterThanOrEqual(2);
    const messages = log.map((e) => e.message);
    expect(messages.indexOf("Second commit")).toBeLessThan(messages.indexOf("First commit"));

    for (const entry of log) {
      expect(entry.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.author).toBe("Test");
      expect(new Date(entry.date).toString()).not.toBe("Invalid Date");
    }
  });

  test("getLog respects a limit", async () => {
    await initTestPlans(dir);
    await writePlanFile(dir, "a.md", "a1", "First");
    await writePlanFile(dir, "a.md", "a2", "Second");

    const log = await git.getLog(undefined, 1);

    expect(log.length).toBe(1);
    const [first] = log;
    if (!first) throw new Error("Expected a log entry");
    expect(first.message).toBe("Second");
  });
});
