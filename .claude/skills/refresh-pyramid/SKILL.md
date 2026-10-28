---
name: refresh-pyramid
description: Check and refresh the routing table (root index.md) of a documentation pyramid with tools/refresh-pyramid.js. Use only when the project has a docs folder with a root index.md, layer files like L1-vision.md and L3-modules.md, and pyramid:begin marker lines, and the documents were edited (before committing documentation changes), or when asked to refresh, check, lint or update the pyramid index, routing table, bylines or module line numbers, or when a section has grown long.
---

# Refresh the documentation pyramid index

The tool is `tools/refresh-pyramid.js` (one file, Node 20.11+, no dependencies; reference: `tools/refresh-pyramid.md`). It never edits a document: it regenerates the routing blocks of `docs/index.md` and prints findings. You fix the documents by hand. If the tool is not in the project, say so and ask where to copy it from; do not write your own. The docs folder is `docs` unless the project says otherwise; if it is unclear which folder is the pyramid, ask before running anything.

## Loop

1. Look without writing:

   ```sh
   node tools/refresh-pyramid.js docs --dry-run
   ```

   Lines that start with `error`, `warning` or `status` are findings: `error E2 <file>:<line>: <what is wrong> (fix: <what to do>)`. Errors (E) must be fixed, warnings (W) should be, `S1` only says the index is stale. `info` lines are counts per layer.

2. Fix the documents by editing them, following the `fix:` text of each finding. Typical cases:
   * W1 (section over 100 lines): cut the whole `##` section and paste it unchanged into a new file `L3-modules/<name>.md` that starts at its `## ` heading. Never cut detail to get under the limit.
   * W2, W3, E5 (byline missing or too long): write one sentence of at most 100 characters directly under the heading.
   * E1, E2, W5 (folder index, duplicate module, broken-out file shape): the finding names the file; ask the user before deleting content.
   * E3, E4, E7: markers, missing index or unreadable files; fix the named lines or permissions, or report them and stop.

3. Refresh the index:

   ```sh
   node tools/refresh-pyramid.js docs
   ```

   It rewrites the generated blocks between the `pyramid:begin` and `pyramid:end` marker lines. For a layer without markers it appends a block to the end of `index.md` (after a `## Routing table` heading, added if missing) and says so; tell the user.

4. Run `node tools/refresh-pyramid.js docs --check`. Repeat from step 2 until it exits 0 or only warnings the user accepts remain.

## Report

Say which blocks or rows changed, which documents you edited, and which findings remain (with codes). Say what you did not run. Every command you write for the user must have been run by you in a scratch copy first.
