import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitPath, INTERNAL_ENV_VAR } from "./git";

const MARKER = "agent-plan";

const HOOK_SCRIPT = `#!/bin/sh
# agent-plan: auto-commit doc changes
# Installed by 'apl init --auto-commit'. Remove with 'apl init --no-auto-commit'.

# apl's own commits inside .apl/ also run this hook. Skip those so the hook
# doesn't start another apl commit from inside one.
[ -n "$${INTERNAL_ENV_VAR}" ] && exit 0

message="Auto-commit: doc changes after $(git log -1 --format='%h %s')"

# Git runs hooks with variables such as GIT_INDEX_FILE pointing at the code
# checkout. Inherited by the git commands apl runs inside .apl/, they would
# make git use the code checkout's index and the doc commit would fail.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

if command -v apl >/dev/null 2>&1; then
  apl commit -m "$message" >/dev/null || echo "apl: auto-commit of doc changes failed" >&2
fi
`;

/**
 * Asks git where hooks live rather than assuming `<repoRoot>/.git/hooks`: a
 * secondary checkout shares the main checkout's hooks, and `core.hooksPath`
 * (set by tools like husky and lefthook) moves them elsewhere.
 */
async function postCommitHookPath(repoRoot: string): Promise<string> {
  return join(await gitPath(repoRoot, "hooks"), "post-commit");
}

async function readHookIfExists(hookPath: string): Promise<string | undefined> {
  try {
    return await readFile(hookPath, "utf8");
  } catch {
    return undefined;
  }
}

function sectionHeader(marker: string): string {
  return `# ${marker} auto-commit hook\n`;
}

function isEmptyHook(contents: string): boolean {
  const trimmed = contents.trim();
  return trimmed.length === 0 || trimmed === "#!/bin/sh";
}

export async function installAutoCommitHook(repoRoot: string): Promise<void> {
  const hookPath = await postCommitHookPath(repoRoot);
  const existing = await readHookIfExists(hookPath);

  if (existing?.includes(MARKER)) {
    return;
  }

  if (existing === undefined) {
    await mkdir(join(hookPath, ".."), { recursive: true });
    await writeFile(hookPath, HOOK_SCRIPT);
    await chmod(hookPath, 0o755);
    return;
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  const appended = `${existing}${separator}${sectionHeader(MARKER)}${stripShebang(HOOK_SCRIPT)}`;
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

  const withoutSection = removeSection(existing, MARKER);

  if (isEmptyHook(withoutSection)) {
    await rm(hookPath, { force: true });
    return;
  }

  await writeFile(hookPath, withoutSection);
}

function removeSection(contents: string, marker: string): string {
  const headerIndex = contents.indexOf(sectionHeader(marker));

  if (headerIndex === -1) {
    // The whole file is our hook (created fresh, no append header) — signal
    // callers to delete it entirely.
    return "";
  }

  // Trim the blank-line separator that precedes our appended section.
  let start = headerIndex;
  while (start > 0 && contents[start - 1] === "\n") {
    start -= 1;
  }

  return `${contents.slice(0, start)}\n`;
}
