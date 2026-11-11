import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  addPlan,
  apl,
  createInitializedRepo,
  createSecondaryCheckout,
  git,
  planLogMessages,
  type Repo,
  readLinks,
  run,
  startWorkBranch,
} from "./harness";

/**
 * Each test builds a repo and a work branch and runs the CLI several times,
 * which can pass bun's 5s default while every test file runs at once. Bun
 * ignores setDefaultTimeout for concurrent tests, so each passes this.
 */
const LINK_TEST_TIMEOUT_MS = 20_000;

const PLAN = "plan/billing.md";

/** A repo with one plan in the store, checked out on `main`. */
async function createRepoWithPlan(): Promise<Repo> {
  const repo = await createInitializedRepo();
  await addPlan(repo, PLAN, "# Billing\n");
  return repo;
}

/** Docs linked to `branch` in git config, which is what automatic linking writes. */
async function workingLinks(repo: Repo, branch: string): Promise<string[]> {
  const result = await run(
    ["git", "config", "--local", "--get-all", `branch.${branch}.apl-doc`],
    repo.dir,
  );
  return result.stdout.split("\n").filter(Boolean);
}

/** Runs the hook the way the plugin does: the hook's JSON on stdin. */
function docTouched(cwd: string, hookInput: unknown) {
  const stdin = typeof hookInput === "string" ? hookInput : JSON.stringify(hookInput);
  return apl(cwd, ["hook", "doc-touched"], { stdin });
}

describe("apl show links the doc it reads", () => {
  test(
    "show on a work branch links the doc to that branch",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");

      const result = await apl(repo.dir, ["show", PLAN]);

      expect(result.exitCode).toBe(0);
      expect(await workingLinks(repo, "feature/billing")).toEqual([PLAN]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "show links the real path when it is given without the .md extension",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");

      await apl(repo.dir, ["show", "plan/billing"]);

      expect(await workingLinks(repo, "feature/billing")).toEqual([PLAN]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "show on the default branch links nothing",
    async () => {
      await using repo = await createRepoWithPlan();

      const result = await apl(repo.dir, ["show", PLAN]);

      expect(result.exitCode).toBe(0);
      expect(await workingLinks(repo, "main")).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "show on a detached HEAD links nothing",
    async () => {
      await using repo = await createRepoWithPlan();
      await git(repo.dir, ["checkout", "--detach"]);

      const result = await apl(repo.dir, ["show", PLAN]);

      expect(result.exitCode).toBe(0);
      expect(await readLinks(repo)).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "show prints the same text and JSON whether or not it links",
    async () => {
      await using repo = await createRepoWithPlan();
      const onDefaultText = await apl(repo.dir, ["show", PLAN]);
      const onDefaultJson = await apl(repo.dir, ["show", PLAN, "--json"]);
      await startWorkBranch(repo, "feature/billing");

      const onBranchText = await apl(repo.dir, ["show", PLAN]);
      const onBranchJson = await apl(repo.dir, ["show", PLAN, "--json"]);

      expect(onBranchText.stdout).toBe(onDefaultText.stdout);
      expect(onBranchText.stderr).toBe("");
      expect(onBranchJson.stdout).toBe(onDefaultJson.stdout);
      expect(await workingLinks(repo, "feature/billing")).toEqual([PLAN]);
    },
    LINK_TEST_TIMEOUT_MS,
  );
});

describe("apl hook doc-touched", () => {
  test(
    "links a doc read through the checkout's .apl path",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");

      const result = await docTouched(repo.dir, {
        cwd: repo.dir,
        tool_input: { file_path: join(repo.storeDir, PLAN) },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(await workingLinks(repo, "feature/billing")).toEqual([PLAN]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "links the branch of the checkout in cwd when the path goes through the main checkout",
    async () => {
      await using repo = await createRepoWithPlan();
      await using worktree = await createSecondaryCheckout(repo);
      await git(worktree.dir, ["checkout", "-b", "feature/worktree"]);

      const result = await docTouched(worktree.dir, {
        cwd: worktree.dir,
        tool_input: { file_path: join(repo.storeDir, PLAN) },
      });

      expect(result.exitCode).toBe(0);
      expect(await workingLinks(repo, "feature/worktree")).toEqual([PLAN]);
      expect(await workingLinks(repo, "main")).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "ignores the branch of the main checkout when cwd is a detached worktree",
    async () => {
      await using repo = await createRepoWithPlan();
      await using worktree = await createSecondaryCheckout(repo);
      await git(worktree.dir, ["checkout", "--detach"]);
      await git(repo.dir, ["checkout", "-b", "feature/main-checkout"]);

      const result = await docTouched(worktree.dir, {
        cwd: worktree.dir,
        tool_input: { file_path: join(repo.storeDir, PLAN) },
      });

      expect(result.exitCode).toBe(0);
      expect(await workingLinks(repo, "feature/main-checkout")).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "links nothing for a file that is not a doc",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");

      const result = await docTouched(repo.dir, {
        cwd: repo.dir,
        tool_input: { file_path: join(repo.storeDir, "config.json") },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(await workingLinks(repo, "feature/billing")).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "links nothing for a markdown file outside the store",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");
      await Bun.write(join(repo.dir, "NOTES.md"), "# Notes\n");

      const result = await docTouched(repo.dir, {
        cwd: repo.dir,
        tool_input: { file_path: join(repo.dir, "NOTES.md") },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(await workingLinks(repo, "feature/billing")).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "exits 0 and prints nothing on malformed input",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");

      const notJson = await docTouched(repo.dir, "not json");
      const noFilePath = await docTouched(repo.dir, { cwd: repo.dir, tool_input: {} });
      const badCwd = await docTouched(repo.dir, {
        cwd: join(repo.dir, "missing"),
        tool_input: { file_path: join(repo.storeDir, PLAN) },
      });

      for (const result of [notJson, noFilePath, badCwd]) {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
      }
      expect(await workingLinks(repo, "feature/billing")).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );
});

describe("recording automatic links", () => {
  test(
    "an automatic link is recorded on the docs branch by the next commit",
    async () => {
      await using repo = await createRepoWithPlan();
      const tip = await startWorkBranch(repo, "feature/billing");
      await apl(repo.dir, ["show", PLAN]);

      const commit = await apl(repo.dir, ["commit"]);

      expect(commit.exitCode).toBe(0);
      expect((await planLogMessages(repo))[0]).toBe("Link feature/billing to plan/billing.md");
      const [link, ...rest] = await readLinks(repo);
      expect(rest).toEqual([]);
      expect(link?.branch).toBe("feature/billing");
      expect(link?.docs).toEqual([PLAN]);
      expect(link?.commit).toBe(tip);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "reading a doc writes no docs-branch commit by itself",
    async () => {
      await using repo = await createRepoWithPlan();
      await startWorkBranch(repo, "feature/billing");
      const before = await git(repo.storeDir, ["rev-parse", "HEAD"]);

      await apl(repo.dir, ["show", PLAN]);

      expect(await git(repo.storeDir, ["rev-parse", "HEAD"])).toBe(before);
    },
    LINK_TEST_TIMEOUT_MS,
  );
});
