interface RunResult {
  stdout: string;
  stderr: string;
}

interface RunOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
}

/** Thin wrapper around the git CLI for managing the plans branch and its worktree. */
export class Git {
  constructor(
    private repoDir: string,
    private branch: string = "plans",
  ) {}

  /** Run a git command in repoDir and return trimmed stdout. Throws on non-zero exit. */
  async exec(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await this.run(args, { cwd });
    return stdout.trim();
  }

  private async run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: opts.cwd ?? this.repoDir,
      stdin: opts.input !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });

    if (opts.input !== undefined) {
      // stdin is a pipe because we set `stdin: "pipe"` above when input is defined.
      if (!proc.stdin) throw new Error("Expected stdin pipe");
      proc.stdin.write(opts.input);
      proc.stdin.end();
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
    }

    return { stdout, stderr };
  }

  /** Check if the plans branch exists. */
  async branchExists(): Promise<boolean> {
    try {
      await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${this.branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Create an empty orphan branch using plumbing commands, without touching the working tree. */
  async createOrphanBranch(): Promise<void> {
    const { stdout: treeOut } = await this.run(["hash-object", "-t", "tree", "/dev/null"]);
    const tree = treeOut.trim();

    const { stdout: commitOut } = await this.run(["commit-tree", tree, "-m", "Initialize plans"]);
    const commit = commitOut.trim();

    await this.run(["update-ref", `refs/heads/${this.branch}`, commit]);
  }
}
