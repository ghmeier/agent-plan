import type { Command } from "commander";

export function registerDiff(program: Command): void {
  program
    .command("diff")
    .description("Show differences between stored plan versions")
    .action(() => {
      console.log("not implemented yet");
    });
}
