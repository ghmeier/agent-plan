import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, type PlanConfig } from "../types";
import { getPlansDir } from "./paths";

function configPath(repoRoot: string): string {
  return join(getPlansDir(repoRoot), "config.json");
}

export async function readConfig(repoRoot: string): Promise<PlanConfig> {
  const file = Bun.file(configPath(repoRoot));

  if (!(await file.exists())) {
    return DEFAULT_CONFIG;
  }

  const text = await file.text();

  try {
    return JSON.parse(text) as PlanConfig;
  } catch (cause) {
    throw new Error(`Malformed config at ${configPath(repoRoot)}: could not parse JSON`, { cause });
  }
}

export async function writeConfig(repoRoot: string, config: PlanConfig): Promise<void> {
  await mkdir(getPlansDir(repoRoot), { recursive: true });
  await Bun.write(configPath(repoRoot), JSON.stringify(config, null, 2));
}
