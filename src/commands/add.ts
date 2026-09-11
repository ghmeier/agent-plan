import type { Command } from "commander";

export function registerAdd(program: Command): void {
  program
    .command("add")
    .description("Add a plan file to storage")
    .action(() => {
      console.log("not implemented yet");
    });
}
