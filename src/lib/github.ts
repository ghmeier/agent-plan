export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the GitHub CLI in `cwd` and returns its output without throwing. A
 * missing `gh` is an ordinary failure here (exit code 127), because most
 * machines that run apl are not signed in to GitHub, and callers skip quietly.
 */
export async function runGh(args: string[], cwd: string): Promise<GhResult> {
  try {
    const proc = Bun.spawn(["gh", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Keeps gh from waiting on a prompt that no one can answer.
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    return { exitCode: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}
