---
name: apl
description: Store and find plans, research notes, and handoffs with the `apl` CLI. Use when writing or revising a plan, recording research, handing work off to another person or session, or looking for earlier planning on an area of the code.
---

# Working with docs in `.apl/`

Plans, research, and handoffs live in `.apl/`, a directory shared by every checkout of this repo and synced with teammates on a separate git branch. They never go in the code branch.

## Find earlier work first

`.apl` is git-ignored (and a symlink outside the main checkout), so Grep and Glob skip it unless you point them at it. Before writing a new doc, look for existing ones:

- `apl search <keywords>` finds docs that contain every keyword in their path, title, tags, or body, and prints up to 2 matching lines from each with their line numbers. Narrow it with `--type plan`, `--status active`, or `--tag billing`.
- `apl ls` lists docs newest first with type, title, status, and tags, and takes the same filters.
- `apl show <path>` prints a doc. For a long doc, run `apl show <path> --outline` to list its headings, then `apl show <path> --section "<heading>"` to print only the part you need.
- `apl status` shows uncommitted docs and whether teammates have pushed changes since the last pull.

## Linked branches

Reading or editing a doc from a work branch links the doc to that branch automatically, so there is nothing to maintain. Read plans with `apl show`, which always attributes the read to the right branch.

- `apl links` lists every link. `apl links <doc>` lists the branches that implement a doc, and `apl links --branch` lists the docs a branch is for.
- When an implementer will not open the plan itself, for example an orchestrator that pastes a section into a subagent's prompt, run `apl link <doc> --branch <name>`.
- `apl unlink <doc> --branch <name>` removes a link that is wrong.

## Create a doc

```bash
apl new plan billing/stripe-retries --title "Stripe webhook retries" --tag billing
```

`apl new <type> <area>/<slug>` creates `.apl/<type>/<area>/<slug>.md` from a template and prints its path, so don't repeat the type in the name. Pass `--title`; without it the title comes from the file name. Then fill it in with your normal file tools. The built-in types are `plan`, `research`, and `handoff`; run `apl types` to see this team's types and their statuses. Name docs by the area of the code they cover.

Edit existing docs in place with normal file tools. Keep `status` in the frontmatter current as work moves along. Teams can define their own types and statuses, so pick a status that `apl types` lists for the doc's type rather than assuming one. With the built-in types, a plan goes `draft`, then `active`, then `completed` or `archived`. Don't edit the `created` and `updated` dates; apl sets them.

## Publish

This plugin's Stop hook runs `apl sync` at the end of every turn, which commits doc edits, rebases onto teammates' changes, and pushes. Don't run `apl commit` or `apl sync` after each edit. Run `apl sync` yourself only when teammates need to see a doc before the turn ends.

- Never run `git` inside `.apl/`, and never `git add` anything under `.apl` in the code repo.
- If `apl sync` or the Stop hook reports a conflict, stop and tell the user which files conflict. Don't try to resolve it, and never edit a file that contains `<<<<<<<` markers.

## Hand off work

When stopping partway, or when the user asks for a handoff:

1. `apl new handoff <area>/<slug>` and fill in each section, especially "Next steps" and "Gotchas". Link the plan it continues.
2. Set the plan's `status` if it changed.
3. Give the user the handoff's path. The Stop hook publishes it.

A handoff written as a final summary, with nothing left for anyone to pick up, should be set to `closed` right away. Otherwise it stays `open`, and the session-start hook lists it in every session.

To pick up a handoff, find it with `apl ls --type handoff --status open`, read it, and set its status to `picked-up`.
