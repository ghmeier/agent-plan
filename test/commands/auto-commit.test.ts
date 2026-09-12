import { describe, expect, test } from "bun:test";
import { readFile, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import {
  installAutoCommitHook,
  removeAutoCommitHook,
  hasAutoCommitHook,
} from "../../src/lib/hooks";
import { createTestRepo, gitExec } from "../helpers";

async function hookPath(repoDir: string): Promise<string> {
  const gitDir = await gitExec(repoDir, ["rev-parse", "--git-dir"]);
  const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(repoDir, gitDir);
  return path.join(absoluteGitDir, "hooks", "post-commit");
}

describe("auto-commit hook", () => {
  test("installAutoCommitHook creates an executable post-commit hook", async () => {
    const repo = await createTestRepo();

    try {
      await installAutoCommitHook(repo.dir);

      const hook = await hookPath(repo.dir);
      const contents = await readFile(hook, "utf8");
      expect(contents).toContain("plan-storage");

      const info = await stat(hook);
      expect(info.mode & 0o111).not.toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("hasAutoCommitHook returns true after install, false before", async () => {
    const repo = await createTestRepo();

    try {
      expect(await hasAutoCommitHook(repo.dir)).toBe(false);

      await installAutoCommitHook(repo.dir);

      expect(await hasAutoCommitHook(repo.dir)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  test("removeAutoCommitHook removes the hook file", async () => {
    const repo = await createTestRepo();

    try {
      await installAutoCommitHook(repo.dir);
      await removeAutoCommitHook(repo.dir);

      expect(await hasAutoCommitHook(repo.dir)).toBe(false);

      const hook = await hookPath(repo.dir);
      const fileExists = await stat(hook).then(
        () => true,
        () => false,
      );
      expect(fileExists).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  test("installAutoCommitHook is idempotent", async () => {
    const repo = await createTestRepo();

    try {
      await installAutoCommitHook(repo.dir);
      const hook = await hookPath(repo.dir);
      const firstContents = await readFile(hook, "utf8");

      await installAutoCommitHook(repo.dir);
      const secondContents = await readFile(hook, "utf8");

      expect(secondContents).toBe(firstContents);
      expect(secondContents.split("plan-storage").length).toBe(
        firstContents.split("plan-storage").length,
      );
    } finally {
      await repo.cleanup();
    }
  });

  test("integrates safely with an existing post-commit hook", async () => {
    const repo = await createTestRepo();

    try {
      const hook = await hookPath(repo.dir);
      await mkdir(path.dirname(hook), { recursive: true });
      const existingContent = "#!/bin/sh\necho 'existing hook ran'\n";
      await writeFile(hook, existingContent);
      await chmod(hook, 0o755);

      await installAutoCommitHook(repo.dir);

      const afterInstall = await readFile(hook, "utf8");
      expect(afterInstall).toContain("existing hook ran");
      expect(afterInstall).toContain("plan-storage");

      await removeAutoCommitHook(repo.dir);

      const afterRemove = await readFile(hook, "utf8");
      expect(afterRemove).toContain("existing hook ran");
      expect(afterRemove).not.toContain("plan-storage");
    } finally {
      await repo.cleanup();
    }
  });
});
