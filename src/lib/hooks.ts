import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MARKER = "plan-storage";

const HOOK_SCRIPT = `#!/bin/sh
# plan-storage: auto-commit plan changes
# Installed by 'plan init --auto-commit'. Remove with 'plan init --no-auto-commit'.

if command -v plan >/dev/null 2>&1; then
  plan commit -m "Auto-commit: plan changes after $(git log -1 --format='%h %s')" 2>/dev/null || true
elif command -v bun >/dev/null 2>&1; then
  bun run plan-storage commit -m "Auto-commit: plan changes after $(git log -1 --format='%h %s')" 2>/dev/null || true
fi
`;

const APPEND_SEPARATOR = "\n\n# plan-storage auto-commit hook\n";

/**
 * Resolves the post-commit hook path via `git rev-parse --git-dir` rather
 * than assuming `<repoRoot>/.git`, since .git is a file (not a directory)
 * pointing elsewhere when repoRoot is a worktree.
 */
async function postCommitHookPath(repoRoot: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--git-dir"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`git rev-parse --git-dir failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  const gitDir = stdout.trim();
  const absoluteGitDir = gitDir.startsWith("/") ? gitDir : join(repoRoot, gitDir);

  return join(absoluteGitDir, "hooks", "post-commit");
}

async function readHookIfExists(hookPath: string): Promise<string | undefined> {
  try {
    return await readFile(hookPath, "utf8");
  } catch {
    return undefined;
  }
}

export async function installAutoCommitHook(repoRoot: string): Promise<void> {
  const hookPath = await postCommitHookPath(repoRoot);
  const existing = await readHookIfExists(hookPath);

  if (existing === undefined) {
    await mkdir(join(hookPath, ".."), { recursive: true });
    await writeFile(hookPath, HOOK_SCRIPT);
    await chmod(hookPath, 0o755);
    return;
  }

  if (existing.includes(MARKER)) {
    return;
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  const appended = `${existing}${separator}# plan-storage auto-commit hook\n${stripShebang(HOOK_SCRIPT)}`;
  await writeFile(hookPath, appended);
  await chmod(hookPath, 0o755);
}

function stripShebang(script: string): string {
  return script.startsWith("#!/bin/sh\n") ? script.slice("#!/bin/sh\n".length) : script;
}

export async function removeAutoCommitHook(repoRoot: string): Promise<void> {
  const hookPath = await postCommitHookPath(repoRoot);
  const existing = await readHookIfExists(hookPath);

  if (existing === undefined || !existing.includes(MARKER)) {
    return;
  }

  const withoutSection = removePlanStorageSection(existing);

  if (withoutSection.trim().length === 0 || withoutSection.trim() === "#!/bin/sh") {
    await rm(hookPath, { force: true });
    return;
  }

  await writeFile(hookPath, withoutSection);
}

function removePlanStorageSection(contents: string): string {
  const markerHeader = "# plan-storage auto-commit hook\n";
  const headerIndex = contents.indexOf(markerHeader);

  if (headerIndex === -1) {
    // The whole file is the plan-storage hook (created fresh by us, no
    // append header) — signal callers to delete it entirely.
    return "";
  }

  // Trim the blank-line separator that precedes our appended section.
  let start = headerIndex;
  while (start > 0 && (contents[start - 1] === "\n")) {
    start -= 1;
  }

  return `${contents.slice(0, start)}\n`;
}

export async function hasAutoCommitHook(repoRoot: string): Promise<boolean> {
  const hookPath = await postCommitHookPath(repoRoot);
  const existing = await readHookIfExists(hookPath);
  return existing !== undefined && existing.includes(MARKER);
}

export async function isExecutable(hookPath: string): Promise<boolean> {
  try {
    const info = await stat(hookPath);
    return (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
