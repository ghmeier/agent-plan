import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { addPlan, apl, createInitializedRepo, git, planLogMessages, type Repo } from "./harness";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function showRaw(repo: Repo, planPath: string): Promise<string> {
  return (await apl(repo.dir, ["show", planPath, "--raw"])).stdout;
}

async function showMeta(repo: Repo, planPath: string): Promise<Record<string, unknown>> {
  return JSON.parse((await apl(repo.dir, ["show", planPath, "--json"])).stdout).meta;
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
