export interface LogEntry {
  hash: string;
  message: string;
  date: string;
  author: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

interface RunOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
}

const LOG_FIELD_SEP = "\x1f";
const LOG_RECORD_SEP = "\x1e";

export class GitPlumbing {
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

  /** Read a file's content from the plans branch at HEAD. Throws if the file doesn't exist. */
  async readFile(planPath: string): Promise<string> {
    const { stdout } = await this.run(["show", `${this.branch}:${planPath}`]);
    return stdout;
  }

  /** List file paths on the plans branch, optionally scoped to a subdirectory. */
  async listFiles(path?: string): Promise<string[]> {
    const args = ["ls-tree", "-r", "--name-only", this.branch];
    if (path) args.push(path);
    const { stdout } = await this.run(args);
    return stdout.split("\n").filter((line) => line.length > 0);
  }

  /** Get commit log for the plans branch, optionally scoped to a path and limited. */
  async getLog(path?: string, limit?: number): Promise<LogEntry[]> {
    const format = `%H${LOG_FIELD_SEP}%s${LOG_FIELD_SEP}%aI${LOG_FIELD_SEP}%an${LOG_RECORD_SEP}`;
    const args = ["log", `--pretty=format:${format}`, this.branch];
    if (limit !== undefined) args.push("-n", String(limit));
    if (path) args.push("--", path);

    const { stdout } = await this.run(args);

    return stdout
      .split(LOG_RECORD_SEP)
      .map((record) => record.trim())
      .filter((record) => record.length > 0)
      .map((record) => {
        const parts = record.split(LOG_FIELD_SEP);
        return {
          hash: parts[0] ?? "",
          message: parts[1] ?? "",
          date: parts[2] ?? "",
          author: parts[3] ?? "",
        };
      });
  }
}
