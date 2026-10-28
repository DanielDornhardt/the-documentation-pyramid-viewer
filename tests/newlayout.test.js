// The revised layout: one file per layer (L3-modules.md) and a folder
// with the same name (L3-modules/) that holds only the broken-out modules. Both form ONE layer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverLayers, loadPyramid, buildBricks, parseLayerConfig, LayerConfigError, BRICK_MODES,
  renderOverviewPage, renderDocumentPage, exportHtml, exportMarkdown, startServer, main
} from '../viewer.js';
import { fixture, tempFixture, copyTree, walkExport } from './helpers.js';

const root = fixture('newlayout');
const quiet = { info() {}, warn() {} };
let base;
before(async () => {
  base = await mkdtemp(join(tmpdir(), 'pv-newlayout-'));
});
after(() => rm(base, { recursive: true, force: true }));

const byId = (model) => Object.fromEntries(model.all.map((l) => [l.id, l]));
const labels = (layer) => layer.bricks.map((b) => b.label);

/** A page link mapper like the one of the static export, enough to render the pages. */
const links = {
  overview: (view) => (view === 'tree' ? '_tree/index.html' : 'index.html'),
  doc: (view, path, fragment) => `${path.replace(/\.md$/, '.html')}${fragment ? `#${fragment}` : ''}`,
  styles: () => ['skins/pv-base.css']
};

/** A docs folder written from a plain map of paths to texts (a folder entry ends with a slash). */
async function makeDocs(files) {
  const dir = await mkdtemp(join(base, 'docs-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, ...path.split('/').slice(0, -1)), { recursive: true });
    if (!path.endsWith('/')) await writeFile(join(dir, ...path.split('/')), text);
  }
  return dir;
}

// ---- discovery -------------------------------------------------------------------------------------

test('a layer file and the folder with the same name are one layer, in the order L1 to L4 and adr', async () => {
  const layers = await discoverLayers(root);
  assert.deepEqual(layers.map((l) => l.id), ['L1', 'L2', 'L3', 'L4', 'adr']);
  assert.deepEqual(layers.map((l) => l.label), ['L1 Vision', 'L2 Architecture', 'L3 Modules', 'L4 Operations', 'ADRs']);
  assert.deepEqual(layers.map((l) => l.bricks), ['file', 'modules', 'modules', 'modules', 'file']);
});

test('the layer file comes first, then the folder files by name; nothing in the folder is dropped', async () => {
  const layers = byId(await loadPyramid(root));
  assert.deepEqual(layers.L3.files.map((f) => f.path), ['L3-modules.md', 'L3-modules/harbor-routes.md', 'L3-modules/tide-tables.md', 'L3-modules/zeta-notes.md']);
  assert.equal(layers.L3.layerFile, 'L3-modules.md');
  assert.equal(layers.L3.folder, 'L3-modules');
  assert.deepEqual(layers.L3.folderIndex, null);
});

test('a folder index.md next to a layer file is an ordinary document in byte order, and is reported', async () => {
  const model = await loadPyramid(root);
  const l4 = byId(model).L4;
  assert.deepEqual(l4.files.map((f) => f.path), ['L4-operations.md', 'L4-operations/index.md', 'L4-operations/release-checklist.md']);
  assert.equal(l4.folderIndex, 'L4-operations/index.md');
  assert.deepEqual(model.folderIndexes, ['L4-operations/index.md']);
});

test('an empty folder (only .gitkeep) changes nothing, and a folder with only a .gitkeep and no layer file is dropped', async () => {
  const layers = byId(await loadPyramid(root));
  assert.deepEqual(layers.L2.files.map((f) => f.path), ['L2-architecture.md']);
  assert.ok(!Object.keys(layers).includes('L5'));
});

test('L1 may have a folder too: one brick per document, the layer file first', async () => {
  const dir = await makeDocs({ 'L1-vision.md': '# Vision\n\n## Why\n\nText.\n', 'L1-vision/background.md': '# Background\n\nText.\n' });
  const layer = byId(await loadPyramid(dir)).L1;
  assert.equal(layer.docs.length, 2);
  assert.deepEqual(layer.bricks.map((b) => b.path), ['L1-vision.md', 'L1-vision/background.md']);
});

test('the ids stay L<n> because the folder is not counted as a second layer', async () => {
  const dir = await makeDocs({ 'L3-modules.md': '# M\n\n## A\n', 'L3-modules/': '' , 'L3-modules/x.md': '# X\n' });
  assert.deepEqual((await discoverLayers(dir)).map((l) => l.id), ['L3']);
});

test('a different stem is not merged: L3-modules.md and L3-parts/ stay two layers as before', async () => {
  const dir = await makeDocs({ 'L3-modules.md': '# M\n\n## A\n', 'L3-parts/x.md': '# X\n' });
  assert.deepEqual((await discoverLayers(dir)).map((l) => l.id), ['L3-modules', 'L3-parts']);
});

test('legacy layout: a layer folder with its own index.md and no layer file keeps the index-first rule', async () => {
  const layers = await discoverLayers(fixture('pyramid'));
  assert.deepEqual(layers.map((l) => l.bricks), ['file', 'headings', 'index', 'index', 'file']);
  assert.equal(layers[2].layerFile, undefined);
  const model = await loadPyramid(fixture('pyramid'));
  assert.deepEqual(model.folderIndexes, []);
});

test('a folder with only files (no index.md, no layer file) keeps the headings fallback', async () => {
  const dir = await makeDocs({ 'L3-modules/a.md': '# A\n\n## One\n\n## Two\n', 'L3-modules/b.md': '# B\n' });
  const layer = byId(await loadPyramid(dir)).L3;
  assert.equal(layer.bricks.length, 3);
  assert.deepEqual(labels(layer), ['One', 'Two', 'B']);
});

// ---- bricks ----------------------------------------------------------------------------------------

test('modules bricks: one per ## section of the layer file in document order, then one per broken-out file', async () => {
  const l3 = byId(await loadPyramid(root)).L3;
  assert.deepEqual(l3.bricks.map((b) => [b.label, b.path, b.slug]), [
    ['Tide reader', 'L3-modules.md', 'tide-reader'],
    ['Light keeper', 'L3-modules.md', 'light-keeper'],
    ['Publisher', 'L3-modules.md', 'publisher'],
    ['Harbor routes', 'L3-modules.md', 'harbor-routes'],
    ['Harbor routes', 'L3-modules/harbor-routes.md', null],
    ['Tide tables', 'L3-modules/tide-tables.md', null],
    ['Zeta Notes', 'L3-modules/zeta-notes.md', null]
  ]);
});

test('a broken-out file adds no bricks for its own ## headings; its brick is its first # heading, else the file name title', async () => {
  const l3 = byId(await loadPyramid(root)).L3;
  const own = l3.bricks.filter((b) => b.path !== 'L3-modules.md');
  assert.equal(own.length, 3);
  for (const heading of ['Legs', 'Delays', 'Sources', 'Scratch']) assert.ok(!labels(l3).includes(heading), heading);
  assert.equal(own[0].label, 'Harbor routes');
  assert.equal(own[2].label, 'Zeta Notes');
});

test('L2 with an empty folder gives the ## sections of the layer file only, as before', async () => {
  const l2 = byId(await loadPyramid(root)).L2;
  assert.deepEqual(labels(l2), ['Pieces', 'Data flow', 'Limits']);
});

test('a folder index.md is a broken-out document with its own brick', async () => {
  const l4 = byId(await loadPyramid(root)).L4;
  assert.deepEqual(labels(l4), ['Setup', 'Tests', 'Operations index', 'Release checklist']);
  assert.equal(l4.bricks[2].slug, null);
});

test('buildBricks in modules mode works on plain objects; a layer without a layer file lists only broken-out files', () => {
  const docs = [
    { path: 'a.md', title: 'A', headings: [{ level: 1, text: 'Layer', slug: 'layer' }, { level: 2, text: 'Sec', slug: 'sec' }] },
    { path: 'a/x.md', title: 'X', headings: [{ level: 2, text: 'Inner', slug: 'inner' }, { level: 1, text: '  ', slug: 'blank' }, { level: 1, text: 'Real', slug: 'real' }] },
    { path: 'a/y.md', title: 'Y title', headings: [], tooLarge: true }
  ];
  assert.deepEqual(buildBricks({ id: 'L3', bricks: 'modules', layerFile: 'a.md' }, docs).map((b) => b.label), ['Sec', 'Inner', 'Y title']);
  assert.deepEqual(buildBricks({ id: 'L3', bricks: 'modules', layerFile: null }, docs).map((b) => b.label), ['Layer', 'Inner', 'Y title']);
});

test('the layer file without any ## section is one brick labelled with its title', async () => {
  const dir = await makeDocs({ 'L3-modules.md': '# Modules\n\nOnly text.\n', 'L3-modules/x.md': '# X\n' });
  const layer = byId(await loadPyramid(dir)).L3;
  assert.deepEqual(layer.bricks.map((b) => [b.label, b.path]), [['L3 Modules', 'L3-modules.md'], ['X', 'L3-modules/x.md']]);
});

test('file names are ordered by bytes: uppercase before lowercase', async () => {
  const dir = await makeDocs({ 'L3-modules.md': '# M\n', 'L3-modules/b.md': '# B\n', 'L3-modules/Z.md': '# Z\n', 'L3-modules/a.md': '# A\n' });
  assert.deepEqual(byId(await loadPyramid(dir)).L3.files.map((f) => f.name), ['L3-modules.md', 'Z.md', 'a.md', 'b.md']);
});

test('a folder whose name differs only in case still merges with the layer file into one layer', async () => {
  for (const folder of ['L3-Modules', 'l3-modules']) {
    const dir = await makeDocs({ 'L3-modules.md': '# M\n\n## A\n', [`${folder}/one.md`]: '# One\n' });
    const layers = await discoverLayers(dir);
    assert.deepEqual(layers.map((l) => l.id), ['L3'], folder);
    assert.deepEqual(layers[0].files.map((f) => f.path), ['L3-modules.md', `${folder}/one.md`], folder);
  }
});

test('a broken-out file has the same name in the tree and the pages as on its brick: its module title', async () => {
  const dir = await makeDocs({
    'L3-modules.md': '# M\n\n## A\n',
    'L3-modules/m001.md': '## Module 001\n\nBy.\n',
    'L3-modules/legacy.md': '# Legacy form\n', // a "# Title" file exercises the legacy path
    'L3-modules/plain.md': 'No heading.\n',
    'L3-modules/index.md': '# Idx\n'
  });
  const layer = byId(await loadPyramid(dir)).L3;
  assert.deepEqual(layer.docs.map((d) => d.title), ['L3 Modules', 'Idx', 'Legacy form', 'Module 001', 'Plain']);
});

test('a folder index that a later layer lists first is not reported as next to a layer file', async () => {
  const dir = await makeDocs({
    'L3-modules.md': '# M\n\n## A\n',
    'L3-modules/index.md': '# I\n\n## I1\n',
    'L3-modules/one.md': '# One\n',
    'pyramid.json': JSON.stringify({ layers: [{ id: 'B', path: 'L3-modules', kind: 'folder' }, { id: 'A', path: 'L3-modules.md', kind: 'file', bricks: 'modules' }] })
  });
  const model = await loadPyramid(dir);
  assert.deepEqual(model.folderIndexes, []);
});

test('the overview marks bricks that open a broken-out file, and only those', async () => {
  const pyramid = await loadPyramid(root);
  const html = renderOverviewPage({ pyramid, links });
  const l3 = byId(pyramid).L3;
  const sections = l3.bricks.filter((b) => b.path === l3.layerFile).length;
  const files = l3.bricks.length - sections;
  assert.ok(sections > 0 && files > 0);
  assert.equal(html.split('class="brick brick-doc"').length - 1, files + byId(pyramid).L4.bricks.filter((b) => b.path !== byId(pyramid).L4.layerFile).length);
});

// ---- not on the pyramid ----------------------------------------------------------------------------

test('in the new layout no document is off the pyramid', async () => {
  const model = await loadPyramid(root);
  assert.equal(model.offPyramid, 0);
  assert.deepEqual(model.offPyramidUnlinked, []);
  assert.equal(model.all.flatMap((l) => l.docs).length, 11);
});

// ---- pyramid.json ----------------------------------------------------------------------------------

test('"modules" is a valid bricks value and is documented in the list of modes', () => {
  assert.ok(BRICK_MODES.includes('modules'));
  assert.doesNotThrow(() => parseLayerConfig([{ id: 'L3', path: 'L3-modules.md', kind: 'file', bricks: 'modules' }]));
  assert.throws(() => parseLayerConfig([{ id: 'L3', path: 'x', kind: 'folder', bricks: 'nope' }]), (e) => e instanceof LayerConfigError && /must be one of: index, headings, file, modules/.test(e.message));
});

test('pyramid.json with the layer file and the folder as two layers keeps working as written', async () => {
  const layers = [
    { id: 'L3', label: 'Modules', path: 'L3-modules.md', kind: 'file' },
    { id: 'L3b', label: 'Broken out', path: 'L3-modules', kind: 'folder' }
  ];
  const model = await loadPyramid(root, { layers });
  const by = byId(model);
  assert.deepEqual(model.all.map((l) => l.id), ['L3', 'L3b']);
  assert.equal(by.L3.docs.length, 1);
  assert.deepEqual(labels(by.L3), ['Tide reader', 'Light keeper', 'Publisher', 'Harbor routes']);
  assert.deepEqual(by.L3b.docs.map((d) => d.path), ['L3-modules/harbor-routes.md', 'L3-modules/tide-tables.md', 'L3-modules/zeta-notes.md']);
  assert.deepEqual(labels(by.L3b), ['Harbor routes', 'Tide tables', 'Zeta Notes']); // "headings" mode: each file's ## heading is a brick
});

test('pyramid.json read from the docs folder wins over detection', async () => {
  const copy = await tempFixture('newlayout');
  try {
    await writeFile(join(copy.root, 'pyramid.json'), JSON.stringify({ layers: [{ id: 'L3', path: 'L3-modules.md', kind: 'file' }] }));
    const model = await loadPyramid(copy.root);
    assert.deepEqual(model.all.map((l) => [l.id, l.docs.length]), [['L3', 1]]);
  } finally {
    await copy.cleanup();
  }
});

test('pyramid.json can ask for "modules" on a file layer: the folder with the same stem joins it', async () => {
  const model = await loadPyramid(root, { layers: [{ id: 'L3', label: 'Mods', path: 'L3-modules.md', kind: 'file', bricks: 'modules' }] });
  assert.equal(model.all.length, 1);
  assert.equal(model.all[0].label, 'Mods');
  assert.equal(model.all[0].bricks.length, 7);
  assert.deepEqual(model.all[0].docs.map((d) => d.path), ['L3-modules.md', 'L3-modules/harbor-routes.md', 'L3-modules/tide-tables.md', 'L3-modules/zeta-notes.md']);
});

test('pyramid.json can ask for "modules" on a folder layer: a layer file with the same stem is the layer file', async () => {
  const model = await loadPyramid(root, { layers: [{ id: 'L4', path: 'L4-operations', kind: 'folder', bricks: 'modules' }] });
  assert.equal(model.all[0].layerFile, 'L4-operations.md');
  assert.deepEqual(labels(model.all[0]), ['Setup', 'Tests', 'Operations index', 'Release checklist']);
});

test('"modules" on a folder with no layer file gives one brick per file', async () => {
  const dir = await makeDocs({ 'parts/a.md': '# Alpha\n\n## In\n', 'parts/b.md': '# Beta\n' });
  const model = await loadPyramid(dir, { layers: [{ id: 'P', path: 'parts', kind: 'folder', bricks: 'modules' }] });
  assert.equal(model.all[0].layerFile, null);
  assert.deepEqual(labels(model.all[0]), ['Alpha', 'Beta']);
});

// ---- overview and tree markup ----------------------------------------------------------------------

test('the overview shows each layer once: one "L3 Modules" group with its 7 bricks, and the folder index note', async () => {
  const pyramid = await loadPyramid(root);
  const html = renderOverviewPage({ pyramid, links, views: ['pyramid', 'tree'] });
  for (const label of ['L1 Vision', 'L2 Architecture', 'L3 Modules', 'L4 Operations']) {
    assert.equal(html.split(`>${label}</h3>`).length - 1, 1, label);
  }
  assert.equal((html.match(/data-layer="L3"/g) || []).length, 1);
  const l3 = html.slice(html.indexOf('data-layer="L3"'), html.indexOf('data-layer="L4"'));
  assert.equal((l3.match(/<li class="brick(?: brick-doc)?">/g) || []).length, 7);
  assert.match(l3, /data-pv-doc="L3-modules\.md" data-pv-heading="tide-reader"/);
  assert.match(l3, /<a href="L3-modules\/harbor-routes\.html" data-pv-doc="L3-modules\/harbor-routes\.md">Harbor routes<\/a>/);
  assert.ok(!/data-pv-heading="legs"/.test(l3));
  assert.ok(!/documents? (is|are) not on the pyramid/.test(html));
  assert.match(html, /<p class="pyramid-note">L4-operations\/index\.md is a folder index next to a layer file; merge it into the layer file by hand\.<\/p>/);
});

test('the tree view has one group per layer: the layer file with its sections first, then the broken-out files with their sections', async () => {
  const pyramid = await loadPyramid(root);
  const html = renderOverviewPage({ pyramid, links, view: 'tree', views: ['pyramid', 'tree'] });
  assert.equal(html.split('<p class="layer-label"><a href="L3-modules.html"').length - 1, 1);
  const l3 = html.slice(html.indexOf('<p class="layer-label"><a href="L3-modules.html"'), html.indexOf('<p class="layer-label"><a href="L4-operations.html"'));
  const order = [...l3.matchAll(/<li class="tree-file"><a href="([^"]+)"/g)].map((m) => m[1]);
  // the layer file is the layer heading itself (a link), so the files below it are the broken-out ones
  assert.deepEqual(order, ['L3-modules/harbor-routes.html', 'L3-modules/tide-tables.html', 'L3-modules/zeta-notes.html']);
  assert.match(l3, />Tide reader<\/a>/);
  // The ## title of a broken-out file is the file entry itself; its ### sections are the entries below it.
  assert.match(l3, /<a href="L3-modules\/harbor-routes\.html">Harbor routes<\/a>\n<ul class="tree-headings">\n<li><a href="L3-modules\/harbor-routes\.html#legs">Legs<\/a>/);
  assert.match(l3, /<a href="L3-modules\/tide-tables\.html#sources"[^>]*>Sources<\/a>/);
  assert.ok(l3.indexOf('>Publisher<') < l3.indexOf('>Legs<'));
});

test('a document page of a broken-out file opens in the tree with the same single group', async () => {
  const pyramid = await loadPyramid(root);
  const html = renderDocumentPage({ pyramid, path: 'L3-modules/harbor-routes.md', source: await readFile(join(root, 'L3-modules', 'harbor-routes.md'), 'utf8'), view: 'tree', links });
  assert.equal(html.split('<p class="layer-label"><a href="L3-modules.html"').length - 1, 1);
  assert.match(html, /aria-current="page">Harbor routes<\/a>/);
});

// ---- exports ---------------------------------------------------------------------------------------

test('HTML export, both views: every document has a page in both views, one group per layer, links resolve', async () => {
  const out = join(base, 'export-both');
  const lines = { info: [], warn: [] };
  await exportHtml({ root, out, view: 'both', skin: 'plain', log: { info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) } });
  const walked = await walkExport(out);
  assert.deepEqual(walked.problems, []);
  for (const page of ['L1-vision', 'L2-architecture', 'L3-modules', 'L3-modules/harbor-routes', 'L3-modules/tide-tables', 'L3-modules/zeta-notes', 'L4-operations', 'L4-operations/index', 'L4-operations/release-checklist', 'adr/0001-print-on-paper']) {
    assert.ok(walked.pages.includes(`${page}.html`), page);
    assert.ok(walked.pages.includes(`_tree/${page}.html`), `_tree/${page}`);
  }
  const overview = await readFile(join(out, 'index.html'), 'utf8');
  assert.equal(overview.split('>L3 Modules</h3>').length - 1, 1);
  const tree = await readFile(join(out, '_tree', 'index.html'), 'utf8');
  assert.equal(tree.split('<p class="layer-label"><a href="L3-modules.html"').length - 1, 1);
  assert.ok(lines.info.some((l) => l === 'L4-operations/index.md is a folder index next to a layer file; merge it into the layer file by hand'));
  assert.ok(!lines.info.some((l) => /not on the pyramid/.test(l)));
  assert.match(lines.info[0], /^Exported 11 documents/);
});

test('Markdown export: the layer file first, then the folder files by name, for every layer', async () => {
  const file = join(base, 'all.md');
  const lines = { info: [], warn: [] };
  const result = await exportMarkdown({ root, file, decisions: true, log: { info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) } });
  assert.equal(result.documents, 11);
  const text = await readFile(file, 'utf8');
  assert.deepEqual([...text.matchAll(/^<!-- source: (.+) -->$/gm)].map((m) => m[1]), [
    'L1-vision.md', 'L2-architecture.md',
    'L3-modules.md', 'L3-modules/harbor-routes.md', 'L3-modules/tide-tables.md', 'L3-modules/zeta-notes.md',
    'L4-operations.md', 'L4-operations/index.md', 'L4-operations/release-checklist.md',
    'adr/0001-print-on-paper.md', 'adr/0002-one-harbour.md'
  ]);
  assert.ok(lines.info.includes('L4-operations/index.md is a folder index next to a layer file; merge it into the layer file by hand'));
});

// ---- command line and serve ------------------------------------------------------------------------

function streams() {
  const s = { out: [], err: [] };
  s.stdout = { write: (m) => s.out.push(m) };
  s.stderr = { write: (m) => s.err.push(m) };
  return s;
}

test('the command line prints the folder index line once per command and no not-on-the-pyramid line', async () => {
  const line = 'L4-operations/index.md is a folder index next to a layer file; merge it into the layer file by hand';
  for (const argv of [['export', root, join(base, 'cli-export')], ['markdown', root, join(base, 'cli.md')]]) {
    const s = streams();
    assert.equal(await main(argv, s), 0, argv[0]);
    const text = s.out.join('') + s.err.join('');
    assert.equal(text.split(line).length - 1, 1, argv[0]);
    assert.ok(!/not on the pyramid/.test(text), argv[0]);
  }
});

test('the legacy fixture prints no folder index line', async () => {
  const s = streams();
  assert.equal(await main(['export', fixture('pyramid'), join(base, 'cli-legacy')], s), 0);
  assert.ok(!/folder index/.test(s.out.join('') + s.err.join('')));
});

test('serve: the overview shows one L3 group, a broken-out file opens as a fragment, and the start prints the line', async () => {
  const info = [];
  const running = await startServer({ root, port: 0, log: { info: (m) => info.push(m), warn() {} } });
  try {
    assert.ok(info.some((l) => /L4-operations\/index\.md is a folder index next to a layer file/.test(l)));
    const page = await (await fetch(`http://127.0.0.1:${running.port}/`)).text();
    assert.equal(page.split('>L3 Modules</h3>').length - 1, 1);
    const fragment = await fetch(`http://127.0.0.1:${running.port}/_content/L3-modules/harbor-routes.md`);
    assert.equal(fragment.status, 200);
    const text = await fragment.text();
    assert.match(text, /<h1 id="harbor-routes">Harbor routes<\/h1>/);
    assert.match(text, /<h2 id="legs">Legs<\/h2>/);
    assert.equal(text.split('<h1').length - 1, 1);
    assert.equal((await fetch(`http://127.0.0.1:${running.port}/L4-operations/index.md`)).status, 200);
  } finally {
    await running.close();
  }
});
