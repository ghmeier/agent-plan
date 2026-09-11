import type { Command } from "commander";

export function registerCommit(program: Command): void {
  program
    .command("commit")
    .description("Commit staged plan changes")
    .action(() => {
      console.log(
        "Nothing to commit. Use 'plan add <file>' to add files to plans.\n" +
          "In worktree mode, 'plan commit' commits all changes in .plans/",
      );
    });
}
