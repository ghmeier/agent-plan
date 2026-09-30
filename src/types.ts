export interface PlanConfig {
  branch: string; // git branch name, default "apl"
  remote: string; // git remote name, default "origin"
}

export const DEFAULT_CONFIG: PlanConfig = {
  branch: "apl",
  remote: "origin",
};
