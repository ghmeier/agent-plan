export interface PlanConfig {
  branch: string; // git branch name, default "plans"
  remote: string; // git remote name, default "origin"
}

export const DEFAULT_CONFIG: PlanConfig = {
  branch: "plans",
  remote: "origin",
};
