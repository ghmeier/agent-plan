import type { Command } from "commander";

export function registerCommit(program: Command): void {
  program
    .command("commit")
    .description("Commit staged plan changes")
    .action(() => {
      console.log("not implemented yet");
    });
}
