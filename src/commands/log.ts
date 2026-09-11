import type { Command } from "commander";

export function registerLog(program: Command): void {
  program
    .command("log")
    .description("Show the history of plan changes")
    .action(() => {
      console.log("not implemented yet");
    });
}
