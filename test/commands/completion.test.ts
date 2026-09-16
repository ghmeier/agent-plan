import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printCompletion } from "../../src/commands/completion";
import { createTestRepoWithPlans, writePlanFile } from "../helpers";

// Capture stdout lines emitted by printCompletion.
async function captureScript(shell: "bash" | "zsh" | "fish"): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await printCompletion(shell);
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

describe("completion bash script", () => {
  test("contains all subcommands", async () => {
    const script = await captureScript("bash");

    for (const cmd of [
      "init",
      "add",
      "commit",
      "sync",
      "log",
      "show",
      "ls",
      "diff",
      "completion",
    ]) {
      expect(script).toContain(cmd);
    }
  });

  test("calls apl __complete for dynamic values", async () => {
    const script = await captureScript("bash");

    expect(script).toContain("apl __complete files");
    expect(script).toContain("apl __complete statuses");
    expect(script).toContain("apl __complete tags");
    expect(script).toContain("apl __complete versions");
  });

  test("registers the completion function", async () => {
    const script = await captureScript("bash");

    expect(script).toContain("complete -F _apl_completions apl");
  });
});

describe("completion zsh script", () => {
  test("contains all subcommands", async () => {
    const script = await captureScript("zsh");

    for (const cmd of [
      "init",
      "add",
      "commit",
      "sync",
      "log",
      "show",
      "ls",
      "diff",
      "completion",
    ]) {
      expect(script).toContain(cmd);
    }
  });

  test("calls apl __complete for dynamic values", async () => {
    const script = await captureScript("zsh");

    expect(script).toContain("apl __complete files");
    expect(script).toContain("apl __complete statuses");
    expect(script).toContain("apl __complete tags");
    expect(script).toContain("apl __complete versions");
  });

  test("registers the completion function", async () => {
    const script = await captureScript("zsh");

    expect(script).toContain("compdef _apl apl");
  });
});

describe("completion fish script", () => {
  test("contains all subcommands", async () => {
    const script = await captureScript("fish");

    for (const cmd of [
      "init",
      "add",
      "commit",
      "sync",
      "log",
      "show",
      "ls",
      "diff",
      "completion",
    ]) {
      expect(script).toContain(cmd);
    }
  });

  test("calls apl __complete for dynamic values", async () => {
    const script = await captureScript("fish");

    expect(script).toContain("apl __complete files");
    expect(script).toContain("apl __complete statuses");
    expect(script).toContain("apl __complete tags");
  });
});

describe("completion --install", () => {
  async function makeTempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
    const home = await mkdtemp(join(tmpdir(), "apl-install-test-"));
    return {
      home,
      cleanup: () => rm(home, { recursive: true, force: true }),
    };
  }

  // Run install through the exported internals, controlling HOME via env.
  async function install(
    shell: "bash" | "zsh" | "fish",
    home: string,
  ): Promise<{ output: string }> {
    const output: string[] = [];

    // Patch process.env.HOME for the duration of this call.
    const origHome = process.env.HOME;
    process.env.HOME = home;

    const origLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));

    try {
      // Re-import to pick up patched HOME — but homedir() caches, so we call
      // the install logic directly through the completion module's internals.
      const { installCompletion } = await import("../../src/commands/completion");
      await installCompletion(shell, home);
    } finally {
      process.env.HOME = origHome;
      console.log = origLog;
    }

    return { output: output.join("\n") };
  }

  test("installs bash completion to ~/.bashrc", async () => {
    const { home, cleanup } = await makeTempHome();
    try {
      await install("bash", home);

      const content = await readFile(join(home, ".bashrc"), "utf8");
      expect(content).toContain('eval "$(apl completion bash)"');
    } finally {
      await cleanup();
    }
  });

  test("installs zsh completion to ~/.zshrc", async () => {
    const { home, cleanup } = await makeTempHome();
    try {
      await install("zsh", home);

      const content = await readFile(join(home, ".zshrc"), "utf8");
      expect(content).toContain('eval "$(apl completion zsh)"');
    } finally {
      await cleanup();
    }
  });

  test("installs fish completion to ~/.config/fish/config.fish", async () => {
    const { home, cleanup } = await makeTempHome();
    try {
      await mkdir(join(home, ".config", "fish"), { recursive: true });
      await install("fish", home);

      const content = await readFile(join(home, ".config", "fish", "config.fish"), "utf8");
      expect(content).toContain("apl completion fish | source");
    } finally {
      await cleanup();
    }
  });

  test("is idempotent — does not duplicate the eval line", async () => {
    const { home, cleanup } = await makeTempHome();
    try {
      await install("zsh", home);
      await install("zsh", home);

      const content = await readFile(join(home, ".zshrc"), "utf8");
      const matches = content
        .split("\n")
        .filter((l) => l.trim() === 'eval "$(apl completion zsh)"');
      expect(matches).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

describe("completion syntax check", () => {
  async function shellExists(shell: string): Promise<boolean> {
    const proc = Bun.spawn(["which", shell], { stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    return code === 0;
  }

  async function syntaxCheck(shell: string, script: string): Promise<boolean> {
    const proc = Bun.spawn([shell, "-n", "/dev/stdin"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.stdin?.write(script);
    proc.stdin?.end();
    const code = await proc.exited;
    return code === 0;
  }

  test("bash script has no syntax errors", async () => {
    if (!(await shellExists("bash"))) {
      console.log("bash not installed — skipping syntax check");
      return;
    }
    const script = await captureScript("bash");
    expect(await syntaxCheck("bash", script)).toBe(true);
  });

  test("zsh script has no syntax errors", async () => {
    if (!(await shellExists("zsh"))) {
      console.log("zsh not installed — skipping syntax check");
      return;
    }
    const script = await captureScript("zsh");
    expect(await syntaxCheck("zsh", script)).toBe(true);
  });
});

// Availability is checked once, synchronously, so `test.skipIf` can decide
// at collection time which shells to exercise on this machine.
function hasCommand(cmd: string): boolean {
  try {
    const proc = Bun.spawnSync(["which", cmd], { stdout: "ignore", stderr: "ignore" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

const HAS_BASH = hasCommand("bash");
const HAS_ZSH = hasCommand("zsh");
const HAS_FISH = hasCommand("fish");

const REPO_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");

interface ShellFixture {
  repoDir: string;
  path: string;
  cleanup: () => Promise<void>;
}

// Writes an executable `apl` that runs this repo's CLI through `bun`, so a
// sourced completion script can shell out to `apl __complete` exactly as it
// would against a real install.
async function writeAplShim(dir: string): Promise<void> {
  const shimPath = join(dir, "apl");
  await Bun.write(shimPath, `#!/bin/sh\nexec bun "${REPO_ENTRY}" "$@"\n`);
  await chmod(shimPath, 0o755);
}

// Provisions a repo with plans initialized and a couple of tagged, statused
// plan files, plus a PATH-only directory holding the `apl` shim.
async function createShellFixture(): Promise<ShellFixture> {
  const repo = await createTestRepoWithPlans();
  await writePlanFile(
    repo.dir,
    "alpha.md",
    "---\nstatus: active\ntags: [cli, backend]\n---\n# Alpha",
  );
  await writePlanFile(repo.dir, "beta.md", "---\nstatus: draft\ntags: [docs]\n---\n# Beta");

  const shimDir = await mkdtemp(join(tmpdir(), "apl-shim-"));
  await writeAplShim(shimDir);

  return {
    repoDir: repo.dir,
    path: `${shimDir}:${process.env.PATH ?? ""}`,
    cleanup: async () => {
      await rm(shimDir, { recursive: true, force: true });
      await repo.cleanup();
    },
  };
}

// Sources the generated bash script in a non-interactive `/bin/bash` (which
// never defines `_init_completion`, so this always exercises the fallback
// branch fixed for Task 1), simulates the given command line, and returns
// the resulting COMPREPLY candidates.
async function bashCandidates(
  fixture: ShellFixture,
  words: string[],
  cword: number,
): Promise<string[]> {
  const script = await captureScript("bash");
  const quoted = words.map((w) => `'${w.replace(/'/g, "'\\''")}'`).join(" ");
  const cmd = `${script}\nCOMP_WORDS=(${quoted})\nCOMP_CWORD=${cword}\n_apl_completions\nprintf '%s\\n' "\${COMPREPLY[@]}"\n`;

  const proc = Bun.spawn(["/bin/bash", "--noprofile", "--norc", "-c", cmd], {
    cwd: fixture.repoDir,
    env: { ...process.env, PATH: fixture.path },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter((line) => line.length > 0);
}

describe("bash completion executed in a real shell", () => {
  test.skipIf(!HAS_BASH)("completes subcommand names for 'apl sh'", async () => {
    const fixture = await createShellFixture();
    try {
      const candidates = await bashCandidates(fixture, ["apl", "sh"], 1);

      expect(candidates).toEqual(["show"]);
    } finally {
      await fixture.cleanup();
    }
  });

  test.skipIf(!HAS_BASH)("completes plan file names for 'apl show '", async () => {
    const fixture = await createShellFixture();
    try {
      const candidates = await bashCandidates(fixture, ["apl", "show", ""], 2);

      expect(candidates).toContain("alpha.md");
      expect(candidates).toContain("beta.md");
    } finally {
      await fixture.cleanup();
    }
  });

  test.skipIf(!HAS_BASH)("completes status values for 'apl ls --status '", async () => {
    const fixture = await createShellFixture();
    try {
      const candidates = await bashCandidates(fixture, ["apl", "ls", "--status", ""], 3);

      expect(candidates).toEqual(["draft", "active", "completed", "archived"]);
    } finally {
      await fixture.cleanup();
    }
  });

  test.skipIf(!HAS_BASH)("completes tag values for 'apl ls --tag '", async () => {
    const fixture = await createShellFixture();
    try {
      const candidates = await bashCandidates(fixture, ["apl", "ls", "--tag", ""], 3);

      expect(candidates).toContain("cli");
      expect(candidates).toContain("backend");
      expect(candidates).toContain("docs");
    } finally {
      await fixture.cleanup();
    }
  });

  test.skipIf(!HAS_BASH)("completes flag names for 'apl ls --'", async () => {
    const fixture = await createShellFixture();
    try {
      const candidates = await bashCandidates(fixture, ["apl", "ls", "--"], 2);

      expect(candidates).toEqual(["--json", "--short", "--status", "--tag"]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("zsh completion executed in a real shell", () => {
  test.skipIf(!HAS_ZSH)("loads the script under compinit without error", async () => {
    const fixture = await createShellFixture();
    const compdumpDir = await mkdtemp(join(tmpdir(), "apl-zcompdump-"));
    try {
      const script = await captureScript("zsh");
      const cmd = `autoload -Uz compinit && compinit -u -d '${join(compdumpDir, "zcompdump")}'\n${script}\necho APL_ZSH_LOAD_OK`;

      const proc = Bun.spawn(["zsh", "-f", "-c", cmd], {
        cwd: fixture.repoDir,
        env: { ...process.env, PATH: fixture.path },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;

      expect(code).toBe(0);
      expect(out).toContain("APL_ZSH_LOAD_OK");
    } finally {
      await rm(compdumpDir, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });
});

describe("fish completion executed in a real shell", () => {
  test.skipIf(!HAS_FISH)("passes fish --no-execute syntax check", async () => {
    const script = await captureScript("fish");
    const scriptDir = await mkdtemp(join(tmpdir(), "apl-fish-"));
    const scriptPath = join(scriptDir, "completion.fish");
    try {
      await Bun.write(scriptPath, script);

      const proc = Bun.spawn(["fish", "--no-execute", scriptPath], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const code = await proc.exited;

      expect(code).toBe(0);
    } finally {
      await rm(scriptDir, { recursive: true, force: true });
    }
  });

  test.skipIf(!HAS_FISH)("completes subcommand names for 'apl sh'", async () => {
    const fixture = await createShellFixture();
    try {
      const script = await captureScript("fish");
      const cmd = `source '${join(fixture.repoDir, "completion.fish")}' 2>/dev/null; complete --do-complete 'apl sh'`;
      await Bun.write(join(fixture.repoDir, "completion.fish"), script);

      const proc = Bun.spawn(["fish", "--no-config", "-c", cmd], {
        cwd: fixture.repoDir,
        env: { ...process.env, PATH: fixture.path },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;

      expect(out).toContain("show");
    } finally {
      await fixture.cleanup();
    }
  });
});
