import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "../../src/lib/git";

async function createTestRepo() {
  const dir = await mkdtemp(join(tmpdir(), "plan-test-"));
  await Bun.spawn(["git", "init"], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: dir }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: dir }).exited;
  // Create an initial commit so HEAD exists.
  await writeFile(join(dir, ".gitkeep"), "");
  await Bun.spawn(["git", "add", ".gitkeep"], { cwd: dir }).exited;
  await Bun.spawn(["git", "commit", "-m", "Initial commit"], {
    cwd: dir,
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("Git", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let git: Git;

  beforeEach(async () => {
    ({ dir, cleanup } = await createTestRepo());
    git = new Git(dir, "plans");
  });

  afterEach(async () => {
    await cleanup();
  });

  test("exec returns trimmed stdout from a git command", async () => {
    const output = await git.exec(["rev-parse", "--abbrev-ref", "HEAD"]);

    expect(output).not.toMatch(/\s$/);
    expect(output.length).toBeGreaterThan(0);
  });

  test("exec throws on a non-zero exit", async () => {
    expect(git.exec(["not-a-real-command"])).rejects.toThrow();
  });

  test("branchExists returns false before creation and true after", async () => {
    expect(await git.branchExists()).toBe(false);

    await git.createOrphanBranch();

    expect(await git.branchExists()).toBe(true);
  });

  test("createOrphanBranch creates a branch with no files", async () => {
    await git.createOrphanBranch();

    const files = await git.exec(["ls-tree", "-r", "--name-only", "plans"]);
    expect(files).toBe("");
  });
});
