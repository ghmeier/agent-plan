import { describe, expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  addPlan,
  apl,
  createInitializedRepo,
  createSecondaryCheckout,
  git,
  planLogMessages,
  type Repo,
} from "./harness";

async function commitCodeChange(repo: Repo, message: string): Promise<void> {
  await Bun.write(join(repo.dir, "src.txt"), message);
  await git(repo.dir, ["add", "src.txt"]);
  await git(repo.dir, ["commit", "-m", message]);
}

describe("multiple checkouts of one repo", () => {
  test("plans added in either checkout are visible in the other", async () => {
    await using main = await createInitializedRepo();
    await using secondary = await createSecondaryCheckout(main);

    await addPlan(main, "from-main.md", "# Main\n");
    await addPlan(secondary, "from-secondary.md", "# Secondary\n");

    for (const checkout of [main, secondary]) {
      const result = await apl(checkout.dir, ["ls", "--short"]);
      expect(result.stdout).toBe("from-main.md\nfrom-secondary.md\n");
    }
  });

  test("edits made through one checkout's .plans can be committed from the other", async () => {
    await using main = await createInitializedRepo();
    await using secondary = await createSecondaryCheckout(main);
    await apl(secondary.dir, ["ls"]);
    await Bun.write(join(secondary.plansDir, "draft.md"), "# Draft\n");

    const result = await apl(main.dir, ["commit", "-m", "Commit draft"]);

    expect(result.exitCode).toBe(0);
    expect((await apl(secondary.dir, ["diff"])).stdout).toBe("No changes\n");
    expect(await planLogMessages(secondary, ["-n", "1"])).toEqual(["Commit draft"]);
  });

  test("a secondary checkout refuses to replace a .plans directory that apl does not manage", async () => {
    await using main = await createInitializedRepo();
    await using secondary = await createSecondaryCheckout(main);
    await Bun.write(join(secondary.plansDir, "notes.md"), "my notes");

    const result = await apl(secondary.dir, ["ls", "--short"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already exists and is not managed by apl");
    expect(await Bun.file(join(secondary.plansDir, "notes.md")).text()).toBe("my notes");
  });

  test("the secondary checkout's code repo ignores its .plans", async () => {
    await using main = await createInitializedRepo();
    await using secondary = await createSecondaryCheckout(main);

    await addPlan(secondary, "plan.md", "# Plan\n");

    expect(await git(secondary.dir, ["status", "--porcelain", "--", ".plans"])).toBe("");
  });
});

describe("auto-commit hook", () => {
  test("with --auto-commit, a code commit also commits pending plan edits", async () => {
    await using repo = await createInitializedRepo();
    await apl(repo.dir, ["init", "--auto-commit"]);
    await Bun.write(join(repo.plansDir, "plan.md"), "# Plan\n");

    await commitCodeChange(repo, "Implement feature");

    const [latest] = await planLogMessages(repo, ["-n", "1"]);
    expect(latest).toMatch(/^Auto-commit: plan changes after [0-9a-f]+ Implement feature$/);
    expect((await apl(repo.dir, ["diff"])).stdout).toBe("No changes\n");
  });

  test("without --auto-commit, plan edits stay pending after a code commit", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.plansDir, "plan.md"), "# Plan\n");

    await commitCodeChange(repo, "Implement feature");

    expect(await planLogMessages(repo)).toEqual(["Initialize plans"]);
    expect((await apl(repo.dir, ["ls", "--short"])).stdout).toBe("plan.md\n");
  });

  test("--no-auto-commit stops auto-commits", async () => {
    await using repo = await createInitializedRepo();
    await apl(repo.dir, ["init", "--auto-commit"]);
    await apl(repo.dir, ["init", "--no-auto-commit"]);
    await Bun.write(join(repo.plansDir, "plan.md"), "# Plan\n");

    await commitCodeChange(repo, "Implement feature");

    expect(await planLogMessages(repo)).toEqual(["Initialize plans"]);
  });

  test("an existing post-commit hook keeps running through install and removal", async () => {
    await using repo = await createInitializedRepo();
    const hooksDir = join(repo.dir, ".git", "hooks");
    const hookPath = join(hooksDir, "post-commit");
    await mkdir(hooksDir, { recursive: true });
    const hookLog = join(repo.dir, "hook-runs.log");
    await Bun.write(hookPath, `#!/bin/sh\ngit log -1 --format=%s >> "${hookLog}"\n`);
    await chmod(hookPath, 0o755);

    await apl(repo.dir, ["init", "--auto-commit"]);
    await Bun.write(join(repo.plansDir, "plan.md"), "# Plan\n");
    await commitCodeChange(repo, "First");
    await apl(repo.dir, ["init", "--no-auto-commit"]);
    await Bun.write(join(repo.plansDir, "plan.md"), "# Plan, edited\n");
    await commitCodeChange(repo, "Second");

    const hookRuns = (await Bun.file(hookLog).text()).split("\n");
    expect(hookRuns).toContain("First");
    expect(hookRuns).toContain("Second");
    expect(await planLogMessages(repo)).toHaveLength(2);
    expect((await apl(repo.dir, ["diff", "--json"])).stdout).toContain('"changed":true');
  });
});
