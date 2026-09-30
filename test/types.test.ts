import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  addPlan,
  apl,
  createInitializedRepo,
  planLogMessages,
  type Repo,
  writeStoreConfig,
} from "./harness";

async function showJson(repo: Repo, docPath: string): Promise<Record<string, unknown>> {
  return JSON.parse((await apl(repo.dir, ["show", docPath, "--json"])).stdout);
}

async function typeNames(repo: Repo): Promise<string[]> {
  const { types } = JSON.parse((await apl(repo.dir, ["types", "--json"])).stdout);
  return types.map((type: { name: string }) => type.name);
}

describe("apl types", () => {
  test("types lists the built-in types when the store has no config", async () => {
    await using repo = await createInitializedRepo();

    const { types } = JSON.parse((await apl(repo.dir, ["types", "--json"])).stdout);

    expect(types.map((t: { name: string }) => t.name)).toEqual(["plan", "research", "handoff"]);
    expect(types[2]).toMatchObject({
      statuses: ["open", "picked-up", "closed"],
      template: "builtin",
    });
  });

  test("types from a committed config.json replace the built-ins", async () => {
    await using repo = await createInitializedRepo();

    await writeStoreConfig(repo, { types: { adr: { statuses: ["proposed", "accepted"] } } });

    expect(await typeNames(repo)).toEqual(["adr"]);
  });

  test("a config.json without types keeps the built-ins", async () => {
    await using repo = await createInitializedRepo();

    await writeStoreConfig(repo, {});

    expect(await typeNames(repo)).toEqual(["plan", "research", "handoff"]);
  });

  test.each([
    { config: "{not json", problem: "could not parse JSON" },
    { config: '{"types": {"Bad Name": {}}}', problem: 'type name "Bad Name"' },
    { config: '{"types": {"adr": {"defaultStatus": "nope"}}}', problem: '"defaultStatus"' },
  ])(
    "an invalid config.json fails and names the problem: $problem",
    async ({ config, problem }) => {
      await using repo = await createInitializedRepo();
      await Bun.write(join(repo.storeDir, "config.json"), config);

      const result = await apl(repo.dir, ["types"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("config.json");
      expect(result.stderr).toContain(problem);
    },
  );
});

describe("apl new", () => {
  test("new creates a doc from the type's template, prints its path, and doesn't commit", async () => {
    await using repo = await createInitializedRepo();

    const result = await apl(repo.dir, ["new", "research", "billing/stripe-webhooks"]);

    expect(result.stdout).toBe(`${join(repo.storeDir, "research/billing/stripe-webhooks.md")}\n`);
    const doc = await showJson(repo, "research/billing/stripe-webhooks.md");
    expect(doc.type).toBe("research");
    expect(doc.meta).toMatchObject({ title: "stripe-webhooks", status: "draft", tags: [] });
    expect(doc.body).toContain("## Findings");
    expect(await planLogMessages(repo)).toEqual(["Initialize docs"]);
  });

  test("new uses --title and every --tag", async () => {
    await using repo = await createInitializedRepo();

    await apl(repo.dir, [
      "new",
      "plan",
      "auth",
      "--title",
      "Auth: phase 2",
      "--tag",
      "a",
      "--tag",
      "b",
    ]);

    const doc = await showJson(repo, "plan/auth.md");
    expect(doc.meta).toMatchObject({ title: "Auth: phase 2", tags: ["a", "b"] });
  });

  test("new starts a doc at its type's default status", async () => {
    await using repo = await createInitializedRepo();

    await apl(repo.dir, ["new", "handoff", "session-3"]);

    expect((await showJson(repo, "handoff/session-3.md")).meta).toMatchObject({ status: "open" });
  });

  test("new fills a custom template from .templates/", async () => {
    await using repo = await createInitializedRepo();
    const template = "---\ntitle: {{title}}\nstatus: {{status}}\n---\n# {{type}}: {{title}}\n";
    await Bun.write(join(repo.storeDir, ".templates", "plan.md"), template);

    await apl(repo.dir, ["new", "plan", "search"]);

    expect((await showJson(repo, "plan/search.md")).body).toBe("# plan: search\n");
    expect((await apl(repo.dir, ["ls", "--short"])).stdout).toBe("plan/search.md\n");
  });

  test("new --json returns the doc's store path, absolute path, and type", async () => {
    await using repo = await createInitializedRepo();

    const result = await apl(repo.dir, ["new", "plan", "auth", "--json"]);

    expect(JSON.parse(result.stdout)).toEqual({
      path: "plan/auth.md",
      absolutePath: join(repo.storeDir, "plan/auth.md"),
      type: "plan",
    });
  });

  test("new refuses to overwrite an existing doc", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "plan", "auth.md"), "# Mine\n");

    const result = await apl(repo.dir, ["new", "plan", "auth"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("plan/auth.md already exists");
    expect(await Bun.file(join(repo.storeDir, "plan", "auth.md")).text()).toBe("# Mine\n");
  });

  test("new with an unknown type fails and lists the valid ones", async () => {
    await using repo = await createInitializedRepo();

    const result = await apl(repo.dir, ["new", "memo", "x"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Valid types: plan, research, handoff");
  });

  test.each(["../escape", "/abs", "a//b", ".hidden"])("new rejects the name %p", async (name) => {
    await using repo = await createInitializedRepo();

    const result = await apl(repo.dir, ["new", "plan", name]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid doc name");
  });
});

describe("types in add, ls, and show", () => {
  test("add --type stores the file under the type's directory", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.dir, "docs", "notes.md"), "# Notes\n");

    await apl(repo.dir, ["add", "--type", "research", "docs/notes.md"]);

    expect((await apl(repo.dir, ["ls", "--short"])).stdout).toBe("research/docs/notes.md\n");
  });

  test("add --type with an unknown type fails without committing", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.dir, "notes.md"), "# Notes\n");

    const result = await apl(repo.dir, ["add", "--type", "memo", "notes.md"]);

    expect(result.exitCode).toBe(1);
    expect(await planLogMessages(repo)).toEqual(["Initialize docs"]);
  });

  test("ls --type lists only docs of that type, leaving out untyped ones", async () => {
    await using repo = await createInitializedRepo();
    await apl(repo.dir, ["new", "handoff", "a"]);
    await apl(repo.dir, ["new", "plan", "b"]);
    await addPlan(repo, "handoff-notes.md", "# Not in a type directory\n");

    const result = await apl(repo.dir, ["ls", "--type", "handoff", "--short"]);

    expect(result.stdout).toBe("handoff/a.md\n");
  });

  test("ls --json gives each doc's type, or null outside a type directory", async () => {
    await using repo = await createInitializedRepo();
    await apl(repo.dir, ["new", "plan", "b"]);
    await addPlan(repo, "archive/old.md", "# Old\n");

    const { files } = JSON.parse((await apl(repo.dir, ["ls", "--json"])).stdout);

    expect(files.map((f: { file: string; type: string | null }) => [f.file, f.type])).toEqual([
      ["plan/b.md", "plan"],
      ["archive/old.md", null],
    ]);
  });

  test("a status valid only for another type is ignored with a warning", async () => {
    await using repo = await createInitializedRepo();
    await Bun.write(join(repo.storeDir, "research", "r.md"), "---\nstatus: open\n---\n");

    const result = await apl(repo.dir, ["ls", "--status", "open", "--short"]);

    expect(result.stdout).not.toContain("research/r.md");
    expect(result.stderr).toContain('Unknown status value "open" in research/r.md');
  });

  test("show prints the doc's type in its header", async () => {
    await using repo = await createInitializedRepo();
    await apl(repo.dir, ["new", "plan", "auth"]);

    const result = await apl(repo.dir, ["show", "plan/auth.md"]);

    expect(result.stdout).toContain("Type:    plan");
  });
});
