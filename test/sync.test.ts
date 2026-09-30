import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import {
  addOrigin,
  addPlan,
  apl,
  createInitializedRepo,
  createRemote,
  createRepo,
  git,
  planLogMessages,
  type Repo,
  type TempDir,
} from "./harness";

/**
 * Tests with two teammates run the CLI a dozen or more times, which can pass
 * bun's 5s default while every test file runs at once. Bun ignores
 * setDefaultTimeout for concurrent tests, so each one passes this instead.
 */
const TWO_TEAMMATE_TIMEOUT_MS = 20_000;

/** A repo that has run `apl init`, added a plan, and synced it to `remote`. */
async function createPublishingRepo(remote: TempDir): Promise<Repo> {
  const repo = await createInitializedRepo();
  await addOrigin(repo, remote);
  await addPlan(repo, "shared.md", "# Shared\n");
  const result = await apl(repo.dir, ["sync"]);
  if (result.exitCode !== 0) throw new Error(`apl sync failed: ${result.stderr}`);
  return repo;
}

/** A teammate's repo that points at `remote` and runs `apl init` after plans were published. */
async function createTeammateRepo(remote: TempDir): Promise<Repo> {
  const repo = await createRepo();
  await addOrigin(repo, remote);
  const result = await apl(repo.dir, ["init"]);
  if (result.exitCode !== 0) throw new Error(`apl init failed: ${result.stderr}`);
  return repo;
}

describe("apl sync", () => {
  test("sync pushes committed plans to the remote", async () => {
    await using remote = await createRemote();
    await using repo = await createInitializedRepo();
    await addOrigin(repo, remote);
    await addPlan(repo, "plan.md", "# Plan\n");

    const result = await apl(repo.dir, ["sync"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Synced docs with origin");
    expect(await git(remote.dir, ["show", "apl:plan.md"])).toBe("# Plan");
  });

  test("sync commits pending edits in .apl/ before pushing", async () => {
    await using remote = await createRemote();
    await using repo = await createInitializedRepo();
    await addOrigin(repo, remote);
    await Bun.write(join(repo.storeDir, "draft.md"), "# Draft\n");

    await apl(repo.dir, ["sync"]);

    expect(await git(remote.dir, ["show", "apl:draft.md"])).toBe("# Draft");
    expect(await planLogMessages(repo, ["-n", "1"])).toEqual(["Update draft.md"]);
  });

  test("sync works with a remote URL relative to the repo root", async () => {
    await using remote = await createRemote();
    await using repo = await createInitializedRepo();
    await git(repo.dir, ["remote", "add", "origin", `../${basename(remote.dir)}`]);
    await addPlan(repo, "plan.md", "# Plan\n");

    const result = await apl(repo.dir, ["sync"]);

    expect(result.exitCode).toBe(0);
    expect(await git(remote.dir, ["show", "apl:plan.md"])).toBe("# Plan");
  });

  test("sync without a remote skips cleanly", async () => {
    await using repo = await createInitializedRepo();

    const result = await apl(repo.dir, ["sync"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No remote configured, skipping sync");
  });

  test("sync fails when the remote can't be fetched", async () => {
    await using repo = await createInitializedRepo();
    await git(repo.dir, ["remote", "add", "origin", "/nonexistent/remote.git"]);

    const result = await apl(repo.dir, ["sync"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("fetch failed");
  });

  test("sync fails without claiming success when the push is rejected", async () => {
    await using remote = await createRemote();
    await using repo = await createPublishingRepo(remote);
    await addPlan(repo, "new.md", "# New\n");
    await git(repo.dir, ["remote", "set-url", "--push", "origin", "/nonexistent/push.git"]);

    const result = await apl(repo.dir, ["sync"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("push failed");
    expect(result.stdout).not.toContain("Synced docs");
  });
});

describe("collaborating through a shared remote", () => {
  test(
    "a teammate's init picks up plans already on the remote",
    async () => {
      await using remote = await createRemote();
      await using _publisher = await createPublishingRepo(remote);

      await using teammate = await createTeammateRepo(remote);

      const result = await apl(teammate.dir, ["show", "shared.md", "--raw"]);
      expect(result.stdout).toBe("# Shared\n");
    },
    TWO_TEAMMATE_TIMEOUT_MS,
  );

  test("a fresh clone can read plans from the remote without running init", async () => {
    await using remote = await createRemote();
    await using _publisher = await createPublishingRepo(remote);
    await using clone = await createRepo();
    await addOrigin(clone, remote);

    const result = await apl(clone.dir, ["ls", "--short"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("shared.md\n");
  });

  test(
    "plans synced by each teammate reach the other",
    async () => {
      await using remote = await createRemote();
      await using publisher = await createPublishingRepo(remote);
      await using teammate = await createTeammateRepo(remote);
      await addPlan(teammate, "reply.md", "# Reply\n");

      const teammateSync = await apl(teammate.dir, ["sync"]);
      const publisherSync = await apl(publisher.dir, ["sync"]);

      expect(teammateSync.exitCode).toBe(0);
      expect(publisherSync.exitCode).toBe(0);
      expect((await apl(publisher.dir, ["show", "reply.md", "--raw"])).stdout).toBe("# Reply\n");
    },
    TWO_TEAMMATE_TIMEOUT_MS,
  );

  test(
    "sync rebases onto a teammate's changes to other files and pushes both",
    async () => {
      await using remote = await createRemote();
      await using publisher = await createPublishingRepo(remote);
      await using teammate = await createTeammateRepo(remote);
      await addPlan(publisher, "first.md", "# First\n");
      await apl(publisher.dir, ["sync"]);
      await addPlan(teammate, "second.md", "# Second\n");

      const result = await apl(teammate.dir, ["sync"]);

      expect(result.exitCode).toBe(0);
      expect(await git(remote.dir, ["ls-tree", "--name-only", "apl"])).toBe(
        "first.md\nsecond.md\nshared.md",
      );
    },
    TWO_TEAMMATE_TIMEOUT_MS,
  );

  test(
    "sync with a conflicting edit names the file and pushes nothing",
    async () => {
      await using remote = await createRemote();
      await using publisher = await createPublishingRepo(remote);
      await using teammate = await createTeammateRepo(remote);
      await Bun.write(join(publisher.storeDir, "shared.md"), "# Publisher's version\n");
      await apl(publisher.dir, ["sync"]);
      await Bun.write(join(teammate.storeDir, "shared.md"), "# Teammate's version\n");

      const result = await apl(teammate.dir, ["sync"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("conflict with origin/apl in: shared.md");
      expect(await git(remote.dir, ["show", "apl:shared.md"])).toBe("# Publisher's version");
      expect((await apl(teammate.dir, ["show", "shared.md", "--raw"])).stdout).toBe(
        "# Teammate's version\n",
      );
      expect((await apl(teammate.dir, ["commit"])).exitCode).toBe(0);
    },
    TWO_TEAMMATE_TIMEOUT_MS,
  );
});

describe("apl pull", () => {
  test(
    "pull brings in a teammate's docs without publishing local edits",
    async () => {
      await using remote = await createRemote();
      await using publisher = await createPublishingRepo(remote);
      await using teammate = await createTeammateRepo(remote);
      await addPlan(publisher, "first.md", "# First\n");
      await apl(publisher.dir, ["sync"]);
      await Bun.write(join(teammate.storeDir, "draft.md"), "# Draft\n");

      const result = await apl(teammate.dir, ["pull"]);

      expect(result.stdout).toContain("Pulled doc changes from origin");
      expect(await apl(teammate.dir, ["ls", "--short"]).then((r) => r.stdout)).toContain(
        "first.md",
      );
      expect(await git(remote.dir, ["ls-tree", "--name-only", "apl"])).toBe("first.md\nshared.md");
    },
    TWO_TEAMMATE_TIMEOUT_MS,
  );

  test(
    "pull in a fresh clone that never ran init sets up the teammate's docs",
    async () => {
      await using remote = await createRemote();
      await using _publisher = await createPublishingRepo(remote);
      await using clone = await createRepo();
      await addOrigin(clone, remote);

      const result = await apl(clone.dir, ["pull", "--quiet"]);

      expect(result.exitCode).toBe(0);
      expect((await apl(clone.dir, ["ls", "--short"])).stdout).toBe("shared.md\n");
    },
    TWO_TEAMMATE_TIMEOUT_MS,
  );

  test("pull --quiet prints nothing when already up to date", async () => {
    await using remote = await createRemote();
    await using publisher = await createPublishingRepo(remote);

    const result = await apl(publisher.dir, ["pull", "--quiet"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("apl sync --if-changed", () => {
  test("sync --if-changed skips the remote when there is nothing to publish", async () => {
    await using remote = await createRemote();
    await using repo = await createPublishingRepo(remote);
    await git(repo.dir, ["remote", "set-url", "origin", "/nonexistent/remote.git"]);

    const result = await apl(repo.dir, ["sync", "--if-changed"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("sync --if-changed publishes pending edits", async () => {
    await using remote = await createRemote();
    await using repo = await createPublishingRepo(remote);
    await Bun.write(join(repo.storeDir, "draft.md"), "# Draft\n");

    await apl(repo.dir, ["sync", "--if-changed"]);

    expect(await git(remote.dir, ["show", "apl:draft.md"])).toBe("# Draft");
  });
});

describe("apl status", () => {
  test("status reports uncommitted files and commits not yet pushed", async () => {
    await using remote = await createRemote();
    await using repo = await createPublishingRepo(remote);
    await addPlan(repo, "local.md", "# Local\n");
    await Bun.write(join(repo.storeDir, "draft.md"), "# Draft\n");

    const status = JSON.parse((await apl(repo.dir, ["status", "--json"])).stdout);

    expect(status.upstream).toEqual({ ref: "origin/apl", ahead: 1, behind: 0 });
    expect(status.pending).toEqual([{ path: "draft.md", status: "??" }]);
    expect(status.operation).toBeNull();
  });

  test("status without a remote reports no upstream", async () => {
    await using repo = await createInitializedRepo();

    const result = await apl(repo.dir, ["status"]);

    expect(result.stdout).toContain("not synced with a remote");
    expect(result.stdout).toContain("No uncommitted changes");
  });
});
