#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerAdd } from "./commands/add";
import { registerCommit } from "./commands/commit";
import { registerComplete } from "./commands/complete";
import { registerCompletion } from "./commands/completion";
import { registerDiff } from "./commands/diff";
import { registerInit } from "./commands/init";
import { registerLog } from "./commands/log";
import { registerLs } from "./commands/ls";
import { registerShow } from "./commands/show";
import { registerSync } from "./commands/sync";
import { AgentPlanError } from "./lib/errors";
import { error } from "./lib/output";

const program = new Command();

program
  .name("apl")
  .description("Version-controlled storage and syncing for plan files")
  .version(pkg.version)
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
registerCompletion(program);
registerComplete(program);

program.parseAsync().catch((err) => {
  if (err instanceof AgentPlanError) {
    error(err.message);
    process.exit(err.exitCode);
  }
  error(`Unexpected error: ${err.message || err}`);
  process.exit(2);
});
