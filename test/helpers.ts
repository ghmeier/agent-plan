import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TestRepo {
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Runs a git command in the given directory and returns its stdout.
 * Throws if the command exits with a non-zero status, including stderr
 * in the error message to make failures easy to diagnose.
 */
export async function gitExec(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Provisions an isolated git repository in a temporary directory, with an
 * initial commit so the repo is non-empty and ready for further commits.
 * Callers must invoke the returned `cleanup` function to remove the
 * temporary directory once the test is done.
 */
export async function createTestRepo(): Promise<TestRepo> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-plan-test-"));

  await gitExec(dir, ["init"]);
  await gitExec(dir, ["config", "user.email", "test@test.com"]);
  await gitExec(dir, ["config", "user.name", "Test"]);

  await Bun.write(path.join(dir, ".gitkeep"), "");
  await gitExec(dir, ["add", ".gitkeep"]);
  await gitExec(dir, ["commit", "-m", "Initial commit"]);

  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
  };

  return { dir, cleanup };
}
