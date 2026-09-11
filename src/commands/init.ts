import type { Command } from "commander";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize plan storage in the current directory")
    .action(() => {
      console.log("not implemented yet");
    });
}
