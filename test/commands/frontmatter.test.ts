import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path, { join } from "node:path";
import { addPlans } from "../../src/commands/add";
import { listPlans } from "../../src/commands/ls";
import { showPlan } from "../../src/commands/show";
import { parseFrontmatter, today } from "../../src/lib/frontmatter";
import { createTestRepoWithPlans, gitExec, type TestRepo, writePlanFile } from "../helpers";

/** Reads a plan file's content as committed on the plans branch, not just what's on disk. */
async function readCommittedPlan(repoDir: string, planPath: string): Promise<string> {
  return gitExec(join(repoDir, ".plans"), ["show", `HEAD:${planPath}`]);
}

// Redirects console.log output to a captured string so tests can inspect
// what commands would have printed without cluttering test output.
function captureStdout(fn: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  let output = "";
  console.log = (...args: unknown[]) => {
    output += `${args.join(" ")}\n`;
  };
  return fn()
    .then(() => {
      console.log = originalLog;
      return output.trim();
    })
    .catch((e) => {
      console.log = originalLog;
      throw e;
    });
}

// Intercepts process.stdout.write so tests can read raw output from showPlan.
function captureStdoutWrite(fn: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let output = "";
  process.stdout.write = (chunk: unknown, ..._rest: unknown[]): boolean => {
    output += String(chunk);
    return true;
  };
  return fn()
    .then(() => {
      process.stdout.write = original;
      return output;
    })
    .catch((e) => {
      process.stdout.write = original;
      throw e;
    });
}

const FRONTMATTER_ACTIVE_CLI = `---
title: CLI Tool
status: active
tags:
  - cli
  - ux
---
# CLI plan
`;

const FRONTMATTER_DRAFT_BUG = `---
title: Bug Fix
status: draft
tags:
  - bug
---
# Bug fix plan
`;

const FRONTMATTER_ARCHIVED = `---
title: Old Plan
status: archived
tags:
  - legacy
---
# Old plan
`;

describe("ls filters", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepoWithPlans();
    await writePlanFile(repo.dir, "cli.md", FRONTMATTER_ACTIVE_CLI, "Add cli");
    await writePlanFile(repo.dir, "bug.md", FRONTMATTER_DRAFT_BUG, "Add bug");
    await writePlanFile(repo.dir, "old.md", FRONTMATTER_ARCHIVED, "Add old");
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("--status filter returns only plans with the matching status", async () => {
    const files = await listPlans(undefined, repo.dir, { status: "active" });

    expect(files).toEqual(["cli.md"]);
  });

  test("--status filter returns nothing when no plan matches", async () => {
    const files = await listPlans(undefined, repo.dir, { status: "completed" });

    expect(files).toHaveLength(0);
  });

  test("--tag filter returns only plans containing that tag", async () => {
    const files = await listPlans(undefined, repo.dir, { tag: "cli" });

    expect(files).toEqual(["cli.md"]);
  });

  test("--tag filter matches plans with that tag among multiple tags", async () => {
    // cli.md has both "cli" and "ux" tags — filtering on "ux" must still find it.
    const files = await listPlans(undefined, repo.dir, { tag: "ux" });

    expect(files).toContain("cli.md");
    expect(files).not.toContain("bug.md");
  });

  test("combining --status and --tag filters with AND semantics", async () => {
    // Only cli.md matches both active AND cli.
    const files = await listPlans(undefined, repo.dir, { status: "active", tag: "cli" });

    expect(files).toEqual(["cli.md"]);
  });

  test("combining --status and --tag that match no plan returns empty", async () => {
    // No plan is both active AND tagged "bug".
    const files = await listPlans(undefined, repo.dir, { status: "active", tag: "bug" });

    expect(files).toHaveLength(0);
  });

  test("--short flag outputs filenames only without a table", async () => {
    const output = await captureStdout(async () => {
      await listPlans(undefined, repo.dir, { short: true });
    });

    // Table output has a FILE header; short output must not.
    expect(output).not.toContain("FILE");
    for (const f of ["cli.md", "bug.md", "old.md"]) {
      expect(output).toContain(f);
    }
  });

  test("ls --json includes meta fields per entry", async () => {
    const output = await captureStdout(async () => {
      await listPlans(undefined, repo.dir, { json: true });
    });

    const parsed = JSON.parse(output);
    const entry = parsed.files.find((e: { file: string }) => e.file === "cli.md");
    expect(entry).toBeDefined();
    expect(entry.meta.title).toBe("CLI Tool");
    expect(entry.meta.status).toBe("active");
    expect(entry.meta.tags).toContain("cli");
  });
});

describe("show --raw", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepoWithPlans();
    await writePlanFile(repo.dir, "plan.md", FRONTMATTER_ACTIVE_CLI, "Add plan");
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("--raw prints the file exactly as stored, including frontmatter fences", async () => {
    const output = await captureStdoutWrite(async () => {
      await showPlan("plan.md", { raw: true }, repo.dir);
    });

    expect(output).toBe(FRONTMATTER_ACTIVE_CLI);
  });

  test("default show omits the frontmatter fences and prints a header block", async () => {
    const logOutput = await captureStdout(async () => {
      await captureStdoutWrite(async () => {
        await showPlan("plan.md", {}, repo.dir);
      });
    });

    // The metadata header must contain the title, not the raw YAML fences.
    expect(logOutput).toContain("CLI Tool");
    expect(logOutput).not.toContain("---");
  });

  test("show --json includes both raw content and parsed meta", async () => {
    const output = await captureStdout(async () => {
      await showPlan("plan.md", { json: true }, repo.dir);
    });

    const parsed = JSON.parse(output);
    expect(parsed.path).toBe("plan.md");
    expect(parsed.content).toBe(FRONTMATTER_ACTIVE_CLI);
    expect(parsed.meta.title).toBe("CLI Tool");
    expect(parsed.meta.status).toBe("active");
    expect(parsed.body).toContain("# CLI plan");
  });
});

describe("apl add timestamps", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepoWithPlans();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  test("add sets updated and created when frontmatter is present but timestamps are absent", async () => {
    const filePath = path.join(repo.dir, "plan.md");
    await Bun.write(filePath, "---\ntitle: Timestamped\n---\nbody");

    await addPlans(["plan.md"], { cwd: repo.dir });

    const stored = await readCommittedPlan(repo.dir, "plan.md");
    const { meta } = parseFrontmatter(stored);

    expect(meta.created).toBe(today());
    expect(meta.updated).toBe(today());
  });

  test("add updates updated but preserves an existing created date", async () => {
    const filePath = path.join(repo.dir, "plan.md");
    await Bun.write(filePath, "---\ntitle: Existing\ncreated: 2025-01-01\n---\nbody");

    await addPlans(["plan.md"], { cwd: repo.dir });

    const stored = await readCommittedPlan(repo.dir, "plan.md");
    const { meta } = parseFrontmatter(stored);

    expect(meta.created).toBe("2025-01-01");
    expect(meta.updated).toBe(today());
  });

  test("add leaves files without frontmatter unchanged", async () => {
    const content = "# Plain markdown\n\nNo frontmatter.";
    const filePath = path.join(repo.dir, "plain.md");
    await Bun.write(filePath, content);

    await addPlans(["plain.md"], { cwd: repo.dir });

    const stored = await readCommittedPlan(repo.dir, "plain.md");
    expect(stored).toBe(content);
  });
});
