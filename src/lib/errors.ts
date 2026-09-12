export class PlanStorageError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1,
  ) {
    super(message);
    this.name = "PlanStorageError";
  }
}

export class NotInitializedError extends PlanStorageError {
  constructor() {
    super("Plan storage is not initialized. Run 'plan init' first.");
    this.name = "NotInitializedError";
  }
}

export class NotARepoError extends PlanStorageError {
  constructor() {
    super("Not a git repository. Run this command from within a git repo.");
    this.name = "NotARepoError";
  }
}

export class FileNotFoundError extends PlanStorageError {
  constructor(path: string) {
    super(`File not found: ${path}`);
    this.name = "FileNotFoundError";
  }
}
