import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_CONFIG, type PlanConfig } from "../types";
import { getConfigPath, getGitCommonDir } from "./paths";

export async function readConfig(repoRoot: string): Promise<PlanConfig> {
  const gitCommonDir = await getGitCommonDir(repoRoot);
  const filePath = getConfigPath(gitCommonDir);
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
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
