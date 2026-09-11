import type { Command } from "commander";

export function registerLs(program: Command): void {
  program
    .command("ls")
    .description("List stored plans")
    .action(() => {
      console.log("not implemented yet");
    });
}
