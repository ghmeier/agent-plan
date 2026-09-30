import { describe, expect, test } from "bun:test";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { apl, createInitializedRepo, createRepo, createTempDir, git } from "./harness";

describe("apl init", () => {
  test("init creates a usable plans directory that the code repo ignores", async () => {
    await using repo = await createRepo();

    const result = await apl(repo.dir, ["init"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Initialized doc storage on branch 'apl'");
    await Bun.write(join(repo.storeDir, "plan.md"), "# Plan\n");
    expect(await git(repo.dir, ["status", "--porcelain"])).toBe("");
    expect((await apl(repo.dir, ["ls", "--short"])).stdout).toBe("plan.md\n");
  });

  test("init from a subdirectory sets up plans at the repo root", async () => {
    await using repo = await createRepo();
    const subdir = join(repo.dir, "src", "nested");
    await mkdir(subdir, { recursive: true });

    const result = await apl(subdir, ["init"]);

    expect(result.exitCode).toBe(0);
    expect((await apl(repo.dir, ["ls", "--short"])).exitCode).toBe(0);
    expect((await lstat(repo.storeDir)).isSymbolicLink()).toBe(true);
  });

  test("init on an initialized repo reports it and keeps existing plans", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.dir, "plan.md"), "# Plan\n");
    await apl(repo.dir, ["add", "plan.md"]);

    const result = await apl(repo.dir, ["init"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already initialized");
    expect((await apl(repo.dir, ["show", "plan.md", "--raw"])).stdout).toBe("# Plan\n");
  });

  test("init with --branch stores plans on that branch for later commands", async () => {
    await using repo = await createRepo();
    await apl(repo.dir, ["init", "--branch", "notes"]);
    await Bun.write(join(repo.dir, "plan.md"), "# Plan\n");

    const result = await apl(repo.dir, ["add", "plan.md"]);

    expect(result.exitCode).toBe(0);
    expect(await git(repo.dir, ["show", "notes:plan.md"])).toBe("# Plan");
    expect(await git(repo.dir, ["branch", "--list", "apl"])).toBe("");
  });

  test("init stores no config or other files on the plans branch", async () => {
    await using repo = await createRepo();

    await apl(repo.dir, ["init"]);

    expect(await git(repo.dir, ["ls-tree", "-r", "--name-only", "apl"])).toBe("");
  });

  test("init moves files from an existing .apl directory into doc storage", async () => {
    await using repo = await createRepo();
    await Bun.write(join(repo.storeDir, "notes.md"), "my notes");

    const result = await apl(repo.dir, ["init"]);

    expect(result.exitCode).toBe(0);
    expect((await lstat(repo.storeDir)).isSymbolicLink()).toBe(true);
    expect((await apl(repo.dir, ["show", "notes.md", "--raw"])).stdout).toBe("my notes");
  });

  test("init explains how to free a docs branch that another worktree has checked out", async () => {
    await using repo = await createRepo();
    await using elsewhere = await createTempDir();
    await git(repo.dir, ["worktree", "add", "-b", "apl", join(elsewhere.dir, "old")]);

    const result = await apl(repo.dir, ["init"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Branch 'apl' is already checked out at");
    expect(result.stderr).toContain("git worktree remove");
  });

  test("init outside a git repo fails with an explanation", async () => {
    await using temp = await createTempDir();

    const result = await apl(temp.dir, ["init"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Not a git repository");
  });
});

describe("commands before init", () => {
  test.each([
    { args: ["add", "plan.md"] },
    { args: ["ls"] },
    { args: ["show", "plan.md"] },
    { args: ["log"] },
    { args: ["diff"] },
    { args: ["sync"] },
  ])("apl $args fails and tells the user to run apl init", async ({ args }) => {
    await using repo = await createRepo();
    await Bun.write(join(repo.dir, "plan.md"), "# Plan\n");

    const result = await apl(repo.dir, args);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Run 'apl init' first");
  });
});
