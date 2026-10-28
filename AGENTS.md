# AGENTS.md: pyramid viewer

A small, dependency-free viewer for documentation pyramids (layered markdown docs). It serves the docs live, exports them as static HTML or one Markdown file, and shows the layers as a picture of bricks and as a tree. Read `README.md` for usage, the docs layout and the known limits.

## Rules

* Node ES module (entry `viewer.js`, helpers in `src/`), no npm dependencies, no framework, no build step. One vendored markdown library file is the only third-party code. Tests use `node --test tests/*.test.js`; `tools/measure.js` is the performance script and is not part of the test run.
* Plain professional language, no emojis, in every file.
* Fixtures contain invented text only. No private business details, no local absolute paths in tracked files.
* Write code and CSS fresh from the described behaviour; do not copy code from other projects. The owner's own earlier viewers are the one exception for looks: their colours, spacing and animation values may be ported into our tokens and CSS. No image files or font files in the repository except the screenshots in `docs/screenshots/` and the official IBM Plex fonts in `vendor/fonts/` (unmodified, with their licence and a notice that records their hashes).
* Heading levels are the same everywhere: a layer file has one `#` title, modules are `##` with `###` sections, and a broken-out file has no `#` and starts at the module's `##`. No tool changes a level when it moves or combines text. Details in `README.md`.
* Small commits, tests with every behaviour. Say what is unverified: the README states what was tested and what does not work.

## Where things are

* `viewer.js`: pure functions and the entry point. `src/`: server, pages, export, markdown export, command line, watcher, Node version guard. `assets/`: the dialog script and the live-update script. `skins/`: the base stylesheet and the two themes.
* `tools/refresh-pyramid.js` and `tools/refresh-pyramid.md`: the routing-table tool that ships with the documentation pyramid (see its reference for the findings and modes).
* `vendor/`: the pinned markdown-it bundle with its notice and checksum.
