import { describe, expect, test } from "bun:test";
import {
  addOrigin,
  addPlan,
  apl,
  commitCode,
  createInitializedRepo,
  createRemote,
  createRepo,
  createSecondaryCheckout,
  git,
  planLogMessages,
  type Repo,
  readLinks,
  startWorkBranch,
} from "./harness";

/**
 * Every test here runs git and the CLI many times: it builds a work branch,
 * links it, and reads the links back. That can pass bun's 5s default while
 * every test file runs at once, and bun ignores setDefaultTimeout for
 * concurrent tests, so each test passes this instead.
 */
const LINK_TEST_TIMEOUT_MS = 20_000;

const PLAN = "plan/billing.md";

/** A repo with one plan in the store, checked out on `main`. */
async function createRepoWithPlan(): Promise<Repo> {
  const repo = await createInitializedRepo();
  await addPlan(repo, PLAN, "# Billing\n");
  return repo;
}

describe("apl link", () => {
  test(
    "link records the current branch and its tip against the doc",
    async () => {
      await using repo = await createRepoWithPlan();
      const tip = await startWorkBranch(repo, "feature/billing");

      const result = await apl(repo.dir, ["link", PLAN]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Linked ${PLAN} to feature/billing`);
      const [link, ...rest] = await readLinks(repo);
      expect(rest).toEqual([]);
      expect(link?.branch).toBe("feature/billing");
      expect(link?.docs).toEqual([PLAN]);
      expect(link?.commit).toBe(tip);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "link accepts a doc path without the .md extension or with the .apl/ prefix",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/short");
      await startWorkBranch(repo, "feature/prefixed");

      await apl(repo.dir, ["link", "plan/billing", "--branch", "feature/short"]);
      await apl(repo.dir, ["link", `.apl/${PLAN}`, "--branch", "feature/prefixed"]);

      const linkedDocs = (await readLinks(repo)).map((link) => link.docs);
      expect(linkedDocs).toEqual([[PLAN], [PLAN]]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "link --branch links a branch other than the one checked out",
    async () => {
      await using repo = await createRepoWithPlan();
      const tip = await startWorkBranch(repo, "feature/billing");
      await git(repo.dir, ["checkout", "main"]);

      const result = await apl(repo.dir, ["link", PLAN, "--branch", "feature/billing"]);

      expect(result.exitCode).toBe(0);
      const [link] = await readLinks(repo);
      expect(link?.branch).toBe("feature/billing");
      expect(link?.commit).toBe(tip);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "link refuses the default branch",
    async () => {
      await using repo = await createRepoWithPlan();

      const result = await apl(repo.dir, ["link", PLAN]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("'main' is the default branch");
      expect(await readLinks(repo)).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "link refuses a doc that is not in the store",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");

      const result = await apl(repo.dir, ["link", "plan/missing.md"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("File not found: plan/missing.md");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "link refuses a branch that does not exist",
    async () => {
      await using repo = await createRepoWithPlan();

      const result = await apl(repo.dir, ["link", PLAN, "--branch", "feature/absent"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No local branch named 'feature/absent'");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "linking the same doc twice adds no second record",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");
      await apl(repo.dir, ["link", PLAN]);
      const messagesAfterFirstLink = await planLogMessages(repo, ["--links"]);

      const result = await apl(repo.dir, ["link", PLAN]);

      expect(result.stdout).toContain("already linked");
      expect(await planLogMessages(repo, ["--links"])).toEqual(messagesAfterFirstLink);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a second doc linked to the same branch joins the existing link",
    async () => {
      await using repo = await createRepoWithPlan();
      await addPlan(repo, "research/billing-providers.md", "# Providers\n");
      await startWorkBranch(repo, "feature/billing");
      await apl(repo.dir, ["link", PLAN]);

      await apl(repo.dir, ["link", "research/billing-providers.md"]);

      const [link, ...rest] = await readLinks(repo);
      expect(rest).toEqual([]);
      expect(link?.docs).toEqual([PLAN, "research/billing-providers.md"]);
    },
    LINK_TEST_TIMEOUT_MS,
  );
});

describe("recording linked branches", () => {
  test(
    "commit records the new tip of a linked branch that has moved",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");
      await apl(repo.dir, ["link", PLAN]);
      const newTip = await commitCode(repo, "more.txt");

      const result = await apl(repo.dir, ["commit"]);

      expect(result.stdout).toContain("Recorded links for 1 branch");
      const [link] = await readLinks(repo);
      expect(link?.commit).toBe(newTip);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "commit records nothing for a linked branch that has not moved",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");
      await apl(repo.dir, ["link", PLAN]);
      const messagesAfterLink = await planLogMessages(repo, ["--links"]);

      const result = await apl(repo.dir, ["commit"]);

      expect(result.stdout).toContain("Nothing to commit");
      expect(await planLogMessages(repo, ["--links"])).toEqual(messagesAfterLink);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a commit from the main checkout records work done in another checkout",
    async () => {
      await using repo = await createRepoWithPlan();
      await using implementer = await createSecondaryCheckout(repo);
      const branch = await git(implementer.dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      await apl(implementer.dir, ["link", PLAN]);
      const implementerTip = await commitCode(implementer, "work.txt");

      await apl(repo.dir, ["commit"]);

      const [link] = await readLinks(repo);
      expect(link?.branch).toBe(branch);
      expect(link?.commit).toBe(implementerTip);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a local branch behind the recorded tip does not replace it",
    async () => {
      await using repo = await createRepoWithPlan();
      const olderTip = await startWorkBranch(repo, "feature/billing");
      const recordedTip = await commitCode(repo, "more.txt");
      await apl(repo.dir, ["link", PLAN]);
      await git(repo.dir, ["reset", "--hard", olderTip]);

      await apl(repo.dir, ["commit"]);

      const [link] = await readLinks(repo);
      expect(link?.commit).toBe(recordedTip);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "a link outlives the branch being deleted",
    async () => {
      await using repo = await createRepoWithPlan();
      const tip = await startWorkBranch(repo, "feature/billing");
      await apl(repo.dir, ["link", PLAN]);
      await git(repo.dir, ["checkout", "main"]);

      await git(repo.dir, ["branch", "-D", "feature/billing"]);
      await apl(repo.dir, ["commit"]);

      const [link] = await readLinks(repo, [PLAN]);
      expect(link?.branch).toBe("feature/billing");
      expect(link?.commit).toBe(tip);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "sync publishes a link, rebased onto a teammate's doc changes",
    async () => {
      await using remote = await createRemote();
      await using repo = await createRepoWithPlan();
      await addOrigin(repo, remote);
      await apl(repo.dir, ["sync"]);
      await using teammate = await createRepo();
      await addOrigin(teammate, remote);
      await apl(teammate.dir, ["init"]);
      await addPlan(teammate, "plan/search.md", "# Search\n");
      await apl(teammate.dir, ["sync"]);
      const tip = await startWorkBranch(repo, "feature/billing");
      await apl(repo.dir, ["link", PLAN]);

      const result = await apl(repo.dir, ["sync"]);
      await apl(teammate.dir, ["pull"]);

      expect(result.exitCode).toBe(0);
      const [link] = await readLinks(teammate);
      expect(link?.branch).toBe("feature/billing");
      expect(link?.docs).toEqual([PLAN]);
      expect(link?.commit).toBe(tip);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "sync --if-changed publishes a moved tip when no doc was edited",
    async () => {
      await using remote = await createRemote();
      await using repo = await createRepoWithPlan();
      await addOrigin(repo, remote);
      await startWorkBranch(repo, "feature/billing");
      await apl(repo.dir, ["link", PLAN]);
      await apl(repo.dir, ["sync"]);
      const newTip = await commitCode(repo, "more.txt");

      const result = await apl(repo.dir, ["sync", "--if-changed"]);

      expect(result.exitCode).toBe(0);
      expect(await git(remote.dir, ["log", "-1", "--format=%b", "apl"])).toContain(
        `Code-Commit: ${newTip}`,
      );
    },
    LINK_TEST_TIMEOUT_MS,
  );
});

describe("apl links", () => {
  /** Two work branches: one linked to PLAN, the other to a second plan. */
  async function createRepoWithTwoLinks(): Promise<Repo> {
    const repo = await createRepoWithPlan();
    await addPlan(repo, "plan/search.md", "# Search\n");
    await startWorkBranch(repo, "feature/billing");
    await apl(repo.dir, ["link", PLAN]);
    await startWorkBranch(repo, "feature/search");
    await apl(repo.dir, ["link", "plan/search.md"]);
    return repo;
  }

  test(
    "links lists every link, newest first",
    async () => {
      await using repo = await createRepoWithTwoLinks();

      const branches = (await readLinks(repo)).map((link) => link.branch);

      expect(branches).toEqual(["feature/search", "feature/billing"]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "links <doc> lists only the branches linked to that doc",
    async () => {
      await using repo = await createRepoWithTwoLinks();

      const branches = (await readLinks(repo, [PLAN])).map((link) => link.branch);

      expect(branches).toEqual(["feature/billing"]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "links --branch <name> lists only that branch's docs",
    async () => {
      await using repo = await createRepoWithTwoLinks();

      const docs = (await readLinks(repo, ["--branch", "feature/billing"])).map(
        (link) => link.docs,
      );

      expect(docs).toEqual([[PLAN]]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "links --branch without a name uses the branch checked out",
    async () => {
      await using repo = await createRepoWithTwoLinks();

      const branches = (await readLinks(repo, ["--branch"])).map((link) => link.branch);

      expect(branches).toEqual(["feature/search"]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "links prints one tab-separated row per branch and doc when piped",
    async () => {
      await using repo = await createRepoWithPlan();
      const tip = await startWorkBranch(repo, "feature/billing");
      await apl(repo.dir, ["link", PLAN]);

      const result = await apl(repo.dir, ["links"]);

      const [header, row] = result.stdout.trim().split("\n");
      expect(header).toBe("BRANCH\tDOC\tCOMMIT\tUPDATED");
      expect(row?.split("\t").slice(0, 3)).toEqual(["feature/billing", PLAN, tip.slice(0, 7)]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "links says so when there are none",
    async () => {
      await using repo = await createRepoWithPlan();

      const result = await apl(repo.dir, ["links"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No links found");
    },
    LINK_TEST_TIMEOUT_MS,
  );
});

describe("apl unlink", () => {
  test(
    "unlink removes the doc from the branch's link",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");
      await apl(repo.dir, ["link", PLAN]);

      const result = await apl(repo.dir, ["unlink", PLAN]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Unlinked ${PLAN} from feature/billing`);
      expect(await readLinks(repo)).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "an unlinked doc is not linked again by the next commit",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");
      await apl(repo.dir, ["link", PLAN]);
      await apl(repo.dir, ["unlink", PLAN]);
      await commitCode(repo, "more.txt");

      await apl(repo.dir, ["commit"]);

      expect(await readLinks(repo)).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "unlink removes a link to a branch that was deleted",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");
      await apl(repo.dir, ["link", PLAN]);
      await git(repo.dir, ["checkout", "main"]);
      await git(repo.dir, ["branch", "-D", "feature/billing"]);

      const result = await apl(repo.dir, ["unlink", PLAN, "--branch", "feature/billing"]);

      expect(result.exitCode).toBe(0);
      expect(await readLinks(repo)).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "unlink fails for a doc that is not linked to the branch",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");

      const result = await apl(repo.dir, ["unlink", PLAN]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`${PLAN} is not linked to feature/billing`);
    },
    LINK_TEST_TIMEOUT_MS,
  );
});
