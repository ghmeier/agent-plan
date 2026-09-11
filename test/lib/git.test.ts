import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitPlumbing } from "../../src/lib/git";

async function createTestRepo() {
  const dir = await mkdtemp(join(tmpdir(), "plan-test-"));
  const proc = Bun.spawn(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: dir }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: dir }).exited;
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function commitOnMain(dir: string) {
  await writeFile(join(dir, "PLAN.md"), "# main plan\n");
  await Bun.spawn(["git", "add", "PLAN.md"], { cwd: dir }).exited;
  const proc = Bun.spawn(["git", "commit", "-m", "Add PLAN.md"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
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

  test("createOrphanBranch creates a branch independent of main", async () => {
    await commitOnMain(dir);

    await git.createOrphanBranch();

    const files = await git.listFiles();
    expect(files).toEqual([]);

    const mainProc = Bun.spawn(["git", "log", "--oneline", "main"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const mainLog = await new Response(mainProc.stdout).text();
    await mainProc.exited;
    expect(mainLog).toContain("Add PLAN.md");

    const plansProc = Bun.spawn(["git", "log", "--oneline", "plans"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const plansLog = await new Response(plansProc.stdout).text();
    await plansProc.exited;
    expect(plansLog).not.toContain("Add PLAN.md");
    expect(plansLog).toContain("Initialize plans");
  });

  test("writeFiles then readFile round-trips content", async () => {
    await git.createOrphanBranch();

    const content = "# Hello Plan\n\nSome content here.\n";
    await git.writeFiles([{ path: "hello.md", content }], "Add hello.md");

    const readBack = await git.readFile("hello.md");
    expect(readBack).toBe(content);
  });

  test("writeFiles with multiple files makes listFiles return all of them", async () => {
    await git.createOrphanBranch();

    await git.writeFiles(
      [
        { path: "one.md", content: "one" },
        { path: "two.md", content: "two" },
      ],
      "Add two files",
    );

    const files = await git.listFiles();
    expect(files.sort()).toEqual(["one.md", "two.md"]);
  });

  test("writeFiles called twice overwrites a file", async () => {
    await git.createOrphanBranch();

    await git.writeFiles([{ path: "note.md", content: "first version" }], "Add note");
    await git.writeFiles([{ path: "note.md", content: "second version" }], "Update note");

    const content = await git.readFile("note.md");
    expect(content).toBe("second version");

    const files = await git.listFiles();
    expect(files).toEqual(["note.md"]);
  });

  test("writeFiles with a nested path works", async () => {
    await git.createOrphanBranch();

    await git.writeFiles(
      [{ path: "research/notes.md", content: "nested content" }],
      "Add nested notes",
    );

    const content = await git.readFile("research/notes.md");
    expect(content).toBe("nested content");

    const files = await git.listFiles();
    expect(files).toEqual(["research/notes.md"]);

    const scoped = await git.listFiles("research");
    expect(scoped).toEqual(["research/notes.md"]);
  });

  test("getLog returns entries in reverse chronological order with correct fields", async () => {
    await git.createOrphanBranch();

    await git.writeFiles([{ path: "a.md", content: "a1" }], "First commit");
    await git.writeFiles([{ path: "a.md", content: "a2" }], "Second commit");

    const log = await git.getLog();

    expect(log.length).toBe(3);
    expect(log[0].message).toBe("Second commit");
    expect(log[1].message).toBe("First commit");
    expect(log[2].message).toBe("Initialize plans");

    for (const entry of log) {
      expect(entry.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.author).toBe("Test");
      expect(new Date(entry.date).toString()).not.toBe("Invalid Date");
    }
  });

  test("getLog with path filter returns only commits touching that file", async () => {
    await git.createOrphanBranch();

    await git.writeFiles([{ path: "a.md", content: "a1" }], "Add a.md");
    await git.writeFiles([{ path: "b.md", content: "b1" }], "Add b.md");
    await git.writeFiles([{ path: "a.md", content: "a2" }], "Update a.md");

    const log = await git.getLog("a.md");

    expect(log.map((entry) => entry.message)).toEqual(["Update a.md", "Add a.md"]);
  });

  test("getLog respects a limit", async () => {
    await git.createOrphanBranch();
    await git.writeFiles([{ path: "a.md", content: "a1" }], "First");
    await git.writeFiles([{ path: "a.md", content: "a2" }], "Second");

    const log = await git.getLog(undefined, 1);

    expect(log.length).toBe(1);
    expect(log[0].message).toBe("Second");
  });

  test("readFile on nonexistent file throws", async () => {
    await git.createOrphanBranch();

    expect(git.readFile("missing.md")).rejects.toThrow();
  });

  test("diff shows changes between local file and branch version", async () => {
    await git.createOrphanBranch();
    await git.writeFiles([{ path: "diffme.md", content: "line one\nline two\n" }], "Add diffme");

    const localPath = join(dir, "local-diffme.md");
    await writeFile(localPath, "line one\nline changed\n");

    const diffOutput = await git.diff("diffme.md", localPath);

    expect(diffOutput).toContain("line two");
    expect(diffOutput).toContain("line changed");
  });

  test("diff is empty when local file matches branch version", async () => {
    await git.createOrphanBranch();
    await git.writeFiles([{ path: "same.md", content: "identical\n" }], "Add same");

    const localPath = join(dir, "local-same.md");
    await writeFile(localPath, "identical\n");

    const diffOutput = await git.diff("same.md", localPath);

    expect(diffOutput).toBe("");
  });
});
