// AC 7 (link policy in exports), AC 8 (static HTML export) and AC 1 (no layers).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportHtml, exportFileName, EXPORT_VIEWS } from '../viewer.js';
import { fixture, listFiles, walkExport } from './helpers.js';

const quiet = { info() {}, warn() {} };
let base;
const outs = {};

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'pv-export-'));
  for (const view of EXPORT_VIEWS) {
    outs[view] = join(base, view);
    outs[`${view}-result`] = await exportHtml({ root: fixture('pyramid'), out: outs[view], view, skin: 'plain', log: quiet });
  }
});
after(() => rm(base, { recursive: true, force: true }));

const DOCS = [
  'L1-vision', 'L2-architecture', 'L3-modules/index', 'L3-modules/crlf', 'L3-modules/notes', 'L3-modules/storage',
  'L4-operations/index', 'L4-operations/runbook', 'adr/001-record-decisions', 'adr/002-plain-markdown', 'adr/003-use-ids'
];

test('views are pyramid, tree and both', () => {
  assert.deepEqual([...EXPORT_VIEWS], ['pyramid', 'tree', 'both']);
});

test('--view pyramid writes the overview, one page per document and the skin css, and no tree', async () => {
  const files = await listFiles(outs.pyramid);
  assert.deepEqual(files, ['index.html', ...DOCS.map((d) => `${d}.html`), 'assets/pv-dialog.js', 'skins/light.css', 'skins/metal.css', 'skins/pv-base.css'].sort());
  for (const file of files.filter((f) => f.endsWith('.html'))) {
    const html = await readFile(join(outs.pyramid, file), 'utf8');
    assert.ok(!html.includes('class="tree"'), `${file} has no tree index`);
  }
  assert.match(await readFile(join(outs.pyramid, 'index.html'), 'utf8'), /class="pyramid"/);
});

test('--view tree writes pages with the tree index and builds no pyramid picture', async () => {
  const files = await listFiles(outs.tree);
  assert.deepEqual(files, ['index.html', ...DOCS.map((d) => `${d}.html`), 'skins/light.css', 'skins/metal.css', 'skins/pv-base.css'].sort());
  for (const file of files.filter((f) => f.endsWith('.html'))) {
    const html = await readFile(join(outs.tree, file), 'utf8');
    assert.match(html, /<nav class="tree"/, `${file} has the tree index`);
    assert.ok(!html.includes('class="pyramid"') && !html.includes('class="brick"'), `${file} has no pyramid picture`);
  }
});

test('--view both writes both views side by side, linked to each other', async () => {
  const files = await listFiles(outs.both);
  const expected = ['index.html', '_tree/index.html', ...DOCS.flatMap((d) => [`${d}.html`, `_tree/${d}.html`]), 'assets/pv-dialog.js', 'skins/light.css', 'skins/metal.css', 'skins/pv-base.css'];
  assert.deepEqual(files, expected.sort());
  const pyramidPage = await readFile(join(outs.both, 'L3-modules/storage.html'), 'utf8');
  assert.match(pyramidPage, /class="view-switch" href="\.\.\/_tree\/L3-modules\/storage\.html"/);
  const treePage = await readFile(join(outs.both, '_tree/L3-modules/storage.html'), 'utf8');
  // the switch from a tree page goes to the pyramid picture, not to the same document in a page without an index
  assert.match(treePage, /class="view-switch" href="\.\.\/\.\.\/index\.html"/);
  assert.match(treePage, /<nav class="tree"/);
  const overview = await readFile(join(outs.both, 'index.html'), 'utf8');
  assert.match(overview, /class="view-switch" href="_tree\/index\.html"/);
});

for (const view of EXPORT_VIEWS) {
  test(`--view ${view}: every href and src resolves to a file in the output (file:// walk)`, async () => {
    const walk = await walkExport(outs[view], { allowUnresolved: [/(^|\/)outside\.md$/, /(^|\/)missing\.md$/] });
    assert.ok(walk.checked > 50, `walked ${walk.checked} links`);
    assert.deepEqual(walk.problems, []);
    assert.deepEqual(walk.absoluteResources, [], 'no absolute or third-party resource URLs');
  });

  test(`--view ${view}: stylesheet links are relative to the page depth and no page uses a server-absolute URL`, async () => {
    for (const file of (await listFiles(outs[view])).filter((f) => f.endsWith('.html'))) {
      const html = await readFile(join(outs[view], file), 'utf8');
      const depth = file.split('/').length - 1;
      const up = '../'.repeat(depth);
      assert.ok(html.includes(`<link rel="stylesheet" href="${up}skins/pv-base.css">\n<link rel="stylesheet" href="${up}skins/light.css">\n`), `${file} css links, base first, then the theme`);
      assert.match(html, /<body class="view-[a-z]+" data-skin="light">/, `${file} data-skin (plain is the alias of light)`);
      assert.ok(!/(?:href|src)="\//.test(html), `${file} has no root-relative URL`);
      // No inline script anywhere; an external script only on the pyramid overview (index.html at the top of a pyramid output).
      const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
      assert.ok(scripts.every((tag) => /\ssrc="[^"]+"/.test(tag)), `${file} has no inline script`);
      const isPyramidOverview = view !== 'tree' && file === 'index.html';
      assert.deepEqual(scripts, isPyramidOverview ? ['<script defer src="assets/pv-dialog.js">'] : [], `${file} script tags`);
    }
  });

  test(`--view ${view}: every heading of level 1 to 4 has an id`, async () => {
    for (const file of (await listFiles(outs[view])).filter((f) => f.endsWith('.html'))) {
      const html = await readFile(join(outs[view], file), 'utf8');
      for (const tag of html.matchAll(/<h[1-4]\b[^>]*>/g)) assert.match(tag[0], /\sid="[^"]+"/, `${file}: ${tag[0]}`);
    }
  });
}

test('the export copies the base stylesheet and both themes byte for byte', async () => {
  for (const name of ['pv-base.css', 'light.css', 'metal.css']) {
    const original = await readFile(new URL(`../skins/${name}`, import.meta.url), 'utf8');
    assert.equal(await readFile(join(outs.both, 'skins', name), 'utf8'), original, name);
  }
});

test('skin plain is an alias of light: the export equals the light export file for file', async () => {
  const light = join(base, 'alias-light');
  await exportHtml({ root: fixture('pyramid'), out: light, view: 'both', skin: 'light', log: quiet });
  const files = await listFiles(light);
  assert.deepEqual(files, await listFiles(outs.both));
  for (const file of files) assert.equal(await readFile(join(light, file), 'utf8'), await readFile(join(outs.both, file), 'utf8'), file);
});

test('--tokens: the file is copied to skins/custom.css and linked last on every page', async () => {
  const tokens = join(base, 'my-tokens.css');
  await writeFile(tokens, '\ufeff:root { --pv-bg: #fdf6e3; }\n');
  const out = join(base, 'with-tokens');
  const result = await exportHtml({ root: fixture('pyramid'), out, view: 'both', skin: 'metal', tokensFile: tokens, log: quiet });
  assert.ok(result.files.includes('skins/custom.css'));
  assert.equal(await readFile(join(out, 'skins/custom.css'), 'utf8'), ':root { --pv-bg: #fdf6e3; }\n');
  for (const file of (await listFiles(out)).filter((f) => f.endsWith('.html'))) {
    const html = await readFile(join(out, file), 'utf8');
    const up = '../'.repeat(file.split('/').length - 1);
    assert.ok(html.includes(`<link rel="stylesheet" href="${up}skins/pv-base.css">\n<link rel="stylesheet" href="${up}skins/metal.css">\n<link rel="stylesheet" href="${up}skins/custom.css">\n`), file);
  }
});

test('links are rewritten to the exported pages and the link report counts every kind', async () => {
  const page = await readFile(join(outs.pyramid, 'L2-architecture.html'), 'utf8');
  assert.ok(page.includes('href="L3-modules/storage.html"'));
  assert.ok(page.includes('href="L3-modules/index.html"'), 'a folder link goes to the index file');
  assert.ok(page.includes('href="L3-modules/storage.html#writing-tides"'));
  assert.ok(page.includes('href="L4-operations/index.html"'));
  assert.ok(page.includes('href="../outside.md"'), 'outside the root stays as written');
  assert.ok(page.includes('href="L3-modules/missing.md"'), 'a missing page stays as written');
  assert.ok(page.includes('href="https://example.org/tides"') && page.includes('href="mailto:team@example.org"'));
  assert.ok(page.includes('href="#overview"'));
  for (const name of ['pyramid-result', 'tree-result', 'both-result']) {
    const { report } = outs[name];
    assert.deepEqual(report.counts, { rewritten: 6, external: 2, fragment: 1, outsideRoot: 1, notExported: 1, missingFragment: 0 }, name);
    assert.deepEqual(report.warnings.map((w) => w.reason).sort(), ['not-exported', 'outside-root']);
  }
});

test('link problems are warnings, not failures: the export still finishes and prints a report', async () => {
  const lines = [];
  const out = join(base, 'report');
  const result = await exportHtml({ root: fixture('pyramid'), out, view: 'pyramid', log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) } });
  assert.equal(result.empty, false);
  const text = lines.join('\n');
  assert.match(text, /6 rewritten/);
  assert.match(text, /1 outside the docs folder/);
  assert.match(text, /1 not exported/);
  assert.match(text, /L2-architecture\.md: \.\.\/outside\.md/);
});

test('a link inside fenced code is not rewritten in the page', async () => {
  const root = join(base, 'fence-docs');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'L1-vision.md'), '# Vision\n\n```md\n[x](L2-architecture.md)\n```\n\n[real](L2-architecture.md)\n');
  await writeFile(join(root, 'L2-architecture.md'), '# Architecture\n');
  const out = join(base, 'fence-out');
  await exportHtml({ root, out, view: 'pyramid', log: quiet });
  const html = await readFile(join(out, 'L1-vision.html'), 'utf8');
  assert.ok(html.includes('[x](L2-architecture.md)'));
  assert.ok(html.includes('<a href="L2-architecture.html">real</a>'));
});

test('exported file names avoid characters that Windows does not allow', () => {
  assert.equal(exportFileName('L3-modules/storage.md'), 'L3-modules/storage.html');
  assert.equal(exportFileName('a:b?.md'), 'a_b_.html');
  assert.equal(exportFileName('x<y>z"q|r*s.md'), 'x_y_z_q_r_s.html');
  assert.equal(exportFileName('CON.md'), '_CON.html');
  assert.equal(exportFileName('lpt1/aux.md'), '_lpt1/_aux.html');
  assert.equal(exportFileName('name .md'), 'name.html');
  assert.equal(exportFileName('dir./f.md'), 'dir/f.html');
  assert.equal(exportFileName('Tab\tname.md'), 'Tab_name.html');
});

test('documents with awkward names are exported and their links resolve', async () => {
  const root = join(base, 'awkward-docs');
  await mkdir(join(root, 'L3-modules'), { recursive: true });
  await writeFile(join(root, 'L1-vision.md'), '# Vision\n\nSee [odd](L3-modules/a:b%20c.md) and [self](L1-vision.md).\n');
  await writeFile(join(root, 'L3-modules', 'a:b c.md'), '# Odd\n\n## Tail end\n\nBack to [vision](../L1-vision.md#vision).\n');
  const out = join(base, 'awkward-out');
  const { report } = await exportHtml({ root, out, view: 'both', log: quiet });
  const files = await listFiles(out);
  assert.ok(files.includes('L3-modules/a_b c.html') && files.includes('_tree/L3-modules/a_b c.html'));
  for (const file of files) assert.ok(!/[<>:"|?*\\\x00-\x1f]/.test(file), file);
  const walk = await walkExport(out);
  assert.deepEqual(walk.problems, []);
  assert.equal(report.counts.notExported, 0);
});

test('two documents that would get the same output name are an error that names both', async () => {
  const root = join(base, 'clash-docs');
  await mkdir(join(root, 'L3-modules'), { recursive: true });
  await writeFile(join(root, 'L3-modules', 'a:b.md'), '# One\n');
  await writeFile(join(root, 'L3-modules', 'a_b.md'), '# Two\n');
  await assert.rejects(exportHtml({ root, out: join(base, 'clash-out'), view: 'pyramid', log: quiet }), /a:b\.md.*a_b\.md|a_b\.md.*a:b\.md/);
});

test('a document called index.md at the top level does not overwrite the overview page', async () => {
  const root = join(base, 'index-docs');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'pyramid.json'), JSON.stringify([{ id: 'top', label: 'Top', path: 'index.md', kind: 'file' }]));
  await writeFile(join(root, 'index.md'), '# Home\n\n## Part\n\ntext\n');
  const out = join(base, 'index-out');
  await exportHtml({ root, out, view: 'both', log: quiet });
  const files = await listFiles(out);
  assert.ok(files.includes('index.html') && files.includes('index-doc.html'));
  assert.deepEqual((await walkExport(out)).problems, []);
});

test('a docs folder without pyramid files says "no layers found" and writes nothing', async () => {
  const root = join(base, 'empty-docs');
  await mkdir(root, { recursive: true });
  const lines = [];
  const out = join(base, 'empty-out');
  const result = await exportHtml({ root, out, view: 'both', log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) } });
  assert.equal(result.empty, true);
  assert.match(lines.join('\n'), /no layers found/i);
  await assert.rejects(stat(out), { code: 'ENOENT' });
});

test('a missing docs folder is an error with a clear message', async () => {
  await assert.rejects(exportHtml({ root: join(base, 'nope'), out: join(base, 'x'), log: quiet }), /Docs folder not found/);
});

test('unknown view and skin values are errors that list the valid values', async () => {
  await assert.rejects(exportHtml({ root: fixture('pyramid'), out: join(base, 'x1'), view: 'grid', log: quiet }), /Unknown view "grid".*pyramid, tree, both/);
  await assert.rejects(exportHtml({ root: fixture('pyramid'), out: join(base, 'x2'), skin: 'gold', log: quiet }), /Unknown skin "gold".*light, metal \(plain is also accepted\)/);
  await assert.rejects(exportHtml({ root: fixture('pyramid'), out: join(base, 'x3'), depth: 4, log: quiet }), /Unknown depth "4".*2, 3/);
});

test('the output folder may not be the docs folder, and an existing file is not a valid output folder', async () => {
  await assert.rejects(exportHtml({ root: fixture('pyramid'), out: fixture('pyramid'), log: quiet }), /output folder/i);
  const file = join(base, 'a-file');
  await writeFile(file, 'x');
  await assert.rejects(exportHtml({ root: fixture('pyramid'), out: file, log: quiet }), /output/i);
});

test('exporting twice into the same folder works and replaces the pages', async () => {
  const out = join(base, 'twice');
  await exportHtml({ root: fixture('pyramid'), out, view: 'pyramid', log: quiet });
  await exportHtml({ root: fixture('pyramid'), out, view: 'pyramid', log: quiet });
  assert.equal((await listFiles(out)).length, DOCS.length + 5);
});

test('a custom layer list from a layers file is used by the export', async () => {
  const out = join(base, 'custom-out');
  await exportHtml({ root: fixture('custom'), out, view: 'pyramid', layersFile: fixture('custom', 'pyramid.json'), log: quiet });
  assert.ok((await listFiles(out)).includes('start.html'));
  assert.deepEqual((await walkExport(out)).problems, []);
});

// Review fixes.

async function makeDocs(files) {
  const root = await mkdtemp(join(base, 'docs-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}

test('C8: a link fragment that names no heading goes to the document start and is reported, as in the Markdown export', async () => {
  const root = await makeDocs({ 'L1-vision.md': '# One\n\n## S\n', 'L2-architecture.md': '# Two\n\n[d](L1-vision.md#nothing) [e](L1-vision.md#s)\n' });
  const out = join(base, 'c8');
  const result = await exportHtml({ root, out, view: 'pyramid', log: quiet });
  const html = await readFile(join(out, 'L2-architecture.html'), 'utf8');
  assert.ok(html.includes('href="L1-vision.html">d<'), html);
  assert.ok(html.includes('href="L1-vision.html#s">e<'));
  assert.equal(result.report.counts.missingFragment, 1);
  assert.deepEqual(result.report.warnings.map((w) => w.reason), ['fragment-not-found']);
});

test('S3: pages of the two views cannot overwrite each other (a docs folder named _tree)', async () => {
  const root = await makeDocs({ 'a.md': '# TOP\n\n## x\n', '_tree/a.md': '# TREEDOC\n\n## y\n', 'pyramid.json': JSON.stringify({ layers: [{ id: 'L1', kind: 'file', path: 'a.md' }, { id: 'L2', kind: 'folder', path: '_tree' }] }) });
  const out = join(base, 's3');
  await assert.rejects(exportHtml({ root, out, view: 'both', log: quiet }), /same file/);
  // A single view is fine: no clash.
  await exportHtml({ root, out: join(base, 's3-single'), view: 'pyramid', log: quiet });
});

test('S4: an export never writes through a symlink planted in the output folder', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const root = await makeDocs({ 'L1-vision.md': '# One\n\n## S\n' });
  const out = join(base, 's4');
  await mkdir(out, { recursive: true });
  const victim = join(base, 's4-victim.txt');
  await writeFile(victim, 'KEEP');
  try {
    await symlink(victim, join(out, 'index.html'));
  } catch {
    t.skip('symlinks are not available here');
    return;
  }
  await assert.rejects(exportHtml({ root, out, view: 'pyramid', log: quiet }), /symbolic link/);
  assert.equal(await readFile(victim, 'utf8'), 'KEEP');
});

test('C1: the static tree page of a document lists the ### headings under every ## heading, and --depth 2 hides them', async () => {
  const withThird = await readFile(join(outs.tree, 'L2-architecture.html'), 'utf8');
  assert.match(withThird, /tree-subheadings/);
  assert.match(withThird, />Ingest</);
  const out = join(base, 'c1-depth2');
  await exportHtml({ root: fixture('pyramid'), out, view: 'tree', depth: 2, log: quiet });
  assert.doesNotMatch(await readFile(join(out, 'L2-architecture.html'), 'utf8'), /tree-subheadings/);
});

test('E1: an export with no layers reports it through the warning channel and says how to fix it', async () => {
  const root = await makeDocs({ 'notes.md': '# Notes\n' });
  const lines = { info: [], warn: [] };
  const result = await exportHtml({ root, out: join(base, 'e1'), log: { info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) } });
  assert.equal(result.empty, true);
  assert.match(lines.warn.join('\n'), /pyramid\.json/);
  assert.match(lines.warn.join('\n'), /--layers/);
});
