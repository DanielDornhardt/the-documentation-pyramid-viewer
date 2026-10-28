// Which documents make bricks: the "bricks" modes, the "include" list,
// the defaults, validation, row layout, tints, the count of documents that are not on the pyramid, and the
// places where that count is shown. Fixture: tests/fixtures/bricks (invented text).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverLayers, loadPyramid, buildBricks, parseLayerConfig, renderOverviewPage } from '../viewer.js';
import { main } from '../src/cli.js';
import { startServer } from '../src/server.js';
import { fixture, runCli } from './helpers.js';

const root = fixture('bricks');
let base;
before(async () => {
  base = await mkdtemp(join(tmpdir(), 'pv-bricks-'));
});
after(() => rm(base, { recursive: true, force: true }));

const labels = (layer) => layer.bricks.map((b) => b.label);
const byId = (model) => Object.fromEntries(model.all.map((l) => [l.id, l]));
const l3 = { id: 'L3', label: 'L3 Modules', path: 'L3-modules', kind: 'folder' };

function streams() {
  const out = [];
  const err = [];
  return { out, err, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
}

// ---- defaults ------------------------------------------------------------------------------------

test('defaults: a folder with an index file uses index, a folder without one uses headings, L1 stays one brick per file', async () => {
  const layers = await discoverLayers(root);
  assert.deepEqual(layers.map((l) => [l.id, l.bricks]), [
    ['L1', 'file'],
    ['L2', 'headings'],
    ['L3', 'index'],
    ['L4', 'index'],
    ['L5', 'headings'],
    ['L6', 'index']
  ]);
});

test('defaults in a config file follow the same rule; decision records and an explicit value win', async () => {
  const layers = await discoverLayers(root, {
    layers: [
      { id: 'a', label: 'A', path: 'L3-modules', kind: 'folder' },
      { id: 'b', label: 'B', path: 'L5-notes', kind: 'folder' },
      { id: 'c', label: 'C', path: 'L2-architecture.md', kind: 'file' },
      { id: 'd', label: 'D', path: 'stories', kind: 'folder', decisions: true },
      { id: 'e', label: 'E', path: 'L6-plain', kind: 'folder', bricks: 'headings' }
    ]
  });
  assert.deepEqual(layers.map((l) => l.bricks), ['index', 'headings', 'headings', 'file', 'headings']);
});

test('the fixture of decision records keeps one brick per file', async () => {
  const model = await loadPyramid(fixture('pyramid'));
  assert.deepEqual(model.decisions[0].bricks.map((b) => b.slug), [null, null, null]);
  assert.equal(model.decisions[0].bricks.length, 3);
});

// ---- the modes -----------------------------------------------------------------------------------

test('index mode: bricks are the second-level headings of the index file only', async () => {
  const model = byId(await loadPyramid(root));
  assert.deepEqual(labels(model.L3), ['Reading tides', 'Writing tides']);
  assert.deepEqual(model.L3.bricks.map((b) => [b.path, b.slug]), [['L3-modules/index.md', 'reading-tides'], ['L3-modules/index.md', 'writing-tides']]);
});

test('index mode: README.md is the index when there is no index.md', async () => {
  const model = byId(await loadPyramid(root));
  assert.deepEqual(labels(model.L4), ['Backup', 'Restore']);
  assert.ok(model.L4.bricks.every((b) => b.path === 'L4-operations/README.md'));
});

test('index mode: an index without any second-level heading is one brick labelled with its title', async () => {
  const model = byId(await loadPyramid(root));
  assert.deepEqual(model.L6.bricks, [{ layerId: 'L6', label: 'L6 Plain', path: 'L6-plain/index.md', slug: null }]);
});

test('headings mode: every file in folder order, a file without a heading is one brick', async () => {
  const model = byId(await loadPyramid(root, { layers: [{ ...l3, bricks: 'headings' }, { id: 'L5', label: 'L5', path: 'L5-notes', kind: 'folder' }] }));
  assert.deepEqual(labels(model.L3), ['Reading tides', 'Writing tides', 'Tide', 'Neap', 'Parsing readings', 'Reading errors', 'Writer flow']);
  assert.deepEqual(labels(model.L5), ['Alpha one', 'Alpha two', 'Beta']);
  assert.equal(model.L5.bricks[2].slug, null);
});

test('file mode: one brick per file and no heading target', async () => {
  const model = byId(await loadPyramid(root, { layers: [{ ...l3, bricks: 'file' }] }));
  assert.deepEqual(model.L3.bricks.map((b) => [b.label, b.path, b.slug]), [
    ['L3 Modules', 'L3-modules/index.md', null],
    ['Glossary', 'L3-modules/glossary.md', null],
    ['Reader', 'L3-modules/reader.md', null],
    ['Writer', 'L3-modules/writer.md', null]
  ]);
});

test('index mode without an index file falls back to the headings of every file', async () => {
  const model = byId(await loadPyramid(root, { layers: [{ id: 'L5', label: 'L5', path: 'L5-notes', kind: 'folder', bricks: 'index' }] }));
  assert.deepEqual(labels(model.L5), ['Alpha one', 'Alpha two', 'Beta']);
});

test('a file layer in index mode gives the headings of its file', async () => {
  const model = byId(await loadPyramid(root, { layers: [{ id: 'L2', label: 'L2', path: 'L2-architecture.md', kind: 'file', bricks: 'index' }] }));
  assert.deepEqual(labels(model.L2), ['Harbour office', 'Tide board']);
});

// ---- include -------------------------------------------------------------------------------------

test('include: headings of listed documents follow the bricks of the index, in the order given', async () => {
  const model = byId(await loadPyramid(root, { layers: [{ ...l3, include: ['L3-modules/writer.md', 'L3-modules/glossary.md'] }] }));
  assert.deepEqual(labels(model.L3), ['Reading tides', 'Writing tides', 'Writer flow', 'Tide', 'Neap']);
  assert.equal(model.L3.bricks[2].path, 'L3-modules/writer.md');
  assert.equal(model.L3.offPyramid.length, 1);
});

test('include: a listed document without a second-level heading is one brick; a repeated path counts once', async () => {
  const model = byId(await loadPyramid(root, { layers: [{ id: 'L5', label: 'L5', path: 'L5-notes', kind: 'folder', bricks: 'index', include: ['L5-notes/beta.md', 'L5-notes/beta.md'] }] }));
  // there is no index here, so the fallback is headings mode and include is not needed; the list is still checked
  assert.deepEqual(labels(model.L5), ['Alpha one', 'Alpha two', 'Beta']);
  const withIndex = byId(await loadPyramid(root, { layers: [{ id: 'L6', label: 'L6', path: 'L6-plain', kind: 'folder', include: ['L6-plain/other.md', './L6-plain/other.md'] }] }));
  assert.deepEqual(labels(withIndex.L6), ['L6 Plain', 'Other section']);
});

test('include: an unknown path is an error that names the layer and the path', async () => {
  await assert.rejects(
    loadPyramid(root, { layers: [{ ...l3, include: ['L3-modules/missing.md'] }] }),
    /Layer "L3".*"include".*"L3-modules\/missing\.md".*not a document of this layer/s
  );
  // a document of another layer is not a document of this one
  await assert.rejects(loadPyramid(root, { layers: [{ ...l3, include: ['L4-operations/README.md'] }, { id: 'L4', label: 'L4', path: 'L4-operations', kind: 'folder' }] }), /Layer "L3".*L4-operations\/README\.md/s);
});

test('include: must be an array of strings', () => {
  assert.throws(() => parseLayerConfig([{ ...l3, include: 'L3-modules/writer.md' }]), /"include" must be a list of document paths/);
  assert.throws(() => parseLayerConfig([{ ...l3, include: [5] }]), /"include" must be a list of document paths/);
});

// ---- validation ----------------------------------------------------------------------------------

test('an unknown "bricks" value is an error that lists the valid values', () => {
  assert.throws(() => parseLayerConfig([{ ...l3, bricks: 'all' }]), (error) => {
    assert.match(error.message, /"bricks" must be one of: index, headings, file/);
    assert.match(error.message, /"all"/);
    return true;
  });
  assert.throws(() => parseLayerConfig([{ ...l3, bricks: 3 }]), /must be one of: index, headings, file/);
});

test('the old values "headings" and "file" are still accepted', () => {
  assert.equal(parseLayerConfig([{ ...l3, bricks: 'headings' }])[0].bricks, 'headings');
  assert.equal(parseLayerConfig([{ ...l3, bricks: 'file' }])[0].bricks, 'file');
});

test('a config error from the command line exits non-zero with a message and no stack trace', async () => {
  const file = join(base, 'bad-layers.json');
  await writeFile(file, JSON.stringify([{ ...l3, bricks: 'everything' }]));
  for (const args of [['markdown', root, join(base, 'bad.md')], ['export', root, join(base, 'bad-out')]]) {
    const { code, stderr } = await runCli([...args, '--layers', file]);
    assert.equal(code, 1, args[0]);
    assert.match(stderr, /^Error: .*"bricks" must be one of: index, headings, file/);
    assert.ok(!/\n\s+at /.test(stderr), 'no stack trace');
  }
  const bad = join(base, 'bad-include.json');
  await writeFile(bad, JSON.stringify([{ ...l3, include: ['L3-modules/nope.md'] }]));
  const { code, stderr } = await runCli(['markdown', root, join(base, 'bad2.md'), '--layers', bad]);
  assert.equal(code, 1);
  assert.match(stderr, /Layer "L3".*nope\.md/);
  assert.ok(!/\n\s+at /.test(stderr));
});

test('serve refuses to start on a config error instead of answering with errors', async () => {
  await assert.rejects(startServer({ root, port: 0, layers: [{ ...l3, bricks: 'everything' }], log: { info() {}, warn() {} } }), /"bricks" must be one of/);
});

// ---- buildBricks directly ------------------------------------------------------------------------

test('buildBricks index mode uses the first document when it is an index file', () => {
  const docs = [
    { path: 'x/index.md', title: 'X', headings: [{ level: 2, text: 'One', slug: 'one' }] },
    { path: 'x/more.md', title: 'More', headings: [{ level: 2, text: 'Two', slug: 'two' }] }
  ];
  assert.deepEqual(buildBricks({ id: 'X', bricks: 'index' }, docs).map((b) => b.label), ['One']);
  assert.deepEqual(buildBricks({ id: 'X', bricks: 'index', include: ['x/more.md'] }, docs).map((b) => b.label), ['One', 'Two']);
  assert.deepEqual(buildBricks({ id: 'X', bricks: 'headings' }, docs).map((b) => b.label), ['One', 'Two']);
});

// ---- layout interplay ----------------------------------------------------------------------------

test('the row rule is unchanged: index bricks fill rows 1, 2, 3 ... across layers', async () => {
  const model = await loadPyramid(root);
  // L1 1 brick, L2 2, L3 2, L4 2, L5 3, L6 1: each layer is one row, and the width counter advances by one per layer
  assert.deepEqual(model.layers.map((l) => l.rows.map((r) => r.length)), [[1], [2], [2], [2], [3], [1]]);
});

test('an index layer with many sections keeps the short-last-row rule', async () => {
  const dir = join(base, 'many');
  await mkdir(join(dir, 'L3-modules'), { recursive: true });
  await writeFile(join(dir, 'L1-vision.md'), '# Vision\n');
  await writeFile(join(dir, 'L3-modules', 'index.md'), `# Modules\n\n${Array.from({ length: 6 }, (_, i) => `## Section ${i + 1}\n\ntext\n`).join('\n')}`);
  const model = await loadPyramid(dir);
  // width 2 after L1: rows 2 and 4 would leave nothing short; 6 bricks = 2 + 3 + 1 -> the 1 moves to the top
  assert.deepEqual(model.layers[1].rows.map((r) => r.length), [1, 2, 3]);
  assert.equal(model.layers[1].rows[0][0].label, 'Section 1');
});

// ---- extra layer for story files, many bricks, tints ---------------------------------------------

test('an extra story-style layer with bricks "file", a label and a description works', async () => {
  const model = byId(await loadPyramid(root, {
    layers: [
      { id: 'L3', label: 'Modules', path: 'L3-modules', kind: 'folder' },
      { id: 'stories', label: 'Story archive', path: 'stories', kind: 'folder', bricks: 'file', description: 'Finished stories' }
    ]
  }));
  assert.equal(model.stories.bricks.length, 3);
  assert.equal(model.stories.description, 'Finished stories');
  assert.ok(model.stories.bricks.every((b) => b.slug === null));
  assert.equal(model.stories.offPyramid.length, 0);
});

test('tints cycle for more than six layers, in the page, the base stylesheet and both themes', async () => {
  const dir = join(base, 'tints');
  await mkdir(dir, { recursive: true });
  const layers = [];
  for (let i = 1; i <= 9; i++) {
    await writeFile(join(dir, `part-${i}.md`), `# Part ${i}\n\n## Section ${i}\n`);
    layers.push({ id: `P${i}`, label: `Part ${i}`, path: `part-${i}.md`, kind: 'file' });
  }
  const pyramid = await loadPyramid(dir, { layers });
  const links = { overview: () => 'index.html', doc: (v, p) => p, styles: () => ['a.css'] };
  const html = renderOverviewPage({ pyramid, links });
  const tints = [...html.matchAll(/data-tint="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(tints, [0, 1, 2, 3, 4, 5, 0, 1, 2]);
  // The tint rules live in the shared base stylesheet; both themes define the six tints.
  const baseCss = await readFile(new URL('../skins/pv-base.css', import.meta.url), 'utf8');
  for (const t of tints) assert.match(baseCss, new RegExp(`\\.layer\\[data-tint="${t}"\\]`));
  for (const skin of ['light', 'metal']) {
    const css = await readFile(new URL(`../skins/${skin}.css`, import.meta.url), 'utf8');
    for (const t of tints) assert.match(css, new RegExp(`--pv-tint-${t}:`));
  }
});

test('a layer with 240 story files lays out in growing rows and every brick is a link', async () => {
  const dir = join(base, 'archive');
  await mkdir(join(dir, 'stories'), { recursive: true });
  await writeFile(join(dir, 'L1-vision.md'), '# Vision\n');
  for (let i = 0; i < 240; i++) await writeFile(join(dir, 'stories', `story-${String(i).padStart(3, '0')}.md`), `# Story ${i}\n\n## Context\n\ntext\n`);
  const layers = [
    { id: 'L1', label: 'L1', path: 'L1-vision.md', kind: 'file' },
    { id: 'stories', label: 'Story archive', path: 'stories', kind: 'folder', bricks: 'file' }
  ];
  const model = await loadPyramid(dir, { layers });
  const rows = model.layers[1].rows;
  assert.equal(rows.flat().length, 240);
  // widths start at 2 and grow by one; only the short last row may move to the top
  const widths = rows.map((r) => r.length);
  for (let i = 2; i < widths.length; i++) assert.equal(widths[i], widths[i - 1] + 1);
  const html = renderOverviewPage({ pyramid: model, links: { overview: () => 'index.html', doc: (v, p) => p, styles: () => ['a.css'] } });
  assert.equal((html.match(/<li class="brick">/g) || []).length, 241);
});

// ---- not on the pyramid ---------------------------------------------------------------------------

test('the model counts documents that make no brick, per layer and in total', async () => {
  const model = await loadPyramid(root);
  const layers = byId(model);
  assert.deepEqual(layers.L3.offPyramid, ['L3-modules/glossary.md', 'L3-modules/reader.md', 'L3-modules/writer.md']);
  assert.deepEqual(layers.L4.offPyramid, ['L4-operations/restore-details.md']);
  assert.deepEqual(layers.L5.offPyramid, []);
  assert.deepEqual(layers.L6.offPyramid, ['L6-plain/other.md']);
  assert.equal(model.offPyramid, 5);
  assert.equal(model.all.flatMap((l) => l.docs).length, 12);
});

test('with bricks "headings" every document is on the pyramid', async () => {
  const model = await loadPyramid(root, { layers: [{ ...l3, bricks: 'headings' }] });
  assert.equal(model.offPyramid, 0);
});

test('the tree view, the documents and the Markdown export keep every document', async () => {
  const model = await loadPyramid(root);
  assert.equal(model.all.flatMap((l) => l.docs).length, 12);
  const out = join(base, 'all.md');
  const { code } = await runCli(['markdown', root, out]);
  assert.equal(code, 0);
  const text = await readFile(out, 'utf8');
  for (const name of ['L3-modules/glossary.md', 'L3-modules/reader.md', 'L3-modules/writer.md', 'L4-operations/restore-details.md', 'L6-plain/other.md']) {
    assert.ok(text.includes(`<!-- source: ${name} -->`), name);
  }
});

const NOTE = /5 documents are not on the pyramid \(/;

test('export prints one line with the count, and none when the count is 0', async () => {
  const s = streams();
  assert.equal(await main(['export', root, join(base, 'out-both')], s), 0);
  const lines = s.out.join('').split('\n').filter((l) => /not on the pyramid/.test(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '5 documents are not on the pyramid (they are in the tree view; 2 of them are not linked from an index).');
  const none = streams();
  assert.equal(await main(['export', fixture('minimal'), join(base, 'out-minimal')], none), 0);
  assert.ok(!/not on the pyramid/.test(none.out.join('') + none.err.join('')));
});

test('export of the pyramid view alone does not point to a tree view that is not there', async () => {
  const s = streams();
  await main(['export', root, join(base, 'out-pyr'), '--view', 'pyramid'], s);
  const line = s.out.join('').split('\n').find((l) => /not on the pyramid/.test(l));
  assert.match(line, /^5 documents are not on the pyramid \(/);
  assert.ok(!/tree view/.test(line));
});

test('markdown prints the line and says the documents are in the file', async () => {
  const s = streams();
  assert.equal(await main(['markdown', root, join(base, 'm.md')], s), 0);
  const line = (s.out.join('') + s.err.join('')).split('\n').find((l) => /not on the pyramid/.test(l));
  assert.match(line, NOTE);
  assert.match(line, /Markdown file/);
});

test('one document is worded in the singular', async () => {
  const dir = join(base, 'single');
  await mkdir(join(dir, 'L3-modules'), { recursive: true });
  await writeFile(join(dir, 'L3-modules', 'index.md'), '# M\n\n## A\n');
  await writeFile(join(dir, 'L3-modules', 'fork.md'), '# F\n\n## B\n');
  const s = streams();
  await main(['markdown', dir, join(base, 's.md')], s);
  assert.match(s.out.join('') + s.err.join(''), /1 document is not on the pyramid \(/);
});

test('serve prints the line at start-up', async () => {
  const lines = [];
  const running = await startServer({ root, port: 0, log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) } });
  try {
    assert.equal(lines.filter((l) => /not on the pyramid/.test(l)).length, 1);
    assert.match(lines.join('\n'), NOTE);
  } finally {
    await running.close();
  }
});

test('the exported pyramid overview has a calm note with the count and a link to the tree view', async () => {
  const out = join(base, 'out-note');
  await main(['export', root, out], streams());
  const html = await readFile(join(out, 'index.html'), 'utf8');
  const note = /<p class="pyramid-note">([\s\S]*?)<\/p>/.exec(html);
  assert.ok(note, 'note present');
  assert.equal(note[1], '5 documents are not on the pyramid. <a href="_tree/index.html">They are in the tree view.</a>');
  assert.ok(!/[^\x00-\x7F]/.test(note[0]), 'no emoji or special characters');
  assert.ok(html.indexOf('class="pyramid-note"') > html.indexOf('class="pyramid"'), 'under the pyramid');
  const tree = await readFile(join(out, '_tree', 'index.html'), 'utf8');
  assert.ok(!tree.includes('pyramid-note'));
});

test('the note has no link when the tree view is not part of the output, and is absent for a count of 0', async () => {
  const out = join(base, 'out-note-pyr');
  await main(['export', root, out, '--view', 'pyramid'], streams());
  const html = await readFile(join(out, 'index.html'), 'utf8');
  assert.match(html, /<p class="pyramid-note">5 documents are not on the pyramid\.<\/p>/);
  const zero = join(base, 'out-note-zero');
  await main(['export', fixture('minimal'), zero], streams());
  assert.ok(!(await readFile(join(zero, 'index.html'), 'utf8')).includes('pyramid-note'));
});

test('the note says "1 document" for one, and the count in the served overview is the same', async () => {
  const dir = join(base, 'single');
  const running = await startServer({ root: dir, port: 0, log: { info() {}, warn() {} } });
  try {
    const html = await (await fetch(`${running.url}`)).text();
    assert.match(html, /<p class="pyramid-note">1 document is not on the pyramid\. <a href="\/_tree\/">It is in the tree view\.<\/a><\/p>/);
  } finally {
    await running.close();
  }
});
