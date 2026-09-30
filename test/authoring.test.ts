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

/** A shared pre-commit hook that rejects commits apl makes, leaving code commits alone. */
async function installRejectingPreCommitHook(repo: Repo): Promise<void> {
  const hookPath = join(repo.dir, ".git", "hooks", "pre-commit");
  await Bun.write(hookPath, '#!/bin/sh\n[ -n "$APL_INTERNAL" ] && exit 1\nexit 0\n');
  await chmod(hookPath, 0o755);
}

/**
 * Leaves `.plans/` mid-rebase with a conflict in `planPath`: two branches edit
 * the same line, and the plans branch is rebased onto the other.
 */
async function startConflictedRebase(repo: Repo, planPath: string): Promise<void> {
  await addPlan(repo, planPath, "# Base\n");
  await git(repo.plansDir, ["checkout", "-q", "-b", "theirs"]);
  await Bun.write(join(repo.plansDir, planPath), "# Theirs\n");
  await git(repo.plansDir, ["commit", "-q", "-am", "Theirs"]);
  await git(repo.plansDir, ["checkout", "-q", "plans"]);
  await Bun.write(join(repo.plansDir, planPath), "# Ours\n");
  await git(repo.plansDir, ["commit", "-q", "-am", "Ours"]);
  await run(["git", "rebase", "theirs"], repo.plansDir);
}

describe("apl add", () => {
  test("add stores a file and commits it with a default message", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.dir, "plan.md"), "# Plan\n");

    const result = await apl(repo.dir, ["add", "plan.md"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Added 1 file(s) to plans");
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
    expect(await planLogMessages(repo)).toEqual(["Add a.md, b.md", "Initialize plans"]);
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
    expect(await planLogMessages(repo)).toEqual(["Initialize plans"]);
  });

  test("add with a file already in .plans/ commits it in place", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.plansDir, "auth", "plan.md"), "# Plan\n");

    const result = await apl(repo.dir, ["add", ".plans/auth/plan.md"]);

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
    expect(await planLogMessages(repo)).toEqual(["Add plan.md", "Initialize plans"]);
  });

  test("add that fails to commit leaves nothing staged for the next commit", async () => {
    await using repo = await createInitializedRepo();
    await installRejectingPreCommitHook(repo);
    await Bun.write(join(repo.dir, "plan.md"), "# Plan\n");

    const add = await apl(repo.dir, ["add", "plan.md"]);

    expect(add.exitCode).not.toBe(0);
    expect(await git(repo.plansDir, ["diff", "--cached", "--name-only"])).toBe("");
  });

  test("add with a missing file fails without committing", async () => {
    await using repo = await createInitializedRepo();

    const result = await apl(repo.dir, ["add", "missing.md"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("File not found: missing.md");
    expect(await planLogMessages(repo)).toEqual(["Initialize plans"]);
  });
});

describe("editing plans in .plans/ and committing", () => {
  test("edits show up in diff until commit records them", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Plan\n");
    await Bun.write(join(repo.plansDir, "plan.md"), "# Plan\n\nNew step.\n");

    const before = await apl(repo.dir, ["diff"]);
    const commit = await apl(repo.dir, ["commit", "-m", "Add a step"]);
    const after = await apl(repo.dir, ["diff"]);

    expect(before.stdout).toContain("+New step.");
    expect(commit.exitCode).toBe(0);
    expect(commit.stdout).toContain("Committed plan changes");
    expect(after.stdout).toBe("No changes\n");
    expect(await planLogMessages(repo, ["-n", "1"])).toEqual(["Add a step"]);
  });

  test("commit records new and deleted files with a default message", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "old.md", "# Old\n");
    await rm(join(repo.plansDir, "old.md"));
    await Bun.write(join(repo.plansDir, "new.md"), "# New\n");

    await apl(repo.dir, ["commit"]);

    expect((await apl(repo.dir, ["ls", "--short"])).stdout).toBe("new.md\n");
    expect((await apl(repo.dir, ["diff"])).stdout).toBe("No changes\n");
    expect(await planLogMessages(repo, ["-n", "1"])).toEqual(["Update plans"]);
  });

  test("commit handles file names with spaces", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.plansDir, "my plan.md"), "---\ntitle: Mine\n---\n# Plan\n");

    await apl(repo.dir, ["commit"]);

    expect((await showMeta(repo, "my plan.md")).updated).toMatch(ISO_DATE);
    expect((await apl(repo.dir, ["diff"])).stdout).toBe("No changes\n");
  });

  test("commit refuses to run while a rebase in .plans/ is unfinished", async () => {
    await using repo = await createInitializedRepo();
    await startConflictedRebase(repo, "plan.md");

    const result = await apl(repo.dir, ["commit"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("A rebase is in progress");
    expect(await git(repo.plansDir, ["show", "HEAD:plan.md"])).not.toContain("<<<<<<<");
  });

  test("commit with no pending changes reports nothing to commit", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Plan\n");

    const result = await apl(repo.dir, ["commit"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Nothing to commit");
    expect(await planLogMessages(repo)).toEqual(["Add plan.md", "Initialize plans"]);
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
    await Bun.write(join(repo.plansDir, "plan.md"), "---\nbranch: feature/auth\npr: 42\n---\n");

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
    await Bun.write(join(repo.plansDir, "edited.md"), `${stale}# Edited\n`);
    await Bun.write(join(repo.plansDir, "untouched.md"), `${stale}# Untouched\n`);
    await git(repo.plansDir, ["add", "-A"]);
    await git(repo.plansDir, ["commit", "-m", "Seed plans with old dates"]);
    await Bun.write(join(repo.plansDir, "edited.md"), `${stale}# Edited again\n`);

    await apl(repo.dir, ["commit"]);

    const edited = await showMeta(repo, "edited.md");
    expect(edited.created).toBe("2020-01-01");
    expect(edited.updated).toMatch(ISO_DATE);
    expect(edited.updated).not.toBe("2020-01-01");
    expect((await showMeta(repo, "untouched.md")).updated).toBe("2020-01-01");
  });
});
