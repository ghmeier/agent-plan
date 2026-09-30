import { describe, expect, test } from "bun:test";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  addPlan,
  apl,
  createInitializedRepo,
  createTempDir,
  git,
  planLogMessages,
  type Repo,
  run,
} from "./harness";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function showRaw(repo: Repo, planPath: string): Promise<string> {
  return (await apl(repo.dir, ["show", planPath, "--raw"])).stdout;
}

async function showMeta(repo: Repo, planPath: string): Promise<Record<string, unknown>> {
  return JSON.parse((await apl(repo.dir, ["show", planPath, "--json"])).stdout).meta;
}

/** Hooks that fail every commit and push, like code-only hooks would in the store. */
async function installFailingCodeHooks(repo: Repo): Promise<void> {
  for (const hook of ["pre-commit", "pre-push"]) {
    const hookPath = join(repo.dir, ".git", "hooks", hook);
    await Bun.write(hookPath, "#!/bin/sh\necho 'code checks failed' >&2\nexit 1\n");
    await chmod(hookPath, 0o755);
  }
}

/**
 * Leaves `.apl/` mid-rebase with a conflict in `planPath`: two branches edit
 * the same line, and the docs branch is rebased onto the other.
 */
async function startConflictedRebase(repo: Repo, planPath: string): Promise<void> {
  await addPlan(repo, planPath, "# Base\n");
  await git(repo.storeDir, ["checkout", "-q", "-b", "theirs"]);
  await Bun.write(join(repo.storeDir, planPath), "# Theirs\n");
  await git(repo.storeDir, ["commit", "-q", "-am", "Theirs"]);
  await git(repo.storeDir, ["checkout", "-q", "apl"]);
  await Bun.write(join(repo.storeDir, planPath), "# Ours\n");
  await git(repo.storeDir, ["commit", "-q", "-am", "Ours"]);
  await run(["git", "rebase", "theirs"], repo.storeDir);
}

describe("apl add", () => {
  test("add stores a file and commits it with a default message", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.dir, "plan.md"), "# Plan\n");

    const result = await apl(repo.dir, ["add", "plan.md"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Added 1 file(s) to docs");
    expect(await showRaw(repo, "plan.md")).toBe("# Plan\n");
    expect(await planLogMessages(repo, ["-n", "1"])).toEqual(["Add plan.md"]);
  });

  test("add with several files stores them all in one commit", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.dir, "a.md"), "# A\n");
    await Bun.write(join(repo.dir, "b.md"), "# B\n");

    await apl(repo.dir, ["add", "a.md", "b.md"]);

    expect(await showRaw(repo, "a.md")).toBe("# A\n");
    expect(await showRaw(repo, "b.md")).toBe("# B\n");
    expect(await planLogMessages(repo)).toEqual(["Add a.md, b.md", "Initialize docs"]);
  });

  test("add with -m uses the given commit message", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.dir, "plan.md"), "# Plan\n");

    await apl(repo.dir, ["add", "plan.md", "-m", "Draft auth plan"]);

    expect(await planLogMessages(repo, ["-n", "1"])).toEqual(["Draft auth plan"]);
  });

  test("add from a subdirectory stores the file at its repo-relative path", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.dir, "docs", "research", "notes.md"), "# Notes\n");

    await apl(join(repo.dir, "docs"), ["add", "research/notes.md"]);

    expect((await apl(repo.dir, ["ls", "--short"])).stdout).toBe("docs/research/notes.md\n");
  });

  test("add with an absolute path stores the file at its repo-relative path", async () => {
    await using repo = await createInitializedRepo();
    const absolutePath = join(repo.dir, "docs", "plan.md");
    await Bun.write(absolutePath, "# Plan\n");

    await apl(repo.dir, ["add", absolutePath]);

    expect(await showRaw(repo, "docs/plan.md")).toBe("# Plan\n");
  });

  test("adding an existing plan again replaces its content and keeps other plans", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "keep.md", "# Keep\n");
    await addPlan(repo, "plan.md", "# Version 1\n");

    await addPlan(repo, "plan.md", "# Version 2\n");

    expect(await showRaw(repo, "plan.md")).toBe("# Version 2\n");
    expect(await showRaw(repo, "keep.md")).toBe("# Keep\n");
  });

  test("add with a file outside the repo fails without committing", async () => {
    await using repo = await createInitializedRepo();
    await using outside = await createTempDir();
    const outsidePath = join(outside.dir, "plan.md");
    await Bun.write(outsidePath, "# Plan\n");

    const result = await apl(repo.dir, ["add", outsidePath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is outside the repository");
    expect(await planLogMessages(repo)).toEqual(["Initialize docs"]);
  });

  test("add with a file already in .apl/ commits it in place", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "auth", "plan.md"), "# Plan\n");

    const result = await apl(repo.dir, ["add", ".apl/auth/plan.md"]);

    expect(result.exitCode).toBe(0);
    expect((await apl(repo.dir, ["ls", "--short"])).stdout).toBe("auth/plan.md\n");
    expect(await planLogMessages(repo, ["-n", "1"])).toEqual(["Add auth/plan.md"]);
  });

  test("add with unchanged content reports nothing to commit", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Plan\n");

    const result = await apl(repo.dir, ["add", "plan.md"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("nothing to commit");
    expect(await planLogMessages(repo)).toEqual(["Add plan.md", "Initialize docs"]);
  });

  test("add that fails to commit leaves nothing staged for the next commit", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.dir, "plan.md"), "# Plan\n");

    const add = await apl(repo.dir, ["add", "plan.md"], { env: { GIT_AUTHOR_DATE: "not a date" } });

    expect(add.exitCode).not.toBe(0);
    expect(await git(repo.storeDir, ["diff", "--cached", "--name-only"])).toBe("");
  });

  test("add with a missing file fails without committing", async () => {
    await using repo = await createInitializedRepo();

    const result = await apl(repo.dir, ["add", "missing.md"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("File not found: missing.md");
    expect(await planLogMessages(repo)).toEqual(["Initialize docs"]);
  });
});

describe("editing plans in .apl/ and committing", () => {
  test("edits show up in diff until commit records them", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Plan\n");
    await Bun.write(join(repo.storeDir, "plan.md"), "# Plan\n\nNew step.\n");

    const before = await apl(repo.dir, ["diff"]);
    const commit = await apl(repo.dir, ["commit", "-m", "Add a step"]);
    const after = await apl(repo.dir, ["diff"]);

    expect(before.stdout).toContain("+New step.");
    expect(commit.exitCode).toBe(0);
    expect(commit.stdout).toContain("Committed doc changes");
    expect(after.stdout).toBe("No changes\n");
    expect(await planLogMessages(repo, ["-n", "1"])).toEqual(["Add a step"]);
  });

  test("commit records new and deleted files with a message naming them", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "old.md", "# Old\n");
    await rm(join(repo.storeDir, "old.md"));
    await Bun.write(join(repo.storeDir, "new.md"), "# New\n");

    await apl(repo.dir, ["commit"]);

    expect((await apl(repo.dir, ["ls", "--short"])).stdout).toBe("new.md\n");
    expect((await apl(repo.dir, ["diff"])).stdout).toBe("No changes\n");
    expect(await planLogMessages(repo, ["-n", "1"])).toEqual(["Update new.md, old.md"]);
  });

  test("commit's default message names the first three files and counts the rest", async () => {
    await using repo = await createInitializedRepo();
    for (const name of ["a", "b", "c", "d", "e"]) {
      await Bun.write(join(repo.storeDir, `${name}.md`), `# ${name}\n`);
    }

    await apl(repo.dir, ["commit"]);

    expect(await planLogMessages(repo, ["-n", "1"])).toEqual([
      "Update a.md, b.md, c.md and 2 more",
    ]);
  });

  test("add and commit skip the code repo's git hooks", async () => {
    await using repo = await createInitializedRepo();
    await installFailingCodeHooks(repo);
    await Bun.write(join(repo.dir, "added.md"), "# Added\n");
    await Bun.write(join(repo.storeDir, "edited.md"), "# Edited\n");

    const add = await apl(repo.dir, ["add", "added.md"]);
    const commit = await apl(repo.dir, ["commit"]);

    expect(add.exitCode).toBe(0);
    expect(commit.exitCode).toBe(0);
    expect(await planLogMessages(repo, ["-n", "2"])).toEqual(["Update edited.md", "Add added.md"]);
  });

  test("commit leaves files over 1 MB uncommitted and says so", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "data.json"), "x".repeat(2 * 1024 * 1024));
    await Bun.write(join(repo.storeDir, "notes.md"), "# Notes\n");

    const result = await apl(repo.dir, ["commit"]);

    expect(result.stderr).toContain("Not committing files over 1 MB: data.json");
    expect(await git(repo.storeDir, ["ls-files"])).toBe("notes.md");
    expect(await Bun.file(join(repo.storeDir, "data.json")).exists()).toBe(true);
  });

  test("commit handles file names with spaces", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "my plan.md"), "---\ntitle: Mine\n---\n# Plan\n");

    await apl(repo.dir, ["commit"]);

    expect((await showMeta(repo, "my plan.md")).updated).toMatch(ISO_DATE);
    expect((await apl(repo.dir, ["diff"])).stdout).toBe("No changes\n");
  });

  test("commit refuses to run while a rebase in .apl/ is unfinished", async () => {
    await using repo = await createInitializedRepo();
    await startConflictedRebase(repo, "plan.md");

    const result = await apl(repo.dir, ["commit"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("A rebase is in progress");
    expect(await git(repo.storeDir, ["show", "HEAD:plan.md"])).not.toContain("<<<<<<<");
  });

  test("commit with no pending changes reports nothing to commit", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Plan\n");

    const result = await apl(repo.dir, ["commit"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Nothing to commit");
    expect(await planLogMessages(repo)).toEqual(["Add plan.md", "Initialize docs"]);
  });
});

describe("frontmatter timestamps", () => {
  test("add sets created and updated on a file with frontmatter but no dates", async () => {
    await using repo = await createInitializedRepo();

    await addPlan(repo, "plan.md", "---\ntitle: Plan\n---\n# Plan\n");

    const meta = await showMeta(repo, "plan.md");
    expect(meta.created).toMatch(ISO_DATE);
    expect(meta.updated).toBe(meta.created);
  });

  test("add refreshes updated but keeps an existing created date", async () => {
    await using repo = await createInitializedRepo();

    await addPlan(repo, "plan.md", "---\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n# Plan\n");

    const meta = await showMeta(repo, "plan.md");
    expect(meta.created).toBe("2020-01-01");
    expect(meta.updated).toMatch(ISO_DATE);
    expect(meta.updated).not.toBe("2020-01-01");
  });

  test("add changes only the date lines and keeps other keys, comments, and formatting", async () => {
    await using repo = await createInitializedRepo();
    const frontmatter =
      "title: Plan  # working title\ntags: [auth, backend]\nowner: sam\nstatus: bogus";

    await addPlan(repo, "plan.md", `---\n${frontmatter}\nupdated: 2020-01-01\n---\n# Plan\n`);

    const stored = await showRaw(repo, "plan.md");
    expect(stored).toStartWith(`---\n${frontmatter}\nupdated: `);
    expect(stored).toMatch(/\ncreated: \d{4}-\d{2}-\d{2}\n---\n# Plan\n$/);
  });

  test("commit keeps frontmatter keys apl doesn't know about", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "plan.md"), "---\nbranch: feature/auth\npr: 42\n---\n");

    await apl(repo.dir, ["commit"]);

    const stored = await showRaw(repo, "plan.md");
    expect(stored).toContain("branch: feature/auth\npr: 42\n");
  });

  test("add stores a file without frontmatter byte for byte", async () => {
    await using repo = await createInitializedRepo();
    const content = "# Plain markdown\n\nNo frontmatter.";

    await addPlan(repo, "plain.md", content);

    expect(await showRaw(repo, "plain.md")).toBe(content);
  });

  test("commit refreshes updated on edited files and leaves unchanged files alone", async () => {
    await using repo = await createInitializedRepo();
    const stale = "---\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n";
    await Bun.write(join(repo.storeDir, "edited.md"), `${stale}# Edited\n`);
    await Bun.write(join(repo.storeDir, "untouched.md"), `${stale}# Untouched\n`);
    await git(repo.storeDir, ["add", "-A"]);
    await git(repo.storeDir, ["commit", "-m", "Seed plans with old dates"]);
    await Bun.write(join(repo.storeDir, "edited.md"), `${stale}# Edited again\n`);

    await apl(repo.dir, ["commit"]);

    const edited = await showMeta(repo, "edited.md");
    expect(edited.created).toBe("2020-01-01");
    expect(edited.updated).toMatch(ISO_DATE);
    expect(edited.updated).not.toBe("2020-01-01");
    expect((await showMeta(repo, "untouched.md")).updated).toBe("2020-01-01");
  });
});
