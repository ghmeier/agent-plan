import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { AgentPlanError } from "../lib/errors";
import { success } from "../lib/output";

type SupportedShell = "bash" | "zsh" | "fish";
const SUPPORTED_SHELLS: SupportedShell[] = ["bash", "zsh", "fish"];

function bashScript(): string {
  return `
# apl shell completion for bash
_apl_completions() {
  local cur prev words cword
  if type _init_completion &>/dev/null; then
    _init_completion 2>/dev/null
  else
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
  fi

  local subcommands="init new add commit sync log show ls diff types completion"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$subcommands" -- "$cur"))
    return
  fi

  local subcmd="\${COMP_WORDS[1]}"
  case "$subcmd" in
    show)
      case "$prev" in
        --at) COMPREPLY=($(compgen -W "$(apl __complete versions 2>/dev/null)" -- "$cur")) ;;
        *)
          if [[ "$cur" == -* ]]; then
            COMPREPLY=($(compgen -W "--at --raw --json" -- "$cur"))
          else
            COMPREPLY=($(compgen -W "$(apl __complete files "$cur" 2>/dev/null)" -- "$cur"))
          fi
          ;;
      esac
      ;;
    log)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "-n --json" -- "$cur"))
      else
        COMPREPLY=($(compgen -W "$(apl __complete files "$cur" 2>/dev/null)" -- "$cur"))
      fi
      ;;
    diff)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "--json" -- "$cur"))
      else
        COMPREPLY=($(compgen -W "$(apl __complete files "$cur" 2>/dev/null)" -- "$cur"))
      fi
      ;;
    ls)
      case "$prev" in
        --status) COMPREPLY=($(compgen -W "$(apl __complete statuses 2>/dev/null)" -- "$cur")) ;;
        --tag)    COMPREPLY=($(compgen -W "$(apl __complete tags 2>/dev/null)" -- "$cur")) ;;
        --type)   COMPREPLY=($(compgen -W "$(apl __complete types 2>/dev/null)" -- "$cur")) ;;
        *)        COMPREPLY=($(compgen -W "--json --short --type --status --tag" -- "$cur")) ;;
      esac
      ;;
    new)
      case "$prev" in
        --tag) COMPREPLY=($(compgen -W "$(apl __complete tags 2>/dev/null)" -- "$cur")) ;;
        --title) ;;
        *)
          if [[ "$cur" == -* ]]; then
            COMPREPLY=($(compgen -W "--title --tag --json" -- "$cur"))
          elif [[ $COMP_CWORD -eq 2 ]]; then
            COMPREPLY=($(compgen -W "$(apl __complete types 2>/dev/null)" -- "$cur"))
          fi
          ;;
      esac
      ;;
    types)
      COMPREPLY=($(compgen -W "--json" -- "$cur"))
      ;;
    init)
      COMPREPLY=($(compgen -W "--branch --auto-commit --no-auto-commit" -- "$cur"))
      ;;
    completion)
      if [[ $COMP_CWORD -eq 2 ]]; then
        COMPREPLY=($(compgen -W "bash zsh fish --install" -- "$cur"))
      fi
      ;;
    add)
      case "$prev" in
        --type) COMPREPLY=($(compgen -W "$(apl __complete types 2>/dev/null)" -- "$cur")) ;;
        *)
          if [[ "$cur" == -* ]]; then
            COMPREPLY=($(compgen -W "-m --type" -- "$cur"))
          else
            COMPREPLY=($(compgen -f -- "$cur"))
          fi
          ;;
      esac
      ;;
    commit)
      COMPREPLY=($(compgen -W "-m" -- "$cur"))
      ;;
  esac
}
complete -F _apl_completions apl
`.trim();
}

function zshScript(): string {
  return `
# apl shell completion for zsh
_apl() {
  local state line
  typeset -A opt_args

  _arguments -C \\
    '1: :->subcmd' \\
    '*:: :->args'

  case $state in
    subcmd)
      local -a subcommands
      subcommands=(
        'init:Initialize doc storage'
        'new:Create a doc from a template'
        'add:Add files to doc storage'
        'commit:Commit pending changes'
        'sync:Sync with remote'
        'log:Show commit history'
        'show:Show a doc'
        'ls:List docs'
        'diff:Show uncommitted changes'
        'types:List doc types'
        'completion:Print shell completion script'
      )
      _describe 'subcommand' subcommands
      ;;
    args)
      case $words[1] in
        show)
          _arguments \\
            '--at[Show the file as of a commit ref]:ref:($(apl __complete versions 2>/dev/null))' \\
            '--raw[Print file as-is without metadata header]' \\
            '--json[Output in JSON format]' \\
            ':doc:($(apl __complete files 2>/dev/null))'
          ;;
        log)
          _arguments \\
            '-n[Limit number of commits]:number:()' \\
            '--json[Output in JSON format]' \\
            '::doc:($(apl __complete files 2>/dev/null))'
          ;;
        diff)
          _arguments \\
            '--json[Output in JSON format]' \\
            '::doc:($(apl __complete files 2>/dev/null))'
          ;;
        ls)
          _arguments \\
            '--json[Output in JSON format]' \\
            '--short[Filename-only output]' \\
            '--type[Filter by doc type]:type:($(apl __complete types 2>/dev/null))' \\
            '--status[Filter by status]:status:($(apl __complete statuses 2>/dev/null))' \\
            '--tag[Filter by tag]:tag:($(apl __complete tags 2>/dev/null))'
          ;;
        new)
          _arguments \\
            '--title[Title for the doc]:title:()' \\
            '*--tag[Tag to add]:tag:($(apl __complete tags 2>/dev/null))' \\
            '--json[Output in JSON format]' \\
            ':type:($(apl __complete types 2>/dev/null))' \\
            ':name:()'
          ;;
        types)
          _arguments '--json[Output in JSON format]'
          ;;
        init)
          _arguments \\
            '--branch[Branch name for doc storage]:branch:()' \\
            '--auto-commit[Install auto-commit hook]' \\
            '--no-auto-commit[Remove auto-commit hook]'
          ;;
        completion)
          _arguments \\
            '--install[Install completion to shell rc file]' \\
            ':shell:(bash zsh fish)'
          ;;
        add)
          _arguments \\
            '-m[Commit message]:message:()' \\
            '--type[Store under this doc type]:type:($(apl __complete types 2>/dev/null))' \\
            '*:file:_files'
          ;;
        commit)
          _arguments '-m[Commit message]:message:()'
          ;;
      esac
      ;;
  esac
}
compdef _apl apl
`.trim();
}

function fishScript(): string {
  return `
# apl shell completion for fish

# Disable default file completion
complete -c apl -f

# Subcommands
complete -c apl -n '__fish_use_subcommand' -a init       -d 'Initialize doc storage'
complete -c apl -n '__fish_use_subcommand' -a new        -d 'Create a doc from a template'
complete -c apl -n '__fish_use_subcommand' -a add        -d 'Add files to doc storage'
complete -c apl -n '__fish_use_subcommand' -a commit     -d 'Commit pending changes'
complete -c apl -n '__fish_use_subcommand' -a sync       -d 'Sync with remote'
complete -c apl -n '__fish_use_subcommand' -a log        -d 'Show commit history'
complete -c apl -n '__fish_use_subcommand' -a show       -d 'Show a doc'
complete -c apl -n '__fish_use_subcommand' -a ls         -d 'List docs'
complete -c apl -n '__fish_use_subcommand' -a diff       -d 'Show uncommitted changes'
complete -c apl -n '__fish_use_subcommand' -a types      -d 'List doc types'
complete -c apl -n '__fish_use_subcommand' -a completion -d 'Print shell completion script'

# show
complete -c apl -n '__fish_seen_subcommand_from show' -l at -r -d 'Show the file as of a commit ref'
complete -c apl -n '__fish_seen_subcommand_from show' -l raw     -d 'Print as-is without metadata header'
complete -c apl -n '__fish_seen_subcommand_from show' -l json    -d 'Output in JSON format'
complete -c apl -n '__fish_seen_subcommand_from show' -a '(apl __complete files 2>/dev/null)'

# log
complete -c apl -n '__fish_seen_subcommand_from log' -s n    -d 'Limit number of commits'
complete -c apl -n '__fish_seen_subcommand_from log' -l json -d 'Output in JSON format'
complete -c apl -n '__fish_seen_subcommand_from log' -a '(apl __complete files 2>/dev/null)'

# diff
complete -c apl -n '__fish_seen_subcommand_from diff' -l json -d 'Output in JSON format'
complete -c apl -n '__fish_seen_subcommand_from diff' -a '(apl __complete files 2>/dev/null)'

# ls
complete -c apl -n '__fish_seen_subcommand_from ls' -l json   -d 'Output in JSON format'
complete -c apl -n '__fish_seen_subcommand_from ls' -l short  -d 'Filename-only output'
complete -c apl -n '__fish_seen_subcommand_from ls' -l status -d 'Filter by status'
complete -c apl -n '__fish_seen_subcommand_from ls' -l tag    -d 'Filter by tag'
complete -c apl -n '__fish_seen_subcommand_from ls' -l type   -d 'Filter by doc type'
complete -c apl -n '__fish_seen_subcommand_from ls' -n '__fish_prev_arg_in --type' \\
  -a '(apl __complete types 2>/dev/null)'
complete -c apl -n '__fish_seen_subcommand_from ls' -n '__fish_prev_arg_in --status' \\
  -a '(apl __complete statuses 2>/dev/null)'
complete -c apl -n '__fish_seen_subcommand_from ls' -n '__fish_prev_arg_in --tag' \\
  -a '(apl __complete tags 2>/dev/null)'

# new
complete -c apl -n '__fish_seen_subcommand_from new' -l title -r -d 'Title for the doc'
complete -c apl -n '__fish_seen_subcommand_from new' -l tag   -r -d 'Tag to add'
complete -c apl -n '__fish_seen_subcommand_from new' -l json     -d 'Output in JSON format'
complete -c apl -n '__fish_seen_subcommand_from new; and test (count (commandline -opc)) -eq 2' \\
  -a '(apl __complete types 2>/dev/null)'

# types
complete -c apl -n '__fish_seen_subcommand_from types' -l json -d 'Output in JSON format'

# init
complete -c apl -n '__fish_seen_subcommand_from init' -l branch        -d 'Branch name'
complete -c apl -n '__fish_seen_subcommand_from init' -l auto-commit    -d 'Install auto-commit hook'
complete -c apl -n '__fish_seen_subcommand_from init' -l no-auto-commit -d 'Remove auto-commit hook'

# add / commit
complete -c apl -n '__fish_seen_subcommand_from add commit' -s m -r -d 'Commit message'
complete -c apl -n '__fish_seen_subcommand_from add' -l type -r -d 'Store under this doc type' \\
  -a '(apl __complete types 2>/dev/null)'

# completion
complete -c apl -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish' -d 'Shell'
complete -c apl -n '__fish_seen_subcommand_from completion' -l install          -d 'Install to rc file'
`.trim();
}

function getScript(shell: SupportedShell): string {
  switch (shell) {
    case "bash":
      return bashScript();
    case "zsh":
      return zshScript();
    case "fish":
      return fishScript();
  }
}

function detectShell(): SupportedShell | null {
  const shellPath = process.env.SHELL ?? "";
  const name = shellPath.split("/").pop() ?? "";
  if (name === "bash") return "bash";
  if (name === "zsh") return "zsh";
  if (name === "fish") return "fish";
  return null;
}

function rcFilePath(shell: SupportedShell, home: string): string {
  switch (shell) {
    case "bash":
      return join(home, ".bashrc");
    case "zsh":
      return join(home, ".zshrc");
    case "fish":
      return join(home, ".config", "fish", "config.fish");
  }
}

function evalLine(shell: SupportedShell): string {
  switch (shell) {
    case "bash":
      return 'eval "$(apl completion bash)"';
    case "zsh":
      return 'eval "$(apl completion zsh)"';
    case "fish":
      return "apl completion fish | source";
  }
}

export async function installCompletion(shell: SupportedShell, home = homedir()): Promise<void> {
  const rcFile = rcFilePath(shell, home);
  const line = evalLine(shell);

  let existing = "";
  try {
    existing = await readFile(rcFile, "utf8");
  } catch {
    // rc file doesn't exist yet — we'll create it
  }

  if (existing.split("\n").some((l) => l.trim() === line)) {
    success(`Completion already installed in ${rcFile}`);
    return;
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(rcFile, `${prefix}${line}\n`);
  success(`Added to ${rcFile}:\n  ${line}`);
}

export async function printCompletion(shell: SupportedShell): Promise<void> {
  console.log(getScript(shell));
}

export function registerCompletion(program: Command): void {
  program
    .command("completion [shell]")
    .description("Print shell completion script (bash, zsh, or fish)")
    .option("--install", "Install completion into the shell rc file")
    .action(async (shellArg: string | undefined, opts: { install?: boolean }) => {
      if (opts.install) {
        const shell = (shellArg as SupportedShell | undefined) ?? detectShell();
        if (!shell) {
          throw new AgentPlanError(
            `Could not detect shell from $SHELL. Specify one explicitly: ${SUPPORTED_SHELLS.join(", ")}`,
          );
        }
        if (!SUPPORTED_SHELLS.includes(shell)) {
          throw new AgentPlanError(
            `Unsupported shell "${shell}". Supported shells: ${SUPPORTED_SHELLS.join(", ")}`,
          );
        }
        await installCompletion(shell, homedir());
        return;
      }

      const shell = shellArg as SupportedShell | undefined;
      if (!shell) {
        throw new AgentPlanError(
          `Specify a shell: ${SUPPORTED_SHELLS.join(", ")}\nOr use --install to auto-detect and install.`,
        );
      }
      if (!SUPPORTED_SHELLS.includes(shell)) {
        throw new AgentPlanError(
          `Unsupported shell "${shell}". Supported shells: ${SUPPORTED_SHELLS.join(", ")}`,
        );
      }

      await printCompletion(shell);
    });
}
