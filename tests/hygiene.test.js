// AC 15 (honesty and repository hygiene).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { fixture } from './helpers.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'tmp', 'out']);
const TEXT_EXT = /\.(js|mjs|json|md|css|html|txt|gitignore|gitattributes)$|^\.git(ignore|attributes)$/;

async function trackedLikeFiles(dir = repo, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Dot folders (.git and tool folders such as an agent worktree with a full copy of the repository) are not part of the repository.
    if ((SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) && entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await trackedLikeFiles(full, out);
    else if (entry.isFile() && TEXT_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file) => relative(repo, file).split(sep).join('/');
const isMinified = (r) => r === 'vendor/markdown-it.esm.min.mjs';

test('no absolute local path appears in any file', async () => {
  const needle = '/Us' + 'ers/'; // built in two parts so this file does not contain the path itself
  const offenders = [];
  for (const file of await trackedLikeFiles()) {
    const r = rel(file);
    if (isMinified(r)) continue;
    if ((await readFile(file, 'utf8')).includes(needle)) offenders.push(r);
  }
  assert.deepEqual(offenders, []);
});

test('no emoji appears in any file', async () => {
  const emoji = /\p{Extended_Pictographic}/u;
  const offenders = [];
  for (const file of await trackedLikeFiles()) {
    const r = rel(file);
    if (isMinified(r)) continue;
    if (emoji.test(await readFile(file, 'utf8'))) offenders.push(r);
  }
  assert.deepEqual(offenders, []);
});

// Rule for ticket IDs (THE-nnn, LIN-nnn): the ID must be followed directly by a space and an opening
// parenthesis that holds at least three characters of description, for example "ABC-123 (login form)".
// A description that is cut at the end of a line (opening parenthesis, no closing one yet) is accepted.
// This is stricter than "a parenthesis or the word for within 80 characters" on purpose: it is simple and has no false passes.
const ticketOffenders = (line) =>
  [...line.matchAll(/\b(?:THE|LIN)-\d+\b/g)]
    .filter((m) => {
      const after = line.slice(m.index + m[0].length);
      return !/^ \([^)]{3,}\)/.test(after) && !/^ \([^)]*$/.test(after);
    })
    .map((m) => m[0]);

test('the ticket rule accepts a described ID and flags a bare one', () => {
  const id = (n) => 'TH' + 'E-' + n; // built in two parts so this file does not contain a bare ID itself
  assert.deepEqual(ticketOffenders(`See ${id(108)} (pyramid viewer and renderer) for details`), []);
  assert.deepEqual(ticketOffenders(`See ${id(108)} for details`), [id(108)]);
  assert.deepEqual(ticketOffenders(`${id(1)}, and ${id(2)} (x)`), [id(1), id(2)]);
});

test('every ticket ID is followed by a short description', async () => {
  const offenders = [];
  for (const file of await trackedLikeFiles()) {
    const r = rel(file);
    if (isMinified(r)) continue;
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const id of ticketOffenders(line)) offenders.push(`${r}:${i + 1} ${id}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the fixture covers the listed edge cases', async () => {
  const read = (p) => readFile(fixture('pyramid', p), 'utf8');
  const l1 = await read('L1-vision.md');
  const l2 = await read('L2-architecture.md');
  const storage = await read('L3-modules/storage.md');
  const ops = await read('L4-operations/index.md');
  assert.ok(l1.startsWith('---\n'), 'front matter');
  assert.ok(/^## x$/m.test(storage), 'a fenced block containing a heading line');
  assert.ok(/^##\s.*\[.*\]\(.*\)/m.test(l2), 'a heading with a link');
  assert.ok(/^##.*&amp;/m.test(l2), 'a heading with an entity');
  assert.ok(/^##.*[\u00c0-\u024f]/m.test(l2), 'a non-ASCII heading');
  assert.ok(/^\|.*\|$/m.test(l2), 'a table');
  assert.ok(/^## Overview$/m.test(l2) && l2.match(/^## Overview$/gm).length === 2, 'duplicate headings');
  assert.ok(/^###\s/m.test(l2), 'level three headings');
  assert.ok(ops.includes('<!--') && ops.includes('<script>'), 'an HTML comment and a script payload');
  assert.ok((await read('L3-modules/crlf.md')).includes('\r\n'), 'a CRLF file');
  const noSections = await read('L3-modules/notes.md');
  assert.ok(!/^##/m.test(noSections), 'a file without second level headings');
  for (const kind of ['](L3-modules/storage.md)', '](L3-modules/)', '#writing-tides)', '](../outside.md)', '](https://', '](mailto:', '](#overview)', '](L3-modules/missing.md)']) {
    assert.ok(l2.includes(kind), `link kind ${kind}`);
  }
  const missingAdr = await stat(fixture('minimal', 'adr')).catch(() => null);
  assert.equal(missingAdr, null, 'a fixture without adr');
  const empty = await readdir(fixture('pyramid', 'L5-empty'));
  assert.deepEqual(empty, ['.gitkeep'], 'an empty layer folder');
});
