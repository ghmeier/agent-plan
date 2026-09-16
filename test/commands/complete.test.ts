import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runComplete } from "../../src/commands/complete";
import { createTestRepo, createTestRepoWithPlans, writePlanFile } from "../helpers";

// Capture stdout lines from runComplete without affecting the real process.stdout.
async function capture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

describe("runComplete files", () => {
  test("lists committed plan files when .plans/ worktree exists", async () => {
    const repo = await createTestRepoWithPlans();
    try {
      await writePlanFile(repo.dir, "alpha.md", "# Alpha");
      await writePlanFile(repo.dir, "sub/beta.md", "# Beta");

      const lines = await capture(() => runComplete("files", undefined, { cwd: repo.dir }));

      expect(lines).toContain("alpha.md");
      expect(lines).toContain("sub/beta.md");
    } finally {
      await repo.cleanup();
    }
  });

  test("lists files via git ls-tree when .plans/ worktree is absent", async () => {
    const repo = await createTestRepoWithPlans();
    try {
      await writePlanFile(repo.dir, "plan.md", "# Plan");

      // Remove the worktree so __complete must fall back to git ls-tree.
      const { $ } = Bun;
      await $`git worktree remove --force ${join(repo.dir, ".plans")}`.cwd(repo.dir).quiet();

      const lines = await capture(() => runComplete("files", undefined, { cwd: repo.dir }));

      expect(lines).toContain("plan.md");
    } finally {
      await repo.cleanup();
    }
  });

  test("filters by prefix when provided", async () => {
    const repo = await createTestRepoWithPlans();
    try {
      await writePlanFile(repo.dir, "alpha.md", "# Alpha");
      await writePlanFile(repo.dir, "beta.md", "# Beta");

      const lines = await capture(() => runComplete("files", "al", { cwd: repo.dir }));

      expect(lines).toContain("alpha.md");
      expect(lines).not.toContain("beta.md");
    } finally {
      await repo.cleanup();
    }
  });

  test("prints nothing and exits cleanly outside a git repo", async () => {
    const lines = await capture(() => runComplete("files", undefined, { cwd: "/tmp" }));

    expect(lines).toHaveLength(0);
  });

  test("prints nothing and exits cleanly before init", async () => {
    const repo = await createTestRepo();
    try {
      // No initTestPlans — plans branch does not exist yet.
      const lines = await capture(() => runComplete("files", undefined, { cwd: repo.dir }));

      expect(lines).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("runComplete statuses", () => {
  test("returns the four canonical status values", async () => {
    const lines = await capture(() => runComplete("statuses", undefined, { cwd: "/tmp" }));

    expect(lines).toEqual(["draft", "active", "completed", "archived"]);
  });
});

describe("runComplete tags", () => {
  test("returns tags collected from plan frontmatter", async () => {
    const repo = await createTestRepoWithPlans();
    try {
      await writePlanFile(repo.dir, "plan.md", "---\ntags: [cli, backend]\n---\n# Plan");

      const lines = await capture(() => runComplete("tags", undefined, { cwd: repo.dir }));

      expect(lines).toContain("cli");
      expect(lines).toContain("backend");
    } finally {
      await repo.cleanup();
    }
  });

  test("returns empty output when no plans have tags", async () => {
    const repo = await createTestRepoWithPlans();
    try {
      await writePlanFile(repo.dir, "plan.md", "# No frontmatter");

      const lines = await capture(() => runComplete("tags", undefined, { cwd: repo.dir }));

      expect(lines).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("runComplete versions", () => {
  test("returns short commit hashes from the plans branch", async () => {
    const repo = await createTestRepoWithPlans();
    try {
      await writePlanFile(repo.dir, "plan.md", "v1");
      await writePlanFile(repo.dir, "plan.md", "v2", "Update plan");

      const lines = await capture(() => runComplete("versions", undefined, { cwd: repo.dir }));

      // At least two commits: init + two writes (each writePlanFile commits).
      expect(lines.length).toBeGreaterThanOrEqual(2);
      // Short hashes are 7-10 hex chars.
      for (const line of lines) {
        expect(line).toMatch(/^[0-9a-f]{4,40}$/);
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("prints nothing before init", async () => {
    const repo = await createTestRepo();
    try {
      const lines = await capture(() => runComplete("versions", undefined, { cwd: repo.dir }));

      expect(lines).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("runComplete unknown context", () => {
  test("prints nothing for an unrecognized context", async () => {
    const lines = await capture(() => runComplete("bogus", undefined, { cwd: "/tmp" }));

    expect(lines).toHaveLength(0);
  });
});
