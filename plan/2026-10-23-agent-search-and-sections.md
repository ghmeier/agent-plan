---
title: "Agent ergonomics: search, compact ls, show sections"
status: active
tags: [cli, ux]
created: 2026-10-23
updated: 2026-10-23
---
# Agent ergonomics: search, compact ls, show sections

## Goal

Make finding and reading docs cheap for agents, so they look up earlier work more often and spend fewer tokens doing it.

## Evidence

From a review of Claude Code transcripts in the gazebo repo, Oct 15–23 2026. Gazebo has 238 docs, about 2MB in total, and its largest plan is 94KB.

- Agents ran `apl` 94 times across 45 sessions. 38 calls were `ls`, 26 `show`, and 37 `new`. Only 4 failed.
- **There is no search, so agents grep.** About 30 of the 38 `ls` calls were `apl ls [--json] | grep -iE "kw1|kw2|kw3"`, sometimes with `-B2 -A8` to recover the surrounding JSON. Several piped `--json` into `python3 -c` to reformat it.
- **`ls` output is large.** In gazebo, plain `apl ls` printed 70KB (about 18,000 tokens) and `--json` printed 56KB. Most of the table is padding: columns are padded to the longest title (about 100 characters) and the longest path (about 77). Agents used `| head -60` to cut it down.
- **Agents read large docs in slices.** About 10 calls were `apl show <plan> | sed -n '254,300p'`, `| grep -n -i "status:|PR 2"`, or `| head -80`. Each one is a guess at where a section starts, and agents often needed a second call.
- **`2>/dev/null` is a reflex.** Nearly every agent call appends it, because one doc whose status the type doesn't allow prints a warning on every `ls`. That doc's status came from the skill: `SKILL.md` gives "`draft`, then `active`, then `completed` for a plan", but the built-in plan statuses are `active, merged, done, abandoned`. That example matches this repo's custom types (`draft, active, completed, archived`), not the built-ins most repos use. The redirect also hides real errors.
- **Lookup depends on agents loading the skill.** The "Find earlier work first" guidance is only in the skill, and agents mostly load the skill when they're about to write a doc.

## Approach

Four changes, each small enough to be its own PR, in this order. The `--json` output of existing commands stays the same, because agents parse it. New fields can be added.

### 1. Fix the skill's status example

In `plugins/agent-plan/skills/apl/SKILL.md`, replace the `draft` → `active` → `completed` example. Statuses differ by repo, so tell agents to pick one from `apl types`, and give the built-in plan flow as the example: `active`, then `merged` or `done`, or `abandoned`. Also say that a handoff written as a final summary, with nothing left to pick up, should be set to `closed`. Otherwise it stays `open` and the session-start hook lists it in every session. In gazebo, 15 of the 16 open handoffs are completion summaries like that.

No CLI change. Check the plugin with `claude plugin validate .`.

### 2. `apl search <terms...>`

Add a new command rather than a flag on `ls`, because `ls [path]` already uses its positional argument for a path.

- Every term must match, case-insensitively, somewhere in the doc's path, title, tags, or body.
- Rank docs that match every term in path, title, or tags above docs that match only in the body. Within a rank, sort by most recently updated, the same as `ls`.
- Reuse `findDocs` (`src/commands/ls.ts`) for the `--type`, `--status`, and `--tag` filters, and accept a `[path]` scope with `--path <dir>`. `findDocs` already reads every file, so scanning bodies costs no extra I/O. At 2MB it doesn't need an index.
- Output uses the same rows as `ls`, plus up to 2 matching body lines per doc, each prefixed with its line number (`  L254: ...`) and cut to about 160 characters. Those line numbers let an agent go straight to the section, or pass the heading to `show --section`.
- Add `--limit <n>`, default 20. When results are cut off, print to stderr how many matched in total and how to see the rest.
- `--json` returns `{ files: [{ file, type, meta, matches: [{ line, text }] }], total }`.
- Show "No docs match" through `info` when nothing matches, and exit 0.

Update `SKILL.md`'s "Find earlier work first" section to lead with `apl search <keywords>`, replacing the `apl ls --json` + Grep advice. Update the README and shell completion (`src/commands/complete.ts`, `completion.ts`).

### 3. Compact `ls` output when stdout isn't a terminal

When `process.stdout.isTTY` isn't true, print the table as tab-separated rows with no padding, keeping the header row. Terminal output keeps today's aligned table. The default `apl ls` output has no stability promise, so this isn't breaking; only `--json` does. Use the same layout for `search` rows.

Also add `--limit <n>` to `ls`, with no default, so `ls` keeps listing every doc. Before writing the code, measure the size of gazebo's `apl ls` output with and without padding (run from source in `~/git/gazebo`) and record the numbers in this plan.

### 4. `apl show --outline` and `--section <heading>`

- `--outline` prints each markdown heading with its line number in the file and its level, indented. With `--json` it returns `{ path, headings: [{ line, level, text }] }`.
- `--section <text>` prints every section whose heading contains `<text>` (case-insensitive). A section runs from its heading to the next heading at the same or a higher level. When several sections match, print them all, each starting with its heading line. Throw an `AgentPlanError` when nothing matches, and list the doc's headings in the message so the agent can retry without another call.
- Keep the metadata header that plain `show` prints. `--raw` with `--section` prints the section text alone.
- Ignore `#` lines inside fenced code blocks when finding headings. Plans often contain shell snippets with `# comments`.
- `--at` works with both flags.

Update the skill: for a long doc, run `apl show --outline` first, then `--section`.

## Steps

- [x] PR 1: skill status example and handoff `closed` guidance
- [x] PR 2: `apl search`, with tests in `test/reading.test.ts` and README, completion, and skill updates
- [x] PR 3: compact `ls` output when stdout isn't a terminal, plus `ls --limit`. Record the before and after sizes.
- [x] PR 4: `show --outline` and `--section`, with tests and README and skill updates

All four are implemented in one uncommitted working tree on `main`, not yet split into PRs.

### Implementation notes

- **Status example.** The evidence above has the built-ins backwards. apl's built-in plan statuses are `draft, active, completed, archived` (`DEFAULT_STATUSES` in `src/lib/doc-types.ts`); `active, merged, done, abandoned` is gazebo's custom plan type. The skill's example was right for the built-ins and wrong for gazebo. The skill now tells agents to pick a status from `apl types`, and gives the built-in flow only as an example.
- **`ls` size in gazebo** (277 docs, measured from source): 70,626 bytes padded, 33,065 bytes tab-separated. `--json` is 55,734 bytes and unchanged.
- **Search scope.** `search <terms...>` is variadic, so it takes no positional path; `--path <dir>` is the only scope option. Frontmatter keys other than `title` and `tags` are not searched, so `search active` doesn't match every doc whose status is `active`. Among a doc's matching lines, the two with the most distinct terms are shown, in file order. A long line is cut to 160 characters around its first match, since plans are often one paragraph per line.
- **Section matching on short text** shows up quickly: `--section PR` also matches "Approach".
- **Untested:** the aligned table for terminal output. The harness pipes stdout and can't fake a TTY.
- **Test timeouts.** Under load, `test/completion.test.ts` times out at bun's 5-second default, on a clean tree too. `bun test --timeout 20000` passes.

Tests follow `CLAUDE.md`: end-to-end through `apl(cwd, args)`, each test builds its own repo, and they're grouped by workflow (`reading`). Cover each new flag with a positive and a negative case. For example: search requires every term, a body-only match ranks below a title match, `--section` stops at the next heading of the same level, a `#` inside a code fence isn't a heading, and an unknown section lists the doc's headings. Tests run with stdout piped, so they exercise the compact `ls` path. Check that the aligned table still exists for terminal output only if the harness can fake a TTY; otherwise leave that path untested and say so in the PR. Run `bun test`, `bun run typecheck`, and `bun run lint` before each PR.

## Risks

- **Ranking.** If title matches crowd out body matches that matter, agents will miss docs. The `total` count and `--limit` keep this visible. Start simple and adjust only with evidence.
- **Scripts that parse the `ls` table.** Any script that splits padded `ls` output on whitespace breaks when the output becomes tab-separated. None are known; gazebo's skills use `--json`. Mention the change in the release notes.
- **Heading matching on short text.** `--section "PR"` matches many headings. That's intended: printing them all is cheaper for an agent than another round trip.

## Out of scope

These are gazebo changes, not apl changes, listed here so they aren't lost:

- Gazebo's `project-lead` skill writes its "what we built" handoff with the default `open` status. It should set `closed`.
- Gazebo's `research`, `sentry-fix`, and `project-lead` skills should start with `apl search <keywords>` once PR 2 ships.
- Gazebo's `plan/2026-10-20-opportunity-offering-source.md` uses `status: completed`, which the plan type doesn't allow, and should be changed to `done`.
