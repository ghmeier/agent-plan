---
name: apl
description: Store and find plans, research notes, and handoffs with the `apl` CLI. Use when writing or revising a plan, recording research, handing work off to another person or session, or looking for earlier planning on an area of the code.
---

# Working with docs in `.apl/`

Plans, research, and handoffs live in `.apl/`, a directory shared by every checkout of this repo and synced with teammates on a separate git branch. They never go in the code branch.

## Find earlier work first

`.apl` is git-ignored (and a symlink outside the main checkout), so Grep and Glob skip it unless you point them at it. Before writing a new doc, look for existing ones:

- `apl ls --json` lists docs newest first with type, title, status, and tags. Narrow it with `--type plan`, `--status active`, or `--tag billing`.
- Search content with Grep and `path: ".apl"`.
- `apl show <path>` prints a doc, and `apl status` shows uncommitted docs and whether teammates have pushed changes since the last pull.

## Create a doc

```bash
apl new plan billing/stripe-retries --title "Stripe webhook retries" --tag billing
```

`apl new <type> <area>/<slug>` creates `.apl/<type>/<area>/<slug>.md` from a template and prints its path, so don't repeat the type in the name. Pass `--title`; without it the title comes from the file name. Then fill it in with your normal file tools. The built-in types are `plan`, `research`, and `handoff`; run `apl types` to see this team's types and their statuses. Name docs by the area of the code they cover.

Edit existing docs in place with normal file tools. Keep `status` in the frontmatter current as work moves along (for example `draft`, then `active`, then `completed` for a plan). Don't edit the `created` and `updated` dates; apl sets them.

## Publish

This plugin's Stop hook runs `apl sync` at the end of every turn, which commits doc edits, rebases onto teammates' changes, and pushes. Don't run `apl commit` or `apl sync` after each edit. Run `apl sync` yourself only when teammates need to see a doc before the turn ends.

- Never run `git` inside `.apl/`, and never `git add` anything under `.apl` in the code repo.
- If `apl sync` reports a conflict, stop and tell the user which files conflict. Don't try to resolve it, and never edit a file that contains `<<<<<<<` markers.

## Hand off work

When stopping partway, or when the user asks for a handoff:

1. `apl new handoff <area>/<slug>` and fill in each section, especially "Next steps" and "Gotchas". Link the plan it continues.
2. Set the plan's `status` if it changed.
3. Give the user the handoff's path. The Stop hook publishes it.

To pick up a handoff, find it with `apl ls --type handoff --status open`, read it, and set its status to `picked-up`.
