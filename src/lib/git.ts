import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  async exec(args: string[]): Promise<string> {
    const { stdout } = await this.run(args);
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

  /** Read a file's content from the plans branch. Throws if the file doesn't exist. */
  async readFile(path: string): Promise<string> {
    const { stdout } = await this.run(["show", `${this.branch}:${path}`]);
    return stdout;
  }

  /** List file paths on the plans branch, optionally scoped to a subdirectory. */
  async listFiles(path?: string): Promise<string[]> {
    const args = ["ls-tree", "-r", "--name-only", this.branch];
    if (path) args.push(path);
    const { stdout } = await this.run(args);
    return stdout.split("\n").filter((line) => line.length > 0);
  }

  /**
   * Write one or more files to the plans branch atomically, without touching the
   * working tree. Uses a temporary index file so nested directories are handled
   * automatically by write-tree.
   */
  async writeFiles(files: { path: string; content: string }[], message: string): Promise<void> {
    const tempIndex = join(tmpdir(), `plan-storage-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: tempIndex };

    try {
      const branchHasCommits = await this.branchExists();
      if (branchHasCommits) {
        await this.run(["read-tree", this.branch], { env });
      }

      for (const file of files) {
        const { stdout: hashOut } = await this.run(["hash-object", "-w", "--stdin"], {
          input: file.content,
        });
        const hash = hashOut.trim();
        await this.run(
          ["update-index", "--add", "--cacheinfo", `100644,${hash},${file.path}`],
          { env },
        );
      }

      const { stdout: treeOut } = await this.run(["write-tree"], { env });
      const tree = treeOut.trim();

      const commitArgs = ["commit-tree", tree];
      if (branchHasCommits) {
        const { stdout: parentOut } = await this.run(["rev-parse", this.branch]);
        commitArgs.push("-p", parentOut.trim());
      }
      commitArgs.push("-m", message);

      const { stdout: commitOut } = await this.run(commitArgs);
      const commit = commitOut.trim();

      await this.run(["update-ref", `refs/heads/${this.branch}`, commit]);
    } finally {
      await rm(tempIndex, { force: true });
    }
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
        const [hash, message, date, author] = record.split(LOG_FIELD_SEP);
        return { hash, message, date, author };
      });
  }

  /** Diff a local file on disk against its counterpart on the plans branch. */
  async diff(planPath: string, localFilePath: string): Promise<string> {
    const branchContent = await this.readFile(planPath);
    const tempFile = join(tmpdir(), `plan-storage-diff-${randomUUID()}`);

    try {
      await Bun.write(tempFile, branchContent);

      const proc = Bun.spawn(["git", "diff", "--no-index", "--", tempFile, localFilePath], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      // git diff --no-index exits 0 (no diff) or 1 (diff found); anything else is a real error.
      if (exitCode > 1) {
        throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
      }

      return stdout;
    } finally {
      await rm(tempFile, { force: true });
    }
  }
}
