import { describe, expect, test } from "bun:test";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { addPlans } from "../../src/commands/add";
import { commitPlans } from "../../src/commands/commit";
import { initPlans } from "../../src/commands/init";
import { listPlans } from "../../src/commands/ls";
import { readConfig } from "../../src/lib/config";
import { Git } from "../../src/lib/git";
import {
  createSecondaryWorktree,
  createTestRepo,
  gitExec,
  initTestPlans,
  writePlanFile,
} from "../helpers";

describe("init always sets up .plans/ worktree", () => {
  test("creates .plans/ as a git worktree", async () => {
    const repo = await createTestRepo();
    try {
      await initTestPlans(repo.dir);

      const plansGit = await lstat(join(repo.dir, ".plans", ".git"));
      expect(plansGit.isFile()).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  test("is idempotent", async () => {
    const repo = await createTestRepo();
    try {
      await initTestPlans(repo.dir);
      await initTestPlans(repo.dir);

      const plansGit = await lstat(join(repo.dir, ".plans", ".git"));
      expect(plansGit.isFile()).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("commit", () => {
  test("commits a file written directly to .plans/", async () => {
    const repo = await createTestRepo();
    try {
      await initTestPlans(repo.dir);

      await Bun.write(join(repo.dir, ".plans", "notes.md"), "hello from worktree\n");
      await commitPlans({ cwd: repo.dir, message: "Add notes" });

      const content = await Bun.file(join(repo.dir, ".plans", "notes.md")).text();
      expect(content).toBe("hello from worktree\n");

      const log = await gitExec(repo.dir, ["log", "--oneline", "plans"]);
      expect(log).toContain("Add notes");
    } finally {
      await repo.cleanup();
    }
  });

  test("add followed by commit does not delete the added file", async () => {
    const repo = await createTestRepo();
    try {
      await initTestPlans(repo.dir);
      await writePlanFile(repo.dir, "keep.md", "keep me");

      // Commit should find nothing new and leave keep.md intact.
      await commitPlans({ cwd: repo.dir, message: "no-op commit" });

      const file = Bun.file(join(repo.dir, ".plans", "keep.md"));
      expect(await file.exists()).toBe(true);
      expect(await file.text()).toBe("keep me");
    } finally {
      await repo.cleanup();
    }
  });

  test("prints nothing-to-commit when there are no changes", async () => {
    const repo = await createTestRepo();
    try {
      await initTestPlans(repo.dir);

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      try {
        await commitPlans({ cwd: repo.dir });
      } finally {
        console.log = originalLog;
      }

      expect(logs.join("\n")).toContain("Nothing to commit");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("secondary worktree symlink", () => {
  test("secondary worktree gets .plans as a symlink to the main checkout's .plans/", async () => {
    const repo = await createTestRepo();
    const secondary = await createSecondaryWorktree(repo.dir);
    try {
      await initTestPlans(repo.dir);

      // ensurePlansWorktree must create the symlink when run from the secondary.
      // We trigger it by running a command.
      const files = await listPlans(undefined, secondary.dir);

      // The secondary's .plans must be a symlink.
      const secondaryPlans = join(secondary.dir, ".plans");
      const stat = await lstat(secondaryPlans);
      expect(stat.isSymbolicLink()).toBe(true);

      // Both checkouts see the same files.
      const mainFiles = await listPlans(undefined, repo.dir);
      expect(files.sort()).toEqual(mainFiles.sort());
    } finally {
      await secondary.cleanup();
      await repo.cleanup();
    }
  });

  test("files committed from the secondary worktree are visible in the main checkout", async () => {
    const repo = await createTestRepo();
    const secondary = await createSecondaryWorktree(repo.dir);
    try {
      await initTestPlans(repo.dir);

      // Write a source file in the secondary worktree and add it via apl add,
      // which triggers ensurePlansWorktree and creates the symlink.
      await Bun.write(join(secondary.dir, "from-secondary.md"), "secondary content");
      await addPlans(["from-secondary.md"], { cwd: secondary.dir });

      // The main checkout's .plans/ must now have the file (via the symlink).
      const file = Bun.file(join(repo.dir, ".plans", "from-secondary.md"));
      expect(await file.exists()).toBe(true);
      expect(await file.text()).toBe("secondary content");
    } finally {
      await secondary.cleanup();
      await repo.cleanup();
    }
  });
});

describe("config migration from old plain-directory .plans/", () => {
  test("initPlans picks up branch from old .plans/config.json and creates that branch", async () => {
    const repo = await createTestRepo();
    try {
      // Simulate an old-style repo: .plans/ is a plain directory with config.json inside.
      const plansDir = join(repo.dir, ".plans");
      await mkdir(plansDir, { recursive: true });
      await Bun.write(
        join(plansDir, "config.json"),
        JSON.stringify({ branch: "custom", remote: "origin" }),
      );

      // initPlans without --branch must pick up "custom" from migration, not the default "plans".
      await initPlans({ cwd: repo.dir });

      const git = new Git(repo.dir, "custom");
      expect(await git.branchExists()).toBe(true);

      const config = await readConfig(repo.dir);
      expect(config.branch).toBe("custom");

      // .plans/ must now be a real worktree, not the old plain directory.
      const plansGit = await lstat(join(repo.dir, ".plans", ".git"));
      expect(plansGit.isFile()).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  test("lsPlans picks up branch from old .plans/config.json and sets up the worktree", async () => {
    const repo = await createTestRepo();
    try {
      // Create the custom branch so ensurePlansWorktree can check it out.
      const git = new Git(repo.dir, "custom");
      await git.createOrphanBranch();

      // Simulate old-style setup: plain .plans/ directory with config.json.
      const plansDir = join(repo.dir, ".plans");
      await mkdir(plansDir, { recursive: true });
      await Bun.write(
        join(plansDir, "config.json"),
        JSON.stringify({ branch: "custom", remote: "origin" }),
      );

      // listPlans triggers readConfig (migration) then ensurePlansWorktree.
      await listPlans(undefined, repo.dir);

      const config = await readConfig(repo.dir);
      expect(config.branch).toBe("custom");

      // .plans/ must now be a real worktree on the custom branch.
      const plansGit = await lstat(join(repo.dir, ".plans", ".git"));
      expect(plansGit.isFile()).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("config is not committed to the plans branch", () => {
  test("config.json does not appear in the plans branch tree", async () => {
    const repo = await createTestRepo();
    try {
      await initTestPlans(repo.dir);

      const proc = Bun.spawn(["git", "ls-tree", "-r", "--name-only", "plans"], {
        cwd: repo.dir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const tree = await new Response(proc.stdout).text();
      await proc.exited;

      expect(tree).not.toContain("config.json");
    } finally {
      await repo.cleanup();
    }
  });
});
