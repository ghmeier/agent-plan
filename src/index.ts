#!/usr/bin/env bun
import { Command } from "commander";
import { registerInit } from "./commands/init";
import { registerAdd } from "./commands/add";
import { registerCommit } from "./commands/commit";
import { registerSync } from "./commands/sync";
import { registerLog } from "./commands/log";
import { registerShow } from "./commands/show";
import { registerLs } from "./commands/ls";
import { registerDiff } from "./commands/diff";
import { PlanStorageError } from "./lib/errors";
import { error } from "./lib/output";

const program = new Command();

program
  .name("plan")
  .description("Version-controlled storage and syncing for plan files")
  .version("0.1.0")
  .option("--no-color", "Disable colored output");

program.hook("preAction", (thisCommand) => {
  if (thisCommand.opts().color === false) {
    process.env.NO_COLOR = "1";
  }
});

registerInit(program);
registerAdd(program);
registerCommit(program);
registerSync(program);
registerLog(program);
registerShow(program);
registerLs(program);
registerDiff(program);

program.parseAsync().catch((err) => {
  if (err instanceof PlanStorageError) {
    error(err.message);
    process.exit(err.exitCode);
  }
  error(`Unexpected error: ${err.message || err}`);
  process.exit(2);
});
