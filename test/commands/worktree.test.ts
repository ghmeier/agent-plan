import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addPlans } from "../../src/commands/add";
import { commitPlans } from "../../src/commands/commit";
import { listPlans } from "../../src/commands/ls";
import { getConfigPath, getGitCommonDir } from "../../src/lib/paths";
import { ensurePlansWorktree } from "../../src/lib/worktree";
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
  test("migrates branch and remote from .plans/config.json when new config location is empty", async () => {
    const repo = await createTestRepo();
    try {
      // Simulate an old-style setup: a plain .plans/ directory with config.json inside.
      const plansDir = join(repo.dir, ".plans");
      await mkdir(plansDir, { recursive: true });
      await writeFile(
        join(plansDir, "config.json"),
        JSON.stringify({ branch: "my-plans", remote: "upstream" }),
      );

      // ensurePlansWorktree (isInit=true) should migrate the config and replace
      // the plain directory with a real worktree.
      const config = { branch: "my-plans", remote: "upstream" };

      // Create the branch first so the worktree add can check it out.
      const { GitPlumbing } = await import("../../src/lib/git");
      const git = new GitPlumbing(repo.dir, "my-plans");
      await git.createOrphanBranch();

      await ensurePlansWorktree(repo.dir, config, true);

      // The new config location must contain the migrated values.
      const gitCommonDir = await getGitCommonDir(repo.dir);
      const newConfigPath = getConfigPath(gitCommonDir);
      const raw = await readFile(newConfigPath, "utf8");
      const migrated = JSON.parse(raw);
      expect(migrated.branch).toBe("my-plans");
      expect(migrated.remote).toBe("upstream");

      // The plain directory is gone; .plans/ is now a real worktree.
      const plansGit = await lstat(join(repo.dir, ".plans", ".git"));
      expect(plansGit.isFile()).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  test("does not overwrite existing new-location config during migration", async () => {
    const repo = await createTestRepo();
    try {
      // Write the new-location config first.
      const gitCommonDir = await getGitCommonDir(repo.dir);
      const newConfigPath = getConfigPath(gitCommonDir);
      await mkdir(join(gitCommonDir, "agent-plan"), { recursive: true });
      await writeFile(newConfigPath, JSON.stringify({ branch: "keep-me", remote: "origin" }));

      // Set up an old-style .plans/ with different values.
      const plansDir = join(repo.dir, ".plans");
      await mkdir(plansDir, { recursive: true });
      await writeFile(
        join(plansDir, "config.json"),
        JSON.stringify({ branch: "old-branch", remote: "old-remote" }),
      );

      const { GitPlumbing } = await import("../../src/lib/git");
      const git = new GitPlumbing(repo.dir, "keep-me");
      await git.createOrphanBranch();

      await ensurePlansWorktree(repo.dir, { branch: "keep-me", remote: "origin" }, true);

      // New-location config must be unchanged.
      const raw = await readFile(newConfigPath, "utf8");
      const saved = JSON.parse(raw);
      expect(saved.branch).toBe("keep-me");
      expect(saved.remote).toBe("origin");
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
        stderr: "pipe",
      });
      const tree = await new Response(proc.stdout).text();
      await proc.exited;

      expect(tree).not.toContain("config.json");
    } finally {
      await repo.cleanup();
    }
  });
});
