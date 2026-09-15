import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, type PlanConfig } from "../types";
import { getConfigPath, getGitCommonDir } from "./paths";

/** Checks for an old plain-directory `.plans/config.json` and, if found,
 * copies branch and remote to the new location before returning them.
 * Returns null when there is nothing to migrate. */
async function migrateOldConfig(
  repoRoot: string,
  newConfigPath: string,
): Promise<PlanConfig | null> {
  const oldConfigPath = join(repoRoot, ".plans", "config.json");
  const oldFile = Bun.file(oldConfigPath);
  if (!(await oldFile.exists())) return null;

  // Skip if .plans/ is already a git worktree — the .git file marks it as one.
  const plansGitFile = Bun.file(join(repoRoot, ".plans", ".git"));
  if (await plansGitFile.exists()) return null;

  let parsed: Partial<{ branch: string; remote: string }>;
  try {
    parsed = JSON.parse(await oldFile.text());
  } catch {
    return null;
  }

  const migrated: PlanConfig = {
    branch: parsed.branch ?? DEFAULT_CONFIG.branch,
    remote: parsed.remote ?? DEFAULT_CONFIG.remote,
  };

  await mkdir(dirname(newConfigPath), { recursive: true });
  await Bun.write(newConfigPath, JSON.stringify(migrated, null, 2));
  return migrated;
}

export async function readConfig(repoRoot: string): Promise<PlanConfig> {
  const gitCommonDir = await getGitCommonDir(repoRoot);
  const filePath = getConfigPath(gitCommonDir);
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    const migrated = await migrateOldConfig(repoRoot, filePath);
    if (migrated) return migrated;
    return DEFAULT_CONFIG;
  }

  const text = await file.text();

  try {
    return JSON.parse(text) as PlanConfig;
  } catch (cause) {
    throw new Error(`Malformed config at ${filePath}: could not parse JSON`, { cause });
  }
}

export async function writeConfig(repoRoot: string, config: PlanConfig): Promise<void> {
  const gitCommonDir = await getGitCommonDir(repoRoot);
  const filePath = getConfigPath(gitCommonDir);
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, JSON.stringify(config, null, 2));
}
