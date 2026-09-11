export interface PlanConfig {
  branch: string; // git branch name, default "plans"
  remote: string; // git remote name, default "origin"
  worktree: boolean; // whether worktree mode is active, default false
}

export const DEFAULT_CONFIG: PlanConfig = {
  branch: "plans",
  remote: "origin",
  worktree: false,
};
