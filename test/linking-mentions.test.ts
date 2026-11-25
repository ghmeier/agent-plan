import { describe, expect, test } from "bun:test";
import { addPlan, apl, createInitializedRepo, git, readLinks, startWorkBranch } from "./harness";

/**
 * Each test builds a repo and work branches and runs the CLI several times,
 * which can pass bun's 5s default while every test file runs at once. Bun
 * ignores setDefaultTimeout for concurrent tests, so each passes this.
 */
const LINK_TEST_TIMEOUT_MS = 20_000;

const PLAN = "plan/billing.md";

/** The docs linked to each branch, as `apl links` reports them. */
async function linkedDocsByBranch(repo: Parameters<typeof readLinks>[0]) {
  return Object.fromEntries((await readLinks(repo)).map((link) => [link.branch, link.docs]));
}

describe("linking docs to the branches they name", () => {
  test(
    "a doc that names a branch is linked to it with the branch's tip",
    async () => {
      await using repo = await createInitializedRepo();
      const tip = await startWorkBranch(repo, "feature/billing-retries");
      await git(repo.dir, ["checkout", "main"]);

      await addPlan(repo, PLAN, "# Billing\n\n- **Branch:** `feature/billing-retries`\n");

      const [link, ...rest] = await readLinks(repo);
      expect(rest).toEqual([]);
      expect(link?.branch).toBe("feature/billing-retries");
      expect(link?.docs).toEqual([PLAN]);
      expect(link?.commit).toBe(tip);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a branch created after the doc names it is linked by the next commit",
    async () => {
      await using repo = await createInitializedRepo();
      await addPlan(repo, PLAN, "# Billing\n\nPR 1 goes on feature/billing-retries.\n");
      await startWorkBranch(repo, "feature/billing-retries");

      await apl(repo.dir, ["commit"]);

      expect(await linkedDocsByBranch(repo)).toEqual({ "feature/billing-retries": [PLAN] });
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a branch whose name is only part of a longer name in the doc is not linked",
    async () => {
      await using repo = await createInitializedRepo();
      await startWorkBranch(repo, "feature/billing");
      await git(repo.dir, ["checkout", "main"]);

      await addPlan(
        repo,
        PLAN,
        "# Billing\n\nSee feature/billing-retries and src/feature/billing.\n",
      );

      expect(await readLinks(repo)).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a doc that names a branch's ticket key is linked to the branch",
    async () => {
      await using repo = await createInitializedRepo();
      await startWorkBranch(repo, "sc-123-billing-retries");
      await git(repo.dir, ["checkout", "main"]);

      await addPlan(repo, PLAN, "# Billing\n\nRetries are tracked in sc-123.\n");

      expect(await linkedDocsByBranch(repo)).toEqual({ "sc-123-billing-retries": [PLAN] });
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a doc that names a longer ticket key is not linked to the branch",
    async () => {
      await using repo = await createInitializedRepo();
      await startWorkBranch(repo, "sc-123-billing-retries");
      await git(repo.dir, ["checkout", "main"]);

      await addPlan(repo, PLAN, "# Billing\n\nRetries are tracked in sc-1234.\n");

      expect(await readLinks(repo)).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a single-word branch name is not linked from prose",
    async () => {
      await using repo = await createInitializedRepo();
      await startWorkBranch(repo, "billing");
      await git(repo.dir, ["checkout", "main"]);

      await addPlan(repo, PLAN, "# Billing\n\nThe billing service retries.\n");

      expect(await readLinks(repo)).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a doc unlinked from a branch it names is not linked again",
    async () => {
      await using repo = await createInitializedRepo();
      await startWorkBranch(repo, "feature/billing-retries");
      await addPlan(repo, PLAN, "# Billing\n\nOn feature/billing-retries.\n");
      await apl(repo.dir, ["unlink", PLAN]);

      await addPlan(repo, PLAN, "# Billing\n\nStill on feature/billing-retries.\n");

      expect(await readLinks(repo)).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a doc unlinked from a branch it names is linked again by apl link",
    async () => {
      await using repo = await createInitializedRepo();
      await startWorkBranch(repo, "feature/billing-retries");
      await addPlan(repo, PLAN, "# Billing\n\nOn feature/billing-retries.\n");
      await apl(repo.dir, ["unlink", PLAN]);

      await apl(repo.dir, ["link", PLAN]);

      expect(await linkedDocsByBranch(repo)).toEqual({ "feature/billing-retries": [PLAN] });
    },
    LINK_TEST_TIMEOUT_MS,
  );
});
