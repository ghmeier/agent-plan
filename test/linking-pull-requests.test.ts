import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  addPlan,
  apl,
  commitCode,
  createInitializedRepo,
  createTempDir,
  git,
  type Repo,
  readLinks,
  startWorkBranch,
  type TempDir,
} from "./harness";

/** See `linking.test.ts`: each test builds branches and runs the CLI many times. */
const LINK_TEST_TIMEOUT_MS = 20_000;

const PLAN = "plan/billing.md";

interface FakePullRequest {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefOid: string;
  mergeCommit: { oid: string } | null;
  createdAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}

function pullRequest(
  overrides: Partial<FakePullRequest> & { headRefOid: string },
): FakePullRequest {
  return {
    number: 12,
    state: "OPEN",
    mergeCommit: null,
    createdAt: new Date().toISOString(),
    closedAt: null,
    mergedAt: null,
    ...overrides,
  };
}

/**
 * A `gh` that prints the pull requests in a canned file, or fails like a
 * signed-out `gh` when told to. Nothing here touches the network.
 */
interface FakeGh extends AsyncDisposable {
  /** Environment for `apl(..., { env })`, with the fake first on PATH. */
  env: Record<string, string>;
  setPullRequests(pullRequests: FakePullRequest[]): Promise<void>;
  setFailing(): void;
}

async function createFakeGh(): Promise<FakeGh> {
  const dir: TempDir = await createTempDir();
  const script = join(dir.dir, "gh");
  const pullRequestsFile = join(dir.dir, "pull-requests.json");
  await Bun.write(
    script,
    `#!/bin/sh\nif [ -n "$FAKE_GH_FAIL" ]; then echo "gh: not signed in" >&2; exit 4; fi\ncat "$FAKE_GH_PULL_REQUESTS"\n`,
  );
  await chmod(script, 0o755);
  await Bun.write(pullRequestsFile, "[]");

  const env: Record<string, string> = {
    PATH: `${dir.dir}:${process.env.PATH ?? ""}`,
    FAKE_GH_PULL_REQUESTS: pullRequestsFile,
  };
  return {
    env,
    setPullRequests: async (pullRequests) => {
      await Bun.write(pullRequestsFile, JSON.stringify(pullRequests));
    },
    setFailing: () => {
      env.FAKE_GH_FAIL = "1";
    },
    [Symbol.asyncDispose]: () => dir[Symbol.asyncDispose](),
  };
}

/** A repo with one plan, a work branch linked to it, and the branch's tip. */
async function createLinkedBranch(
  branch = "feature/billing",
): Promise<{ repo: Repo; tip: string }> {
  const repo = await createInitializedRepo();
  await addPlan(repo, PLAN, "# Billing\n");
  const tip = await startWorkBranch(repo, branch);
  const linked = await apl(repo.dir, ["link", PLAN]);
  if (linked.exitCode !== 0) throw new Error(`apl link failed: ${linked.stderr}`);
  return { repo, tip };
}

/** The squash commit a merged pull request would leave on the default branch. */
async function squashCommitOnMain(repo: Repo): Promise<string> {
  return git(repo.dir, ["rev-parse", "main"]);
}

async function docsCommitCount(repo: Repo): Promise<number> {
  return Number(await git(repo.storeDir, ["rev-list", "--count", "HEAD"]));
}

describe("apl links --edits on a merged link", () => {
  test(
    "edits stop at the commit that recorded the merge",
    async () => {
      const { repo, tip } = await createLinkedBranch();
      await using _repo = repo;
      await using gh = await createFakeGh();
      await Bun.write(join(repo.storeDir, PLAN), "# Billing\n\nWritten before the merge.\n");
      await apl(repo.dir, ["commit", "-m", "Edit before the merge"]);
      await gh.setPullRequests([
        pullRequest({
          state: "MERGED",
          headRefOid: tip,
          mergeCommit: { oid: await squashCommitOnMain(repo) },
          closedAt: new Date().toISOString(),
          mergedAt: new Date().toISOString(),
        }),
      ]);
      await apl(repo.dir, ["links", "--resolve"], { env: gh.env });
      await Bun.write(join(repo.storeDir, PLAN), "# Billing\n\nWritten after the merge.\n");
      await apl(repo.dir, ["commit", "-m", "Edit after the merge"]);

      const result = await apl(repo.dir, [
        "links",
        PLAN,
        "--branch",
        "feature/billing",
        "--edits",
        "--json",
      ]);

      const { edits } = JSON.parse(result.stdout) as { edits: Array<{ message: string }> };
      expect(edits.map((edit) => edit.message)).toEqual(["Edit before the merge"]);
    },
    LINK_TEST_TIMEOUT_MS,
  );
});

describe("apl links --resolve", () => {
  test(
    "an open pull request records its number and leaves the link unresolved",
    async () => {
      const { repo, tip } = await createLinkedBranch();
      await using _repo = repo;
      await using gh = await createFakeGh();
      await gh.setPullRequests([pullRequest({ number: 12, headRefOid: tip })]);

      const result = await apl(repo.dir, ["links", "--resolve"], { env: gh.env });

      expect(result.exitCode).toBe(0);
      const [link] = await readLinks(repo);
      expect(link?.pr).toBe(12);
      expect(link?.merged).toBeNull();
      expect(link?.prState).toBeNull();
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a merged pull request records the squash commit and marks the link merged",
    async () => {
      const { repo, tip } = await createLinkedBranch();
      await using _repo = repo;
      await using gh = await createFakeGh();
      const squash = await squashCommitOnMain(repo);
      await gh.setPullRequests([
        pullRequest({
          number: 12,
          state: "MERGED",
          headRefOid: tip,
          mergeCommit: { oid: squash },
          closedAt: new Date().toISOString(),
          mergedAt: new Date().toISOString(),
        }),
      ]);

      await apl(repo.dir, ["links", "--resolve"], { env: gh.env });

      const [link] = await readLinks(repo);
      expect(link?.pr).toBe(12);
      expect(link?.merged).toBe(squash);
      expect(link?.prState).toBe("merged");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a pull request closed without merging marks the link closed and has no squash commit",
    async () => {
      const { repo, tip } = await createLinkedBranch();
      await using _repo = repo;
      await using gh = await createFakeGh();
      await gh.setPullRequests([
        pullRequest({
          number: 7,
          state: "CLOSED",
          headRefOid: tip,
          closedAt: new Date().toISOString(),
        }),
      ]);

      await apl(repo.dir, ["links", "--resolve"], { env: gh.env });

      const [link] = await readLinks(repo);
      expect(link?.pr).toBe(7);
      expect(link?.prState).toBe("closed");
      expect(link?.merged).toBeNull();
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a pull request with another head that closed before the link was made is ignored",
    async () => {
      const { repo } = await createLinkedBranch();
      await using _repo = repo;
      await using gh = await createFakeGh();
      await gh.setPullRequests([
        pullRequest({
          number: 3,
          state: "MERGED",
          headRefOid: "0".repeat(40),
          mergeCommit: { oid: "1".repeat(40) },
          createdAt: "2000-01-01T00:00:00Z",
          closedAt: "2000-01-02T00:00:00Z",
          mergedAt: "2000-01-02T00:00:00Z",
        }),
      ]);

      await apl(repo.dir, ["links", "--resolve"], { env: gh.env });

      const [link] = await readLinks(repo);
      expect(link?.pr).toBeNull();
      expect(link?.merged).toBeNull();
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "an open pull request with a newer head than the record still matches the branch",
    async () => {
      const { repo } = await createLinkedBranch();
      await using _repo = repo;
      await using gh = await createFakeGh();
      await gh.setPullRequests([
        pullRequest({ number: 3, headRefOid: "2".repeat(40), createdAt: "2000-01-01T00:00:00Z" }),
        pullRequest({ number: 9, headRefOid: "3".repeat(40) }),
      ]);

      await apl(repo.dir, ["links", "--resolve"], { env: gh.env });

      const [link] = await readLinks(repo);
      expect(link?.pr).toBe(9);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "resolving twice adds a commit the first time and none the second",
    async () => {
      const { repo, tip } = await createLinkedBranch();
      await using _repo = repo;
      await using gh = await createFakeGh();
      await gh.setPullRequests([pullRequest({ number: 12, headRefOid: tip })]);
      const before = await docsCommitCount(repo);

      await apl(repo.dir, ["links", "--resolve"], { env: gh.env });
      const afterFirst = await docsCommitCount(repo);
      await apl(repo.dir, ["links", "--resolve"], { env: gh.env });
      const afterSecond = await docsCommitCount(repo);

      expect(afterFirst).toBe(before + 1);
      expect(afterSecond).toBe(afterFirst);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a failing gh leaves the links unchanged and the command still succeeds",
    async () => {
      const { repo, tip } = await createLinkedBranch();
      await using _repo = repo;
      await using gh = await createFakeGh();
      await gh.setPullRequests([pullRequest({ number: 12, headRefOid: tip })]);
      gh.setFailing();
      const before = await docsCommitCount(repo);

      const result = await apl(repo.dir, ["links", "--resolve"], { env: gh.env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(await docsCommitCount(repo)).toBe(before);
      const [link] = await readLinks(repo);
      expect(link?.pr).toBeNull();
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a branch name reused after a merge starts a new link",
    async () => {
      const { repo, tip } = await createLinkedBranch();
      await using _repo = repo;
      await using gh = await createFakeGh();
      await gh.setPullRequests([
        pullRequest({
          state: "MERGED",
          headRefOid: tip,
          mergeCommit: { oid: await squashCommitOnMain(repo) },
          closedAt: new Date().toISOString(),
          mergedAt: new Date().toISOString(),
        }),
      ]);
      await apl(repo.dir, ["links", "--resolve"], { env: gh.env });

      const newTip = await commitCode(repo, "second-round.txt");
      const committed = await apl(repo.dir, ["commit", "-m", "Record the reused branch"]);

      expect(committed.exitCode).toBe(0);
      const links = await readLinks(repo);
      expect(links.map((link) => link.branch)).toEqual(["feature/billing", "feature/billing"]);
      const [newest, oldest] = links;
      expect(newest?.commit).toBe(newTip);
      expect(newest?.merged).toBeNull();
      expect(oldest?.commit).toBe(tip);
      expect(oldest?.prState).toBe("merged");
    },
    LINK_TEST_TIMEOUT_MS,
  );
});

describe("apl hook pr-changed", () => {
  test(
    "resolves the branch checked out in the hook's cwd and no other branch",
    async () => {
      const { repo, tip } = await createLinkedBranch("feature/billing");
      await using _repo = repo;
      await using gh = await createFakeGh();
      await startWorkBranch(repo, "feature/other");
      await apl(repo.dir, ["link", PLAN]);
      await git(repo.dir, ["checkout", "feature/billing"]);
      await gh.setPullRequests([pullRequest({ number: 12, headRefOid: tip })]);
      await using elsewhere = await createTempDir();

      const result = await apl(elsewhere.dir, ["hook", "pr-changed"], {
        env: gh.env,
        stdin: JSON.stringify({ cwd: repo.dir }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      const links = await readLinks(repo);
      expect(links.find((link) => link.branch === "feature/billing")?.pr).toBe(12);
      expect(links.find((link) => link.branch === "feature/other")?.pr).toBeNull();
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "resolves recent links when the checkout is already back on the default branch",
    async () => {
      const { repo, tip } = await createLinkedBranch();
      await using _repo = repo;
      await using gh = await createFakeGh();
      await git(repo.dir, ["checkout", "main"]);
      await gh.setPullRequests([
        pullRequest({
          state: "MERGED",
          headRefOid: tip,
          mergeCommit: { oid: await squashCommitOnMain(repo) },
          closedAt: new Date().toISOString(),
          mergedAt: new Date().toISOString(),
        }),
      ]);

      await apl(repo.dir, ["hook", "pr-changed"], {
        env: gh.env,
        stdin: JSON.stringify({ cwd: repo.dir }),
      });

      const [link] = await readLinks(repo);
      expect(link?.prState).toBe("merged");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "exits 0 and prints nothing when stdin is not JSON",
    async () => {
      const { repo } = await createLinkedBranch();
      await using _repo = repo;
      await using gh = await createFakeGh();

      const result = await apl(repo.dir, ["hook", "pr-changed"], {
        env: gh.env,
        stdin: "{ not json",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    },
    LINK_TEST_TIMEOUT_MS,
  );
});
