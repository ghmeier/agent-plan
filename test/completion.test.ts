import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  addPlan,
  apl,
  createInitializedRepo,
  createRepo,
  createTempDir,
  git,
  type Repo,
  run,
  writeStoreConfig,
} from "./harness";

function hasCommand(command: string): boolean {
  return Bun.spawnSync(["which", command], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

const HAS_BASH = hasCommand("bash");
const HAS_ZSH = hasCommand("zsh");
const HAS_FISH = hasCommand("fish");

async function completionScript(shell: "bash" | "zsh" | "fish"): Promise<string> {
  const result = await apl(import.meta.dir, ["completion", shell]);
  if (result.exitCode !== 0) throw new Error(`apl completion ${shell} failed: ${result.stderr}`);
  return result.stdout;
}

async function createRepoWithTaggedPlans(): Promise<Repo> {
  const repo = await createInitializedRepo();
  await addPlan(repo, "alpha.md", "---\nstatus: active\ntags: [cli, backend]\n---\n# Alpha\n");
  await addPlan(repo, "beta.md", "---\nstatus: draft\ntags: [docs]\n---\n# Beta\n");
  return repo;
}

/** A repo with `repo`'s docs branch fetched in, but no store checked out yet. */
async function cloneWithoutStore(repo: Repo): Promise<Repo> {
  const clone = await createRepo();
  await git(clone.dir, ["fetch", repo.dir, "apl:apl"]);
  return clone;
}

async function completeLines(cwd: string, args: string[]): Promise<string[]> {
  const result = await apl(cwd, ["__complete", ...args]);
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

describe("apl completion", () => {
  test("completion without a shell fails and lists the supported shells", async () => {
    const result = await apl(import.meta.dir, ["completion"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Specify a shell: bash, zsh, fish");
  });

  test("completion with an unsupported shell fails", async () => {
    const result = await apl(import.meta.dir, ["completion", "powershell"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unsupported shell "powershell"');
  });

  test("completion --install adds the eval line to the shell rc file once", async () => {
    await using home = await createTempDir();
    const env = { HOME: home.dir };

    const first = await apl(home.dir, ["completion", "zsh", "--install"], { env });
    const second = await apl(home.dir, ["completion", "zsh", "--install"], { env });

    expect(first.exitCode).toBe(0);
    expect(second.stdout).toContain("Completion already installed");
    expect(await Bun.file(join(home.dir, ".zshrc")).text()).toBe('eval "$(apl completion zsh)"\n');
  });

  test("completion --install detects the shell from $SHELL", async () => {
    await using home = await createTempDir();
    await Bun.write(join(home.dir, ".bashrc"), "export EDITOR=vim");

    await apl(home.dir, ["completion", "--install"], {
      env: { HOME: home.dir, SHELL: "/bin/bash" },
    });

    expect(await Bun.file(join(home.dir, ".bashrc")).text()).toBe(
      'export EDITOR=vim\neval "$(apl completion bash)"\n',
    );
  });

  test("completion --install writes the fish config", async () => {
    await using home = await createTempDir();
    await mkdir(join(home.dir, ".config", "fish"), { recursive: true });

    await apl(home.dir, ["completion", "fish", "--install"], { env: { HOME: home.dir } });

    expect(await Bun.file(join(home.dir, ".config", "fish", "config.fish")).text()).toBe(
      "apl completion fish | source\n",
    );
  });

  test("completion --install fails when $SHELL is not a supported shell", async () => {
    await using home = await createTempDir();

    const result = await apl(home.dir, ["completion", "--install"], {
      env: { HOME: home.dir, SHELL: "/bin/tcsh" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Could not detect shell");
  });
});

describe("apl __complete", () => {
  test("files lists plan files, filtered by an optional prefix", async () => {
    await using repo = await createRepoWithTaggedPlans();
    await addPlan(repo, "research/notes.md", "# Notes\n");

    expect(await completeLines(repo.dir, ["files"])).toEqual([
      "alpha.md",
      "beta.md",
      "research/notes.md",
    ]);
    expect(await completeLines(repo.dir, ["files", "res"])).toEqual(["research/notes.md"]);
  });

  test("tags lists every tag used in plan frontmatter", async () => {
    await using repo = await createRepoWithTaggedPlans();

    expect(await completeLines(repo.dir, ["tags"])).toEqual(["backend", "cli", "docs"]);
  });

  test("statuses lists the statuses of every built-in type outside a repo", async () => {
    await using temp = await createTempDir();

    expect(await completeLines(temp.dir, ["statuses"])).toEqual([
      "draft",
      "active",
      "completed",
      "archived",
      "final",
      "open",
      "picked-up",
      "closed",
    ]);
  });

  test("statuses with a type lists only that type's statuses", async () => {
    await using repo = await createRepoWithTaggedPlans();

    expect(await completeLines(repo.dir, ["statuses", "handoff"])).toEqual([
      "open",
      "picked-up",
      "closed",
    ]);
  });

  test("types lists the configured types, read from the branch before the store exists", async () => {
    await using repo = await createRepoWithTaggedPlans();
    await writeStoreConfig(repo, { types: { adr: { statuses: ["proposed", "accepted"] } } });
    await using clone = await cloneWithoutStore(repo);

    expect(await completeLines(clone.dir, ["types"])).toEqual(["adr"]);
    expect(await completeLines(clone.dir, ["statuses", "adr"])).toEqual(["proposed", "accepted"]);
  });

  test("files skips templates and other dot-directories", async () => {
    await using repo = await createRepoWithTaggedPlans();
    await Bun.write(join(repo.storeDir, ".templates", "plan.md"), "# Template\n");

    expect(await completeLines(repo.dir, ["files"])).toEqual(["alpha.md", "beta.md"]);
  });

  test("versions lists short commit hashes, optionally for one file", async () => {
    await using repo = await createRepoWithTaggedPlans();

    const all = await completeLines(repo.dir, ["versions"]);
    const forAlpha = await completeLines(repo.dir, ["versions", "alpha.md"]);

    expect(all).toHaveLength(3);
    expect(forAlpha).toEqual(all.slice(1, 2));
    for (const hash of all) expect(hash).toMatch(/^[0-9a-f]{7,}$/);
  });

  test.each([
    { context: "files" },
    { context: "tags" },
    { context: "versions" },
    { context: "unknown" },
  ])("$context prints nothing and succeeds before init or outside a repo", async ({ context }) => {
    await using repo = await createRepo();
    await using temp = await createTempDir();

    for (const cwd of [repo.dir, temp.dir]) {
      const result = await apl(cwd, ["__complete", context]);
      expect(result).toMatchObject({ exitCode: 0, stdout: "" });
    }
  });
});

/**
 * Sources the bash script in a non-interactive shell, where bash-completion's
 * `_init_completion` is never defined, simulates completing `words` with the
 * cursor on the last word, and returns the candidates.
 */
async function bashCandidates(repo: Repo, words: readonly string[]): Promise<string[]> {
  const script = await completionScript("bash");
  const quoted = words.map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(" ");
  const command = `${script}
COMP_WORDS=(${quoted})
COMP_CWORD=${words.length - 1}
_apl_completions
printf '%s\\n' "\${COMPREPLY[@]}"
`;

  const result = await run(["/bin/bash", "--noprofile", "--norc", "-c", command], repo.dir);
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

describe.skipIf(!HAS_BASH)("bash completion", () => {
  test.each([
    {
      line: ["apl", ""],
      expected: [
        "init",
        "new",
        "add",
        "commit",
        "sync",
        "pull",
        "status",
        "log",
        "show",
        "ls",
        "diff",
        "types",
        "completion",
      ],
    },
    { line: ["apl", "sh"], expected: ["show"] },
    { line: ["apl", "show", ""], expected: ["alpha.md", "beta.md"] },
    { line: ["apl", "show", "--"], expected: ["--at", "--raw", "--json"] },
    { line: ["apl", "ls", "--"], expected: ["--json", "--short", "--type", "--status", "--tag"] },
    {
      line: ["apl", "ls", "--status", ""],
      expected: [
        "draft",
        "active",
        "completed",
        "archived",
        "final",
        "open",
        "picked-up",
        "closed",
      ],
    },
    { line: ["apl", "ls", "--type", ""], expected: ["plan", "research", "handoff"] },
    { line: ["apl", "new", ""], expected: ["plan", "research", "handoff"] },
    { line: ["apl", "ls", "--tag", ""], expected: ["backend", "cli", "docs"] },
  ])("completes $line", async ({ line, expected }) => {
    await using repo = await createRepoWithTaggedPlans();

    expect(await bashCandidates(repo, line)).toEqual([...expected]);
  });
});

/**
 * zsh only runs completion widgets inside its line editor, so this drives an
 * interactive zsh through a pseudo-terminal, types `line`, presses TAB, and
 * returns everything printed until the prompt is redrawn. zsh only prints a
 * listing when there are several candidates, so `line` must have more than one.
 */
async function zshTabListing(repo: Repo, line: string): Promise<string> {
  await using work = await createTempDir();
  const scriptPath = join(work.dir, "apl.zsh");
  await Bun.write(scriptPath, await completionScript("zsh"));
  const driver = `
zmodload zsh/zpty
# Reads until the output matches a pattern or the deadline passes, so a
# completion that never redraws the prompt fails the test instead of hanging.
read_until() {
  local pattern=$1 chunk deadline=$(( SECONDS + 15 ))
  output=""
  while (( SECONDS < deadline )); do
    if zpty -r -t shell chunk 2>/dev/null; then
      output+=$chunk
      [[ $output == $~pattern ]] && return 0
    else
      sleep 0.1
    fi
  done
  return 1
}
zpty shell 'TERM=dumb zsh -f -i'
zpty -w shell 'PS1="APL_PROMPT> "; unset zle_bracketed_paste; autoload -Uz compinit; compinit -u -d ${join(work.dir, "zcompdump")}; source ${scriptPath}; cd ${repo.dir}; echo APL_""READY'
read_until '*APL_READY*APL_PROMPT> *'
zpty -w -n shell $'${line}\\t'
read_until '*APL_PROMPT> *'
zpty -d shell
print -r -- "$output"
`;

  const result = await run(["zsh", "-f", "-c", driver], work.dir);
  return result.stdout.replace(/\r/g, "");
}

describe.skipIf(!HAS_ZSH)("zsh completion", () => {
  test("loads under compinit without errors", async () => {
    await using work = await createTempDir();
    const script = await completionScript("zsh");
    const command = `autoload -Uz compinit && compinit -u -d '${join(work.dir, "zcompdump")}'\n${script}\necho LOADED`;

    const result = await run(["zsh", "-f", "-c", command], work.dir);

    expect(result).toMatchObject({ exitCode: 0, stdout: "LOADED\n", stderr: "" });
  });

  test("lists plan files for 'apl show '", async () => {
    await using repo = await createRepoWithTaggedPlans();

    const listing = await zshTabListing(repo, "apl show ");

    expect(listing).toContain("alpha.md");
    expect(listing).toContain("beta.md");
  }, 30_000);

  test("lists status values for 'apl ls --status '", async () => {
    await using repo = await createRepoWithTaggedPlans();

    const listing = await zshTabListing(repo, "apl ls --status ");

    for (const status of ["draft", "active", "completed", "archived"]) {
      expect(listing).toContain(status);
    }
  }, 30_000);
});

describe.skipIf(!HAS_FISH)("fish completion", () => {
  test("completes subcommands and plan files", async () => {
    await using repo = await createRepoWithTaggedPlans();
    const scriptPath = join(repo.dir, "apl.fish");
    await Bun.write(scriptPath, await completionScript("fish"));
    const complete = (line: string) =>
      run(
        ["fish", "--no-config", "-c", `source '${scriptPath}'; complete --do-complete '${line}'`],
        repo.dir,
      );

    const subcommands = await complete("apl sh");
    const files = await complete("apl show ");

    expect(subcommands.stdout).toContain("show");
    expect(files.stdout).toContain("alpha.md");
  });
});
