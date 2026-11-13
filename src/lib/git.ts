import { spawn } from "node:child_process";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Set on every git process apl spawns. Commits apl makes inside the store
 * run the repo's shared post-commit hook, and the auto-commit hook
 * checks this variable so it doesn't start another `apl commit` from inside one.
 */
export const INTERNAL_ENV_VAR = "APL_INTERNAL";

/**
 * Passed to every commit and push apl makes. The store shares the code
 * repo's hooks, and hooks written for code, such as the pre-commit
 * framework's, fail or do pointless work on the docs branch.
 */
export const SKIP_CODE_HOOKS = "--no-verify";

/** Runs git in `cwd` and returns its output without throwing on a non-zero exit. */
export async function runGit(args: string[], cwd: string): Promise<GitResult> {
  const proc = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, [INTERNAL_ENV_VAR]: "1" },
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  proc.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });

  return { exitCode, stdout, stderr };
}

/** Runs git in `cwd` and returns trimmed stdout. Throws on a non-zero exit. */
export async function execGit(args: string[], cwd: string): Promise<string> {
  const { exitCode, stdout, stderr } = await runGit(args, cwd);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout.trim();
}

export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const { exitCode } = await runGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    repoRoot,
  );
  return exitCode === 0;
}

/** Creates an empty orphan branch using plumbing commands, without touching the working tree. */
export async function createOrphanBranch(repoRoot: string, branch: string): Promise<void> {
  const tree = await execGit(["hash-object", "-t", "tree", "/dev/null"], repoRoot);
  const commit = await execGit(["commit-tree", tree, "-m", "Initialize docs"], repoRoot);
  await execGit(["update-ref", `refs/heads/${branch}`, commit], repoRoot);
}

/** Absolute path of a file inside the git directory, as resolved by `git rev-parse --git-path`. */
export async function gitPath(repoRoot: string, name: string): Promise<string> {
  return execGit(["rev-parse", "--path-format=absolute", "--git-path", name], repoRoot);
}
