import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printCompletion } from "../../src/commands/completion";

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
