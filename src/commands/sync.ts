import type { Command } from "commander";

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description("Sync plan storage with the remote")
    .action(() => {
      console.log("not implemented yet");
    });
}
