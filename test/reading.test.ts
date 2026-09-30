import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  addPlan,
  apl,
  createInitializedRepo,
  type LogEntry,
  planLogMessages,
  type Repo,
} from "./harness";

const CLI_PLAN = `---
title: CLI Tool
status: active
tags:
  - cli
  - ux
created: 2026-01-01
updated: 2026-01-02
---
# CLI plan
`;

const BUG_PLAN = `---
title: Bug Fix
status: draft
tags:
  - bug
---
# Bug fix plan
`;

const OLD_PLAN = `---
title: Old Plan
status: archived
tags:
  - cli
---
# Old plan
`;

async function createRepoWithTaggedPlans(): Promise<Repo> {
  const repo = await createInitializedRepo();
  await addPlan(repo, "cli.md", CLI_PLAN);
  await addPlan(repo, "bug.md", BUG_PLAN);
  await addPlan(repo, "archive/old.md", OLD_PLAN);
  return repo;
}

async function lsShort(repo: Repo, args: readonly string[] = []): Promise<string[]> {
  const result = await apl(repo.dir, ["ls", "--short", ...args]);
  return result.stdout.split("\n").filter((line) => line.endsWith(".md"));
}

describe("apl show", () => {
  test("show prints a metadata header followed by the body without frontmatter", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "cli.md"), CLI_PLAN);

    const result = await apl(repo.dir, ["show", "cli.md"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Title:   CLI Tool");
    expect(result.stdout).toContain("Status:  active");
    expect(result.stdout).toContain("Tags:    cli, ux");
    expect(result.stdout).toContain("Created: 2026-01-01");
    expect(result.stdout).toEndWith("# CLI plan\n");
    expect(result.stdout).not.toContain("---");
  });

  test("show prints a file without frontmatter as-is", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "plain.md"), "# Plain\n");

    const result = await apl(repo.dir, ["show", "plain.md"]);

    expect(result.stdout).toBe("# Plain\n");
  });

  test("show --raw prints the file exactly as stored", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "cli.md"), CLI_PLAN);

    const result = await apl(repo.dir, ["show", "cli.md", "--raw"]);

    expect(result.stdout).toBe(CLI_PLAN);
  });

  test("show --json returns the raw content, parsed metadata, and body", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "cli.md"), CLI_PLAN);

    const result = await apl(repo.dir, ["show", "cli.md", "--json"]);

    expect(JSON.parse(result.stdout)).toEqual({
      path: "cli.md",
      type: null,
      content: CLI_PLAN,
      meta: {
        title: "CLI Tool",
        status: "active",
        tags: ["cli", "ux"],
        created: "2026-01-01",
        updated: "2026-01-02",
      },
      body: "# CLI plan\n",
    });
  });

  test("show reads uncommitted edits from .apl/", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Committed\n");
    await Bun.write(join(repo.storeDir, "plan.md"), "# Uncommitted\n");

    const result = await apl(repo.dir, ["show", "plan.md", "--raw"]);

    expect(result.stdout).toBe("# Uncommitted\n");
  });

  test("show --at reads the file as of an earlier commit", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Version 1\n");
    const [firstAdd] = JSON.parse((await apl(repo.dir, ["log", "--json"])).stdout)
      .entries as LogEntry[];
    await addPlan(repo, "plan.md", "# Version 2\n");

    const byHash = await apl(repo.dir, ["show", "plan.md", "--raw", "--at", firstAdd?.hash ?? ""]);
    const byRelativeRef = await apl(repo.dir, ["show", "plan.md", "--raw", "--at", "HEAD~1"]);

    expect(byHash.stdout).toBe("# Version 1\n");
    expect(byRelativeRef.stdout).toBe("# Version 1\n");
  });

  test("show --version after the subcommand still prints the CLI version", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Plan\n");

    const result = await apl(repo.dir, ["show", "plan.md", "--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  test("show --at fails for a file that did not exist at that commit", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Plan\n");

    const result = await apl(repo.dir, ["show", "plan.md", "--at", "HEAD~1"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("File not found: plan.md at HEAD~1");
  });

  test("show finds a doc when the .md extension is left off", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "auth/plan.md", "# Plan\n");

    const result = await apl(repo.dir, ["show", "auth/plan", "--raw"]);

    expect(result.stdout).toBe("# Plan\n");
  });

  test("show with a directory suggests listing it", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "auth/plan.md", "# Plan\n");

    const result = await apl(repo.dir, ["show", "auth"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("apl ls auth");
  });

  test("show fails for a file that does not exist", async () => {
    await using repo = await createInitializedRepo();

    const result = await apl(repo.dir, ["show", "missing.md"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("File not found: missing.md");
  });

  test("show treats malformed frontmatter YAML as part of the body", async () => {
    await using repo = await createInitializedRepo();
    const content = "---\n: bad: yaml: [unclosed\n---\n# Body\n";
    await Bun.write(join(repo.storeDir, "plan.md"), content);

    const result = await apl(repo.dir, ["show", "plan.md", "--json"]);

    expect(JSON.parse(result.stdout)).toMatchObject({ meta: {}, body: content });
  });

  test("show warns about an unknown status and drops it from the metadata", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "plan.md"), "---\ntitle: Plan\nstatus: bogus\n---\n");

    const result = await apl(repo.dir, ["show", "plan.md"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Unknown status value "bogus"');
    expect(result.stdout).toContain("Title:   Plan");
    expect(result.stdout).not.toContain("Status:");
  });

  test("show --json stays parseable when a file has an unknown status", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "plan.md"), "---\ntitle: Plan\nstatus: bogus\n---\n");

    const result = await apl(repo.dir, ["show", "plan.md", "--json"]);

    expect(JSON.parse(result.stdout).meta).toEqual({ title: "Plan" });
    expect(result.stderr).toContain('Unknown status value "bogus"');
  });

  test("show --at with an unknown revision names the revision", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Plan\n");

    const result = await apl(repo.dir, ["show", "plan.md", "--at", "no-such-ref"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown revision: no-such-ref");
  });
});

describe("apl ls", () => {
  test("ls prints a table of file, title, status, and tags", async () => {
    await using repo = await createRepoWithTaggedPlans();

    const result = await apl(repo.dir, ["ls"]);

    const lines = result.stdout.trimEnd().split("\n");
    const today = new Date().toISOString().slice(0, 10);
    expect(lines[0]).toMatch(/^FILE\s+TYPE\s+TITLE\s+STATUS\s+UPDATED\s+TAGS\s*$/);
    expect(lines.slice(1).map((line) => line.split(/\s{2,}/).filter(Boolean))).toEqual([
      ["archive/old.md", "Old Plan", "archived", today, "cli"],
      ["bug.md", "Bug Fix", "draft", today, "bug"],
      ["cli.md", "CLI Tool", "active", today, "cli, ux"],
    ]);
  });

  test("ls lists the most recently updated docs first and undated docs last", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "older.md"), "---\nupdated: 2026-01-01\n---\n");
    await Bun.write(join(repo.storeDir, "newer.md"), "---\nupdated: 2026-03-01\n---\n");
    await Bun.write(join(repo.storeDir, "undated.md"), "# No frontmatter\n");

    expect(await lsShort(repo)).toEqual(["newer.md", "older.md", "undated.md"]);
  });

  test("ls --json returns each file with its metadata", async () => {
    await using repo = await createRepoWithTaggedPlans();

    const result = await apl(repo.dir, ["ls", "--json", "--tag", "ux"]);

    expect(JSON.parse(result.stdout).files).toMatchObject([
      {
        file: "cli.md",
        meta: { title: "CLI Tool", status: "active", tags: ["cli", "ux"], created: "2026-01-01" },
      },
    ]);
  });

  test("ls includes uncommitted files and files without frontmatter", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "committed.md", "# Committed\n");
    await Bun.write(join(repo.storeDir, "draft.md"), "# Draft\n");
    await Bun.write(join(repo.storeDir, "notes.txt"), "not markdown");

    expect(await lsShort(repo)).toEqual(["committed.md", "draft.md"]);
  });

  test("ls with a path lists only files under that directory", async () => {
    await using repo = await createRepoWithTaggedPlans();

    expect(await lsShort(repo, ["archive"])).toEqual(["archive/old.md"]);
  });

  test.each([
    { filter: ["--status", "active"], expected: ["cli.md"] },
    { filter: ["--status", "completed"], expected: [] },
    { filter: ["--tag", "cli"], expected: ["archive/old.md", "cli.md"] },
    { filter: ["--tag", "ux"], expected: ["cli.md"] },
    { filter: ["--status", "archived", "--tag", "cli"], expected: ["archive/old.md"] },
    { filter: ["--status", "active", "--tag", "bug"], expected: [] },
  ])("ls $filter matches $expected", async ({ filter, expected }) => {
    await using repo = await createRepoWithTaggedPlans();

    expect(await lsShort(repo, filter)).toEqual([...expected]);
  });

  test("ls reports when no files match", async () => {
    await using repo = await createRepoWithTaggedPlans();

    const result = await apl(repo.dir, ["ls", "--status", "completed"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No files found");
  });
});

describe("apl log", () => {
  test("log prints short hash, date, and message for each commit, newest first", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Plan\n", "Add plan");

    const result = await apl(repo.dir, ["log"]);

    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^[0-9a-f]{7} \d{4}-\d{2}-\d{2}T\S+ Add plan$/);
    expect(lines[1]).toEndWith(" Initialize docs");
  });

  test("log --json returns full commit details", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Plan\n", "Add plan");

    const result = await apl(repo.dir, ["log", "--json", "-n", "1"]);

    const { entries } = JSON.parse(result.stdout) as { entries: LogEntry[] };
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(entries[0]?.message).toBe("Add plan");
    expect(entries[0]?.author).toBe("Test");
    expect(Number.isNaN(Date.parse(entries[0]?.date ?? ""))).toBe(false);
  });

  test("log -n limits the number of entries", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "v1", "First");
    await addPlan(repo, "plan.md", "v2", "Second");

    expect(await planLogMessages(repo, ["-n", "1"])).toEqual(["Second"]);
  });

  test("log with a file shows only commits that touched it", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "v1", "Add plan");
    await addPlan(repo, "other.md", "other", "Add other");
    await addPlan(repo, "plan.md", "v2", "Update plan");

    expect(await planLogMessages(repo, ["plan.md"])).toEqual(["Update plan", "Add plan"]);
  });

  test("log reports when a file has no history", async () => {
    await using repo = await createInitializedRepo();

    const result = await apl(repo.dir, ["log", "missing.md"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No history found");
  });
});

describe("apl diff", () => {
  test("diff includes a new file that has never been committed", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "new plan.md"), "# New\n");

    const result = await apl(repo.dir, ["diff"]);

    expect(result.stdout).toContain("new plan.md");
    expect(result.stdout).toContain("+# New");
  });

  test("diff with a file shows only that file's changes", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Plan\n");
    await addPlan(repo, "other.md", "# Other\n");
    await Bun.write(join(repo.storeDir, "plan.md"), "# Plan, edited\n");
    await Bun.write(join(repo.storeDir, "other.md"), "# Other, edited\n");

    const result = await apl(repo.dir, ["diff", "plan.md"]);

    expect(result.stdout).toContain("+# Plan, edited");
    expect(result.stdout).not.toContain("other.md");
  });

  test("diff --json reports whether there are changes", async () => {
    await using repo = await createInitializedRepo();
    await addPlan(repo, "plan.md", "# Plan\n");

    const clean = JSON.parse((await apl(repo.dir, ["diff", "--json"])).stdout);
    await Bun.write(join(repo.storeDir, "plan.md"), "# Plan, edited\n");
    const edited = JSON.parse((await apl(repo.dir, ["diff", "plan.md", "--json"])).stdout);

    expect(clean).toEqual({ path: null, changed: false, diff: "" });
    expect(edited.path).toBe("plan.md");
    expect(edited.changed).toBe(true);
    expect(edited.diff).toContain("+# Plan, edited");
  });
});
