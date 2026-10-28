// Fixes after review: errors in pyramid.json while serving, honest
// "not on the pyramid" lines, empty headings, and the checks of "decisions", "label" and a byte order mark.
// Every fixture is invented and written into a temporary folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPyramid, parseLayerConfig, renderOverviewPage } from '../viewer.js';
import { main } from '../src/cli.js';
import { startServer } from '../src/server.js';
import { notOnPyramidLine } from '../src/export.js';

let base;
before(async () => {
  base = await mkdtemp(join(tmpdir(), 'pv-fixes-'));
});
after(() => rm(base, { recursive: true, force: true }));

function streams() {
  const out = [];
  const err = [];
  return { out, err, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
}

async function docs(name, files) {
  const dir = join(base, name);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, ...path.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...path.split('/')), text);
  }
  return dir;
}

// ---- C1: a broken pyramid.json while serving ----------------------------------------------------

test('a layer-config mistake made while serving gives a readable message and a log line, and the server recovers', async () => {
  const dir = await docs('c1', { 'L3-modules/index.md': '# M\n\n## A\n', 'L3-modules/f.md': '# F\n' });
  const lines = [];
  const running = await startServer({ root: dir, port: 0, log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) } });
  try {
    assert.equal((await fetch(running.url)).status, 200);
    await writeFile(join(dir, 'pyramid.json'), JSON.stringify({ layers: [{ id: 'a', path: 'L3-modules', kind: 'folder', include: ['zz.md'] }] }));
    for (const path of ['', 'L3-modules/index.md']) {
      const res = await fetch(running.url + path);
      assert.equal(res.status, 500);
      const body = await res.text();
      assert.match(body, /"include" lists "zz.md"/);
      assert.match(body, /Fix pyramid.json/);
    }
    assert.ok(lines.some((l) => /"include" lists "zz.md"/.test(l)), 'logged');
    await rm(join(dir, 'pyramid.json'));
    assert.equal((await fetch(running.url)).status, 200);
  } finally {
    await running.close();
  }
});

// ---- C2 and F1: honest lines ----------------------------------------------------------------------

test('the line does not claim that an index links documents it does not link', () => {
  assert.equal(notOnPyramidLine(3, 'tree'), '3 documents are not on the pyramid (they are in the tree view).');
  assert.equal(notOnPyramidLine(3, 'tree', 1), '3 documents are not on the pyramid (they are in the tree view; 1 of them is not linked from an index).');
  assert.equal(notOnPyramidLine(3, 'pages', 3), '3 documents are not on the pyramid (they are exported as pages; none of them is linked from an index).');
  assert.equal(notOnPyramidLine(1, 'pages', 1), '1 document is not on the pyramid (it is exported as a page; it is not linked from an index).');
  assert.equal(notOnPyramidLine(0, 'tree'), null);
});

test('the model finds off-pyramid documents that no index links to', async () => {
  const dir = await docs('f1', {
    'L3-modules/index.md': '# M\n\n## A\n\nSee [the fork](fork.md#x) and `L3-modules/named.md` and [site](https://example.org/orphan.md).\n',
    'L3-modules/fork.md': '# Fork\n',
    'L3-modules/named.md': '# Named\n',
    'L3-modules/orphan.md': '# Orphan\n'
  });
  const model = await loadPyramid(dir);
  assert.equal(model.offPyramid, 3);
  assert.deepEqual(model.offPyramidUnlinked, ['L3-modules/orphan.md']);
});

test('a pyramid-only export lists the documents that nothing links to; with the tree view it does not', async () => {
  const dir = await docs('f1b', { 'L3-modules/index.md': '# M\n\n## A\n', 'L3-modules/orphan.md': '# Orphan module\n' });
  const s = streams();
  assert.equal(await main(['export', dir, join(base, 'f1b-pyr'), '--view', 'pyramid'], s), 0);
  assert.match(s.out.join(''), /1 document is not on the pyramid \(it is exported as a page; it is not linked from an index\)\./);
  const html = await readFile(join(base, 'f1b-pyr', 'index.html'), 'utf8');
  assert.match(html, /<ul class="pyramid-note-list">\s*<li><a href="L3-modules\/orphan\.html">Orphan<\/a><\/li>/);
  assert.equal(await main(['export', dir, join(base, 'f1b-both')], streams()), 0);
  assert.ok(!(await readFile(join(base, 'f1b-both', 'index.html'), 'utf8')).includes('pyramid-note-list'));
});

test('markdown counts only the documents that are written', async () => {
  const dir = await docs('c2', {
    'L3-m/index.md': '# M\n\n## A\n',
    'L3-m/f.md': '# F\n',
    'adr/index.md': '# Records\n',
    'adr/002.md': '# Two\n',
    'adr/003.md': '# Three\n'
  });
  const layers = JSON.stringify([
    { id: 'L3', path: 'L3-m', kind: 'folder' },
    { id: 'adr', path: 'adr', kind: 'folder', decisions: true, bricks: 'index' }
  ]);
  const plain = streams();
  assert.equal(await main(['markdown', dir, join(base, 'c2.md'), '--layers', await writeLayers('c2-layers.json', layers)], plain), 0);
  const all = plain.out.join('') + plain.err.join('');
  assert.match(all, /1 document is not on the pyramid \(it is in the Markdown file\)/);
  const withDecisions = streams();
  assert.equal(await main(['markdown', dir, join(base, 'c2b.md'), '--decisions', '--layers', join(base, 'c2-layers.json')], withDecisions), 0);
  assert.match(withDecisions.out.join('') + withDecisions.err.join(''), /3 documents are not on the pyramid \(they are all in the Markdown file\)/);
});

async function writeLayers(name, text) {
  await writeFile(join(base, name), text);
  return join(base, name);
}

// ---- C3: empty headings ----------------------------------------------------------------------------

test('an empty second-level heading makes no brick', async () => {
  const dir = await docs('c3', { 'L2-x/index.md': '# X\n\n##\n## \n## A\n' });
  const model = await loadPyramid(dir);
  assert.deepEqual(model.all[0].bricks.map((b) => b.label), ['A']);
  const html = renderOverviewPage({ pyramid: model, links: { overview: () => 'index.html', doc: (v, p) => p, styles: () => ['a.css'] } });
  assert.ok(!/<a [^>]*><\/a>/.test(html));
});

test('an index whose second-level headings are all empty is one brick labelled with the title', async () => {
  const dir = await docs('c3b', { 'L2-x/index.md': '# The title\n\n##\n' });
  const model = await loadPyramid(dir);
  assert.deepEqual(model.all[0].bricks.map((b) => b.label), ['L2 X']);
});

// ---- C4: types and byte order mark -----------------------------------------------------------------

test('decisions and label must have the right type, and a byte order mark is accepted', () => {
  const entry = { id: 'adr', path: 'adr', kind: 'folder' };
  assert.throws(() => parseLayerConfig([{ ...entry, decisions: 'true' }]), /"decisions" must be true or false/);
  assert.throws(() => parseLayerConfig([{ ...entry, decisions: 1 }]), /"decisions" must be true or false/);
  assert.throws(() => parseLayerConfig([{ ...entry, label: 5 }]), /"label" must be a string/);
  assert.equal(parseLayerConfig([{ ...entry, decisions: true, label: 'Records' }])[0].decisions, true);
  assert.equal(parseLayerConfig(`﻿${JSON.stringify([entry])}`)[0].id, 'adr');
});
