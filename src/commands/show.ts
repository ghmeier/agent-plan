import type { Command } from "commander";

export function registerShow(program: Command): void {
  program
    .command("show")
    .description("Show the contents of a stored plan")
    .action(() => {
      console.log("not implemented yet");
    });
}
