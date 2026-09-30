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
    expect(result.stdout).toContain("Synced plans with origin");
    expect(await git(remote.dir, ["show", "plans:plan.md"])).toBe("# Plan");
  });

  test("sync commits pending edits in .plans/ before pushing", async () => {
    await using remote = await createRemote();
    await using repo = await createInitializedRepo();
    await addOrigin(repo, remote);
    await Bun.write(join(repo.plansDir, "draft.md"), "# Draft\n");

    await apl(repo.dir, ["sync"]);

    expect(await git(remote.dir, ["show", "plans:draft.md"])).toBe("# Draft");
    expect(await planLogMessages(repo, ["-n", "1"])).toEqual(["Update plans"]);
  });

  test("sync works with a remote URL relative to the repo root", async () => {
    await using remote = await createRemote();
    await using repo = await createInitializedRepo();
    await git(repo.dir, ["remote", "add", "origin", `../${basename(remote.dir)}`]);
    await addPlan(repo, "plan.md", "# Plan\n");

    const result = await apl(repo.dir, ["sync"]);

    expect(result.exitCode).toBe(0);
    expect(await git(remote.dir, ["show", "plans:plan.md"])).toBe("# Plan");
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
    expect(result.stdout).not.toContain("Synced plans");
  });
});

describe("collaborating through a shared remote", () => {
  test("a teammate's init picks up plans already on the remote", async () => {
    await using remote = await createRemote();
    await using _publisher = await createPublishingRepo(remote);

    await using teammate = await createTeammateRepo(remote);

    const result = await apl(teammate.dir, ["show", "shared.md", "--raw"]);
    expect(result.stdout).toBe("# Shared\n");
  });

  test("a fresh clone can read plans from the remote without running init", async () => {
    await using remote = await createRemote();
    await using _publisher = await createPublishingRepo(remote);
    await using clone = await createRepo();
    await addOrigin(clone, remote);

    const result = await apl(clone.dir, ["ls", "--short"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("shared.md\n");
  });

  test("plans synced by each teammate reach the other", async () => {
    await using remote = await createRemote();
    await using publisher = await createPublishingRepo(remote);
    await using teammate = await createTeammateRepo(remote);
    await addPlan(teammate, "reply.md", "# Reply\n");

    const teammateSync = await apl(teammate.dir, ["sync"]);
    const publisherSync = await apl(publisher.dir, ["sync"]);

    expect(teammateSync.exitCode).toBe(0);
    expect(publisherSync.exitCode).toBe(0);
    expect((await apl(publisher.dir, ["show", "reply.md", "--raw"])).stdout).toBe("# Reply\n");
  });

  test("sync rebases onto a teammate's changes to other files and pushes both", async () => {
    await using remote = await createRemote();
    await using publisher = await createPublishingRepo(remote);
    await using teammate = await createTeammateRepo(remote);
    await addPlan(publisher, "first.md", "# First\n");
    await apl(publisher.dir, ["sync"]);
    await addPlan(teammate, "second.md", "# Second\n");

    const result = await apl(teammate.dir, ["sync"]);

    expect(result.exitCode).toBe(0);
    expect(await git(remote.dir, ["ls-tree", "--name-only", "plans"])).toBe(
      "first.md\nsecond.md\nshared.md",
    );
  });

  test("sync with a conflicting edit names the file and pushes nothing", async () => {
    await using remote = await createRemote();
    await using publisher = await createPublishingRepo(remote);
    await using teammate = await createTeammateRepo(remote);
    await Bun.write(join(publisher.plansDir, "shared.md"), "# Publisher's version\n");
    await apl(publisher.dir, ["sync"]);
    await Bun.write(join(teammate.plansDir, "shared.md"), "# Teammate's version\n");

    const result = await apl(teammate.dir, ["sync"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("conflict with origin/plans in: shared.md");
    expect(await git(remote.dir, ["show", "plans:shared.md"])).toBe("# Publisher's version");
    expect((await apl(teammate.dir, ["show", "shared.md", "--raw"])).stdout).toBe(
      "# Teammate's version\n",
    );
    expect((await apl(teammate.dir, ["commit"])).exitCode).toBe(0);
  });
});
