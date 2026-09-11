import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot, resolvePlanPath } from "../../src/lib/paths";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "plan-storage-paths-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("findRepoRoot", () => {
  test("returns the repo root when started there", async () => {
    const repoRoot = await makeTempDir();
    await mkdir(join(repoRoot, ".git"));

    const found = await findRepoRoot(repoRoot);

    expect(found).toBe(repoRoot);
  });

  test("returns the repo root when started from a subdirectory", async () => {
    const repoRoot = await makeTempDir();
    await mkdir(join(repoRoot, ".git"));
    const nested = join(repoRoot, "a", "b", "c");
    await mkdir(nested, { recursive: true });

    const found = await findRepoRoot(nested);

    expect(found).toBe(repoRoot);
  });

  test("throws when no .git is found up to the mount point", async () => {
    const nonGitDir = await makeTempDir();

    await expect(findRepoRoot(nonGitDir)).rejects.toThrow(
      "Not a git repository (or any parent up to mount point)",
    );
  });
});

describe("resolvePlanPath", () => {
  const repoRoot = "/repo/root";

  test("returns a relative path as-is", () => {
    expect(resolvePlanPath(repoRoot, "notes/plan.md")).toBe("notes/plan.md");
  });

  test("makes an absolute path relative to the repo root", () => {
    expect(resolvePlanPath(repoRoot, "/repo/root/notes/plan.md")).toBe(
      "notes/plan.md",
    );
  });

  test("strips a leading ./ and /", () => {
    expect(resolvePlanPath(repoRoot, "./notes/plan.md")).toBe(
      "notes/plan.md",
    );
    expect(resolvePlanPath(repoRoot, "/notes/plan.md")).toBe("notes/plan.md");
  });
});
