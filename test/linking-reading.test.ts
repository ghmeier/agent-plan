import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  addPlan,
  apl,
  createInitializedRepo,
  git,
  planLogMessages,
  type Repo,
  startWorkBranch,
} from "./harness";

/**
 * Every test builds a work branch, links docs, and reads them back through
 * several CLI calls. That can pass bun's 5s default while every test file runs
 * at once, and bun ignores setDefaultTimeout for concurrent tests, so each
 * test passes this instead.
 */
const LINK_TEST_TIMEOUT_MS = 20_000;

const BILLING = "plan/billing.md";
const INVOICES = "research/invoices.md";

function docWithTitle(title: string, body: string): string {
  return `---\ntitle: ${title}\nstatus: active\n---\n# ${title}\n\n${body}\n`;
}

/** A repo with two docs in the store, checked out on `main`. */
async function createRepoWithDocs(): Promise<Repo> {
  const repo = await createInitializedRepo();
  await addPlan(repo, BILLING, docWithTitle("Billing plan", "Charge customers monthly."));
  await addPlan(repo, INVOICES, docWithTitle("Invoice notes", "Invoices are PDFs."));
  return repo;
}

/** Starts `branch` and links each of `docs` to it, in order. Returns the branch tip. */
async function linkOnNewBranch(repo: Repo, branch: string, docs: string[]): Promise<string> {
  const tip = await startWorkBranch(repo, branch);
  for (const doc of docs) {
    const result = await apl(repo.dir, ["link", doc]);
    if (result.exitCode !== 0) throw new Error(`apl link ${doc} failed: ${result.stderr}`);
  }
  return tip;
}

interface ShownDoc {
  path: string;
  links: Array<{ branch: string; commit: string | null }>;
}

describe("apl show --branch", () => {
  test(
    "prints every doc linked to the current branch, in link order",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [INVOICES, BILLING]);

      const result = await apl(repo.dir, ["show", "--branch"]);

      expect(result.exitCode).toBe(0);
      const invoices = result.stdout.indexOf("Invoices are PDFs.");
      const billing = result.stdout.indexOf("Charge customers monthly.");
      expect(invoices).toBeGreaterThan(-1);
      expect(billing).toBeGreaterThan(invoices);
      expect(result.stdout).toContain("Title:   Invoice notes");
      expect(result.stdout).toContain("Title:   Billing plan");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "prints only the docs linked to the named branch",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);
      await linkOnNewBranch(repo, "feature/invoices", [INVOICES]);

      const result = await apl(repo.dir, ["show", "--branch", "feature/billing"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Charge customers monthly.");
      expect(result.stdout).not.toContain("Invoices are PDFs.");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "fails and suggests apl link when the branch has no linked docs",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);
      await startWorkBranch(repo, "feature/empty");

      const result = await apl(repo.dir, ["show", "--branch"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No docs are linked to branch 'feature/empty'");
      expect(result.stderr).toContain("apl link <doc>");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "skips a linked doc that was deleted from the store",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING, INVOICES]);
      await rm(join(repo.storeDir, BILLING));

      const result = await apl(repo.dir, ["show", "--branch"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Invoices are PDFs.");
      expect(result.stdout).not.toContain("Charge customers monthly.");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "leaves out a doc that was unlinked from the branch",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING, INVOICES]);
      await apl(repo.dir, ["unlink", INVOICES]);

      const result = await apl(repo.dir, ["show", "--branch"]);

      expect(result.stdout).toContain("Charge customers monthly.");
      expect(result.stdout).not.toContain("Invoices are PDFs.");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "--json wraps the object plain show --json prints for each doc",
    async () => {
      await using repo = await createRepoWithDocs();
      const tip = await linkOnNewBranch(repo, "feature/billing", [BILLING, INVOICES]);
      const plain = JSON.parse((await apl(repo.dir, ["show", BILLING, "--json"])).stdout);

      const result = await apl(repo.dir, ["show", "--branch", "--json"]);

      const shown = JSON.parse(result.stdout) as { branch: string; docs: ShownDoc[] };
      expect(shown.branch).toBe("feature/billing");
      expect(shown.docs.map((doc) => doc.path)).toEqual([BILLING, INVOICES]);
      expect(shown.docs[0]).toEqual(plain);
      expect(shown.docs[0]?.links).toMatchObject([{ branch: "feature/billing", commit: tip }]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "--section prints the matching section of each doc and --outline lists each doc's headings",
    async () => {
      await using repo = await createRepoWithDocs();
      await addPlan(repo, "plan/second.md", "# Second\n\n## Rollout\n\nShip it slowly.\n");
      await addPlan(repo, "plan/third.md", "# Third\n\n## Rollout\n\nShip it fast.\n");
      await linkOnNewBranch(repo, "feature/rollout", ["plan/second.md", "plan/third.md"]);

      const section = await apl(repo.dir, ["show", "--branch", "--section", "Rollout"]);
      const outline = await apl(repo.dir, ["show", "--branch", "--outline"]);

      expect(section.stdout).toContain("Ship it slowly.");
      expect(section.stdout).toContain("Ship it fast.");
      expect(outline.stdout).toContain("# Second");
      expect(outline.stdout).toContain("# Third");
      expect(outline.stdout).not.toContain("Ship it slowly.");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "--raw prints each doc without its metadata header",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);

      const result = await apl(repo.dir, ["show", "--branch", "--raw"]);

      expect(result.stdout).toStartWith("---\ntitle: Billing plan");
      expect(result.stdout).not.toContain("Title:   Billing plan");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "fails when given both a path and --branch, or neither",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);

      const both = await apl(repo.dir, ["show", BILLING, "--branch"]);
      const neither = await apl(repo.dir, ["show"]);

      expect(both.exitCode).toBe(1);
      expect(both.stderr).toContain("not both");
      expect(neither.exitCode).toBe(1);
      expect(neither.stderr).toContain("--branch");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "does not record a working link that has not been recorded yet",
    async () => {
      await using repo = await createRepoWithDocs();
      await startWorkBranch(repo, "feature/billing");
      await git(repo.dir, ["config", "--add", "branch.feature/billing.apl-doc", BILLING]);
      const before = await planLogMessages(repo, ["--links"]);

      const result = await apl(repo.dir, ["show", "--branch"]);

      expect(result.exitCode).toBe(1);
      expect(await planLogMessages(repo, ["--links"])).toEqual(before);
    },
    LINK_TEST_TIMEOUT_MS,
  );
});

interface ListedDoc {
  file: string;
  links: Array<{
    branch: string;
    commit: string | null;
  }>;
}

describe("apl ls --branch", () => {
  test(
    "lists the docs linked to the branch and leaves out the others",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);

      const result = await apl(repo.dir, ["ls", "--branch", "feature/billing", "--short"]);

      expect(result.stdout.trim().split("\n")).toEqual([BILLING]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "lists nothing for a branch with no links",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);

      const result = await apl(repo.dir, ["ls", "--branch", "feature/other", "--short"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No files found");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "combines with the other filters",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING, INVOICES]);

      const plans = await apl(repo.dir, [
        "ls",
        "--branch",
        "feature/billing",
        "--type",
        "plan",
        "--short",
      ]);

      expect(plans.stdout.trim().split("\n")).toEqual([BILLING]);
    },
    LINK_TEST_TIMEOUT_MS,
  );
});

describe("the links field of --json output", () => {
  test(
    "show --json has an empty links array for a doc nothing links to",
    async () => {
      await using repo = await createRepoWithDocs();

      const result = await apl(repo.dir, ["show", BILLING, "--json"]);

      expect(JSON.parse(result.stdout).links).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "show --json lists each branch the doc is linked to",
    async () => {
      await using repo = await createRepoWithDocs();
      const firstTip = await linkOnNewBranch(repo, "feature/one", [BILLING]);
      await git(repo.dir, ["checkout", "main"]);
      const secondTip = await linkOnNewBranch(repo, "feature/two", [BILLING]);

      const result = await apl(repo.dir, ["show", BILLING, "--json"]);

      expect(JSON.parse(result.stdout).links).toEqual([
        { branch: "feature/one", commit: firstTip },
        { branch: "feature/two", commit: secondTip },
      ]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "ls --json gives linked docs their links and unlinked docs an empty array",
    async () => {
      await using repo = await createRepoWithDocs();
      const tip = await linkOnNewBranch(repo, "feature/billing", [BILLING]);

      const result = await apl(repo.dir, ["ls", "--json"]);

      const { files } = JSON.parse(result.stdout) as { files: ListedDoc[] };
      const byFile = new Map(files.map((entry) => [entry.file, entry]));
      expect(byFile.get(BILLING)?.links).toEqual([{ branch: "feature/billing", commit: tip }]);
      expect(byFile.get(INVOICES)?.links).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "show --json keeps its existing fields and adds links after them",
    async () => {
      await using repo = await createRepoWithDocs();

      const result = await apl(repo.dir, ["show", BILLING, "--json"]);

      expect(Object.keys(JSON.parse(result.stdout))).toEqual([
        "path",
        "type",
        "content",
        "meta",
        "body",
        "links",
      ]);
    },
    LINK_TEST_TIMEOUT_MS,
  );
});

describe("apl log --links", () => {
  test(
    "hides the commits that record links by default",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);

      const messages = await planLogMessages(repo);

      expect(messages.some((message) => message.startsWith("Link feature/billing"))).toBe(false);
      expect(messages).toContain("Add plan/billing.md");
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "shows them with --links",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);

      const messages = await planLogMessages(repo, ["--links"]);

      expect(messages).toContain(`Link feature/billing to ${BILLING}`);
      expect(messages).toContain("Add plan/billing.md");
    },
    LINK_TEST_TIMEOUT_MS,
  );
});

describe("apl links --edits", () => {
  async function editLogMessages(repo: Repo): Promise<string[]> {
    const result = await apl(repo.dir, [
      "links",
      BILLING,
      "--branch",
      "feature/billing",
      "--edits",
      "--json",
    ]);
    if (result.exitCode !== 0) throw new Error(`apl links --edits failed: ${result.stderr}`);
    const { edits } = JSON.parse(result.stdout) as { edits: Array<{ message: string }> };
    return edits.map((edit) => edit.message);
  }

  test(
    "includes an edit made after linking and excludes one made before",
    async () => {
      await using repo = await createRepoWithDocs();
      await addPlan(repo, BILLING, "# Billing\n\nBefore.\n", "Edit before linking");
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);
      await addPlan(repo, BILLING, "# Billing\n\nAfter.\n", "Edit after linking");

      const edits = await editLogMessages(repo);

      expect(edits).toEqual(["Edit after linking"]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "leaves out edits to other docs",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);
      await addPlan(repo, INVOICES, "# Invoices\n", "Edit other doc");

      expect(await editLogMessages(repo)).toEqual([]);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "prints rows like apl log without --json",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);
      await addPlan(repo, BILLING, "# Billing\n\nAfter.\n", "Edit after linking");

      const result = await apl(repo.dir, ["links", BILLING, "--branch", "--edits"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^[0-9a-f]{7} \d{4}-\d{2}-\d{2}T\S+ Edit after linking$/m);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "needs both a doc and --branch",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);

      const noBranch = await apl(repo.dir, ["links", BILLING, "--edits"]);
      const noDoc = await apl(repo.dir, ["links", "--branch", "feature/billing", "--edits"]);

      expect(noBranch.exitCode).toBe(1);
      expect(noBranch.stderr).toContain("--edits needs a doc and --branch");
      expect(noDoc.exitCode).toBe(1);
      expect(noDoc.stderr).toContain("--edits needs a doc and --branch");
    },
    LINK_TEST_TIMEOUT_MS,
  );
});

describe("session start hook", () => {
  test(
    "lists the docs linked to the branch the session starts on",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING, INVOICES]);

      const result = await apl(repo.dir, ["hook", "session-start"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "Docs linked to this branch (read them with `apl show --branch`):",
      );
      expect(result.stdout).toContain(`- ${BILLING}: Billing plan`);
      expect(result.stdout).toContain(`- ${INVOICES}: Invoice notes`);
    },
    LINK_TEST_TIMEOUT_MS,
  );

  test(
    "lists nothing on the default branch or on a branch without links",
    async () => {
      await using repo = await createRepoWithDocs();
      await linkOnNewBranch(repo, "feature/billing", [BILLING]);
      await startWorkBranch(repo, "feature/empty");

      const unlinked = await apl(repo.dir, ["hook", "session-start"]);
      await git(repo.dir, ["checkout", "main"]);
      const onDefault = await apl(repo.dir, ["hook", "session-start"]);

      expect(unlinked.exitCode).toBe(0);
      expect(unlinked.stdout).not.toContain("Docs linked to this branch");
      expect(onDefault.exitCode).toBe(0);
      expect(onDefault.stdout).not.toContain("Docs linked to this branch");
    },
    LINK_TEST_TIMEOUT_MS,
  );
});
