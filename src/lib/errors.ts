export class AgentPlanError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1,
  ) {
    super(message);
    this.name = "AgentPlanError";
  }
}

export class NotInitializedError extends AgentPlanError {
  constructor() {
    super("Doc storage is not initialized. Run 'apl init' first.");
    this.name = "NotInitializedError";
  }
}

export class NotARepoError extends AgentPlanError {
  constructor() {
    super("Not a git repository. Run this command from within a git repo.");
    this.name = "NotARepoError";
  }
}

export class FileNotFoundError extends AgentPlanError {
  constructor(path: string) {
    super(`File not found: ${path}`);
    this.name = "FileNotFoundError";
  }
}

export class StorePathOccupiedError extends AgentPlanError {
  constructor(path: string) {
    super(
      `${path} already exists and is not managed by apl. Move or remove it, then run the command again.`,
    );
    this.name = "StorePathOccupiedError";
  }
}

export class FileExistsError extends AgentPlanError {
  constructor(path: string) {
    super(`${path} already exists. Edit it directly, or choose another name.`);
    this.name = "FileExistsError";
  }
}
