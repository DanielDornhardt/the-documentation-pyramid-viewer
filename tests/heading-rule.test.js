// The heading rule: heading levels are the same in the layer file and in a
// broken-out file. A layer file has one H1 (the layer title), its modules are H2, their sections H3. A broken-out
// file has no H1: it starts at the module's "##" heading. The viewer names such a file by that heading, renders it
// with exactly one h1, and combines files without changing a level.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  moduleTitle, loadPyramid, renderMarkdown, extractHeadings, renderOverviewPage, renderDocumentPage, renderDocumentFragment,
  exportMarkdown, exportHtml
} from '../viewer.js';
import { fixture, splitTemplates } from './helpers.js';

const root = fixture('newlayout');
let base;
before(async () => {
  base = await mkdtemp(join(tmpdir(), 'pv-heading-rule-'));
});
after(() => rm(base, { recursive: true, force: true }));

const links = {
  overview: (view) => (view === 'tree' ? '_tree/index.html' : 'index.html'),
  doc: (view, path, fragment) => `${path.replace(/\.md$/, '.html')}${fragment ? `#${fragment}` : ''}`,
  styles: () => ['skins/pv-base.css']
};
const h = (level, text) => ({ level, text, slug: text.toLowerCase() });
const count = (html, pattern) => html.split(pattern).length - 1;

/** A docs folder written from a plain map of paths to texts. */
async function makeDocs(files) {
  const dir = await mkdtemp(join(base, 'docs-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, ...path.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...path.split('/')), text);
  }
  return dir;
}

// ---- one title function ----------------------------------------------------------------------------

test('moduleTitle: the first heading of level 1 or 2 in document order (as the refresh tool does), else the fallback', () => {
  assert.equal(moduleTitle([h(2, 'Gamma'), h(1, 'Late')], 'Fallback'), 'Gamma', 'a ## before a # wins, as in the refresh tool');
  assert.equal(moduleTitle([h(2, 'Combat'), h(3, 'Weapons')], 'Fallback'), 'Combat');
  assert.equal(moduleTitle([h(1, 'Old title'), h(2, 'Part')], 'Fallback'), 'Old title');
  assert.equal(moduleTitle([h(3, 'Only deep')], 'Fallback'), 'Fallback');
  assert.equal(moduleTitle([], 'Fallback'), 'Fallback');
  assert.equal(moduleTitle([h(2, ' '), h(2, 'Second')], 'Fallback'), 'Second', 'a heading without text is no title');
});

test('the brick label, the tree view, the page title and the Markdown table of contents all use the same title', async () => {
  const dir = await makeDocs({
    'L3-modules.md': '# Modules\n\n## Alpha\n\nIn the layer file.\n',
    'L3-modules/combat.md': '## Combat\n\nHow fights go.\n\n### Weapons\n\nSwords.\n',
    'L3-modules/old-style.md': '# Old style\n\nLegacy file.\n\n## Part\n\nx\n',
    'L3-modules/bare.md': 'Just text, no headings.\n'
  });
  const pyramid = await loadPyramid(dir);
  const layer = pyramid.layers.find((l) => l.id === 'L3');
  assert.deepEqual(layer.bricks.map((b) => b.label), ['Alpha', 'Bare', 'Combat', 'Old style']);
  assert.deepEqual(layer.docs.filter((d) => d.path.startsWith('L3-modules/')).map((d) => d.title), ['Bare', 'Combat', 'Old style']);
  const tree = renderOverviewPage({ pyramid, links, view: 'tree', views: ['pyramid', 'tree'] });
  for (const title of ['Combat', 'Old style', 'Bare']) assert.match(tree, new RegExp(`<li class="tree-file"><a href="L3-modules/[a-z-]+\\.html">${title}</a>`));
  const source = await readFile(join(dir, 'L3-modules', 'combat.md'), 'utf8');
  const page = renderDocumentPage({ pyramid, path: 'L3-modules/combat.md', source, links });
  assert.match(page, /<title>Combat - /);
  const out = join(base, 'titles.md');
  await exportMarkdown({ root: dir, file: out, toc: true, log: { info() {}, warn() {} } });
  const md = await readFile(out, 'utf8');
  assert.match(md, /^- \[Combat\]\(#l3-modules-combat\)$/m);
  assert.match(md, /^- \[Old style\]\(#l3-modules-old-style\)$/m);
  assert.match(md, /^- \[Bare\]\(#l3-modules-bare\)$/m);
});

// ---- rendering: exactly one h1 -----------------------------------------------------------------------

test('promoteTitle: a document without an h1 whose first block is a ## heading renders that heading as the h1', () => {
  const source = '## Combat\n\nHow fights go.\n\n### Weapons\n\nSwords.\n\n### Armour\n\nPlates.\n';
  const plain = renderMarkdown(source);
  assert.match(plain.html, /<h2 id="combat">Combat<\/h2>/, 'off by default: renderMarkdown alone never changes a level');
  assert.equal(plain.titlePromoted, false);
  const promoted = renderMarkdown(source, { promoteTitle: true });
  assert.equal(promoted.titlePromoted, true);
  assert.match(promoted.html, /^<h1 id="combat">Combat<\/h1>/);
  assert.match(promoted.html, /<h2 id="weapons">Weapons<\/h2>/, 'the ### sections are h2 below the h1: no level is skipped');
  assert.equal(count(promoted.html, '<h3'), 0);
  assert.deepEqual(promoted.headings, plain.headings, 'the heading list, the levels as written and the ids are the same');
  const deep = renderMarkdown('## T\n\n### A\n\n#### B\n\n##### C\n\n###### D\n', { promoteTitle: true });
  assert.deepEqual([...deep.html.matchAll(/<h(\d)[ >]/g)].map((m) => m[1]), ['1', '2', '3', '4', '5']);
  assert.deepEqual([...deep.html.matchAll(/<h\d id="([^"]+)"/g)].map((m) => m[1]), ['t', 'a', 'b'], 'ids only for levels 1 to 4, as written');
  assert.equal(count(deep.html, '<h1'), 1);
  assert.deepEqual(promoted.headings.map((x) => [x.level, x.slug]), [[2, 'combat'], [3, 'weapons'], [3, 'armour']]);
});

test('promoteTitle: front matter and leading HTML comments may come first; text, an h1 or a ### heading first prevents it', () => {
  assert.equal(renderMarkdown('---\nsummary: x\n---\n## Combat\n\ntext\n', { promoteTitle: true }).titlePromoted, true);
  assert.equal(renderMarkdown('<!-- note -->\n\n## Combat\n\ntext\n', { promoteTitle: true }).titlePromoted, true);
  assert.equal(renderMarkdown('Intro.\n\n## Combat\n', { promoteTitle: true }).titlePromoted, false);
  assert.equal(renderMarkdown('## Combat\n\n# Later h1\n', { promoteTitle: true }).titlePromoted, false);
  assert.equal(renderMarkdown('# Title\n\n## Part\n', { promoteTitle: true }).titlePromoted, false);
  assert.equal(renderMarkdown('### Deep first\n\n## Later\n', { promoteTitle: true }).titlePromoted, false);
  assert.equal(renderMarkdown('```md\n# in code\n```\n\n## Combat\n', { promoteTitle: true }).titlePromoted, false);
  const crlf = renderMarkdown('## Combat\r\n\r\ntext\r\n', { promoteTitle: true });
  assert.equal(crlf.titlePromoted, true);
});

async function pagesOfFixture() {
  const pyramid = await loadPyramid(root);
  const source = await readFile(join(root, 'L3-modules', 'harbor-routes.md'), 'utf8');
  return { pyramid, source };
}

test('the page of a broken-out file has one h1, the module title once, unchanged ids, and the page index lists ## and ###', async () => {
  const { pyramid, source } = await pagesOfFixture();
  for (const view of ['pyramid', 'tree']) {
    const html = renderDocumentPage({ pyramid, path: 'L3-modules/harbor-routes.md', source, view, links });
    const { main } = splitTemplates(html);
    assert.equal(count(main, '<h1'), 1, view);
    assert.match(main, /<h1 id="harbor-routes">Harbor routes<\/h1>/);
    assert.equal(count(main, '<h3'), 0);
    assert.deepEqual([...main.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1])), [1, 2, 2], 'h1, then h2 for the sections: no skipped level');
    assert.match(main, /<h2 id="legs">Legs<\/h2>/);
    assert.match(main, /<title>Harbor routes - /);
    assert.equal(count(main.slice(main.indexOf('<main')), '>Harbor routes</h'), 1, 'the title is shown once in the article');
  }
  const pyramidPage = renderDocumentPage({ pyramid, path: 'L3-modules/harbor-routes.md', source, view: 'pyramid', links });
  const toc = pyramidPage.slice(pyramidPage.indexOf('<nav class="page-toc"'), pyramidPage.indexOf('</nav>', pyramidPage.indexOf('<nav class="page-toc"')));
  assert.deepEqual([...toc.matchAll(/<li class="toc-level-(\d)"><a href="#([^"]+)">([^<]+)</g)].map((m) => [m[1], m[2], m[3]]), [
    ['2', 'harbor-routes', 'Harbor routes'], ['3', 'legs', 'Legs'], ['3', 'delays', 'Delays']
  ]);
});

test('the tree view shows the module title once, as the file entry; its ### sections are the entries below it', async () => {
  const { pyramid, source } = await pagesOfFixture();
  const tree = renderDocumentPage({ pyramid, path: 'L3-modules/harbor-routes.md', source, view: 'tree', links, at: 'legs' });
  const entry = tree.slice(tree.indexOf('<li class="tree-file"><a href="L3-modules/harbor-routes.html"'));
  const item = entry.slice(0, entry.indexOf('</li>\n<li class="tree-file">'));
  assert.deepEqual([...item.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]), [
    ['L3-modules/harbor-routes.html', 'Harbor routes'],
    ['L3-modules/harbor-routes.html#legs', 'Legs'],
    ['L3-modules/harbor-routes.html#delays', 'Delays']
  ]);
  assert.match(item, /<a href="L3-modules\/harbor-routes\.html#legs"[^>]* aria-current="location">Legs<\/a>/);
  const overview = renderOverviewPage({ pyramid, links, view: 'tree', views: ['pyramid', 'tree'] });
  assert.equal(count(overview, '>Harbor routes</a>'), 2, 'the section of the layer file and the file entry, nothing more');
  // a layer file keeps its ## entries and, when open, their ### entries
  const layer = renderDocumentPage({ pyramid, path: 'L3-modules.md', source: await readFile(join(root, 'L3-modules.md'), 'utf8'), view: 'tree', links });
  assert.match(layer, /<a href="L3-modules\.html#tide-reader">Tide reader<\/a>/);
});

test('the dialog fragment of a broken-out file has one h1 without the id of the page title, and the same index', async () => {
  const { pyramid, source } = await pagesOfFixture();
  const fragment = renderDocumentFragment({ pyramid, path: 'L3-modules/harbor-routes.md', source, links });
  assert.equal(count(fragment, '<h1'), 1);
  assert.doesNotMatch(fragment, /pv-title/);
  assert.match(fragment, /<h1 id="harbor-routes">Harbor routes<\/h1>/);
  assert.equal(count(fragment, '>Harbor routes</h'), 1);
  assert.match(fragment, /<li class="toc-level-2"><a href="#harbor-routes">Harbor routes<\/a>/);
  assert.match(fragment, /<li class="toc-level-3"><a href="#legs">Legs<\/a>/);
});

test('a document with text before its first ## heading keeps the generated h1; a legacy # file keeps its own', async () => {
  const dir = await makeDocs({
    'L3-modules.md': '# Modules\n\n## Alpha\n\nx\n',
    'L3-modules/intro.md': 'Some words first.\n\n## Part\n\ntext\n',
    'L3-modules/legacy.md': '# Legacy title\n\nByline.\n\n## Part\n\ntext\n'
  });
  const pyramid = await loadPyramid(dir);
  for (const name of ['intro', 'legacy']) {
    const source = await readFile(join(dir, 'L3-modules', `${name}.md`), 'utf8');
    const { main } = splitTemplates(renderDocumentPage({ pyramid, path: `L3-modules/${name}.md`, source, links }));
    assert.equal(count(main, '<h1'), 1, name);
  }
  const intro = splitTemplates(renderDocumentPage({ pyramid, path: 'L3-modules/intro.md', source: 'Some words first.\n\n## Part\n\ntext\n', links })).main;
  assert.match(intro, /<h1 id="pv-title">Part<\/h1>/, 'the generated h1 carries the module title (the first ## heading)');
  const legacy = splitTemplates(renderDocumentPage({ pyramid, path: 'L3-modules/legacy.md', source: '# Legacy title\n\nByline.\n\n## Part\n\ntext\n', links })).main;
  assert.match(legacy, /<h1 id="legacy-title">Legacy title<\/h1>/);
  assert.match(legacy, /<h2 id="part">Part<\/h2>/);
});

test('every page of the static export has exactly one h1 outside its templates, in both views', async () => {
  const out = join(base, 'export-h1');
  await exportHtml({ root, out, view: 'both', skin: 'plain', log: { info() {}, warn() {} } });
  for (const page of ['L3-modules/harbor-routes', 'L3-modules/tide-tables', 'L3-modules/zeta-notes', 'L4-operations/release-checklist', 'L3-modules', 'L1-vision']) {
    for (const prefix of ['', '_tree/']) {
      const html = await readFile(join(out, `${prefix}${page}.html`), 'utf8');
      assert.equal(count(splitTemplates(html).main, '<h1'), 1, `${prefix}${page}`);
    }
  }
});

// ---- the Markdown export ---------------------------------------------------------------------------

test('the Markdown export of the fixture has one outline: layer H1, modules at ##, their sections at ###, nothing repeated', async () => {
  const out = join(base, 'fixture.md');
  await exportMarkdown({ root, file: out, toc: true, log: { info() {}, warn() {} } });
  const md = await readFile(out, 'utf8');
  const lines = md.split('\n');
  const parts = md.split('\n\n---\n\n');
  const part = (path) => parts.find((p) => p.includes(`<!-- source: ${path} -->`));
  // the layer file keeps its H1 and its ## modules; the broken-out files add no H1 and keep ## and ###
  const outline = (text) => text.split('\n').filter((l) => /^#{1,6} /.test(l));
  assert.deepEqual(outline(part('L3-modules.md')), ['# Modules', '## Tide reader', '## Light keeper', '## Publisher', '## Harbor routes']);
  assert.deepEqual(outline(part('L3-modules/harbor-routes.md')), ['## Harbor routes', '### Legs', '### Delays']);
  assert.deepEqual(outline(part('L3-modules/tide-tables.md')), ['## Tide tables', '### Sources']);
  assert.deepEqual(outline(part('L4-operations/release-checklist.md')), ['## Release checklist', '### Before', '### After']);
  assert.equal(lines.filter((l) => l === '# Modules').length, 1, 'the layer title is not repeated for the broken-out files');
  // anchors: every heading has one, prefixed with the document path, and the table of contents points at them
  assert.match(md, /<a id="l3-modules-harbor-routes--harbor-routes"><\/a>\n\n## Harbor routes/);
  assert.match(md, /<a id="l3-modules-harbor-routes--legs"><\/a>\n\n### Legs/);
  assert.match(md, /<a id="l3-modules--harbor-routes"><\/a>\n\n## Harbor routes/, 'the layer file section keeps its own anchor');
  const tocEnd = md.indexOf('\n\n---\n\n');
  const toc = md.slice(0, tocEnd);
  assert.match(toc, /^- \[Harbor routes\]\(#l3-modules-harbor-routes\)$/m);
  assert.doesNotMatch(toc, /l3-modules-harbor-routes--harbor-routes/, 'the module title is the file entry: it is not listed a second time');
  assert.match(toc, /^ {2}- \[Legs\]\(#l3-modules-harbor-routes--legs\)$/m);
  assert.match(toc, /^ {2}- \[Delays\]\(#l3-modules-harbor-routes--delays\)$/m);
  assert.match(toc, /^ {2}- \[Tide reader\]\(#l3-modules--tide-reader\)$/m, 'layer file sections are listed as before');
  for (const [, id] of toc.matchAll(/\(#([^)]+)\)/g)) assert.ok(md.includes(`<a id="${id}"></a>`), `anchor ${id} exists`);
  const ids = [...md.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'anchors are unique');
});

test('the Markdown export changes no heading level when it combines the files', async () => {
  const out = join(base, 'levels.md');
  await exportMarkdown({ root, file: out, log: { info() {}, warn() {} } });
  const combined = (await readFile(out, 'utf8')).split('\n').filter((l) => /^#{1,6} /.test(l));
  const original = [];
  for (const path of ['L1-vision.md', 'L2-architecture.md', 'L3-modules.md', 'L3-modules/harbor-routes.md', 'L3-modules/tide-tables.md', 'L3-modules/zeta-notes.md', 'L4-operations.md', 'L4-operations/index.md', 'L4-operations/release-checklist.md']) {
    original.push(...extractHeadings(await readFile(join(root, path), 'utf8')).map((x) => `${'#'.repeat(x.level)} ${x.text}`));
  }
  assert.deepEqual(combined, original);
});

test('headings nested in a blockquote or a list item are no document headings (the refresh tool ignores them too)', async () => {
  const source = '## Q\n\nBy.\n\n> # quoted\n> ## quoted2\n\n- # in list\n- item\n\n    # code indent\n\n### Real\n';
  assert.deepEqual(extractHeadings(source).map((x) => x.text), ['Q', 'Real']);
  const { html, headings } = renderMarkdown(source, { promoteTitle: true });
  assert.deepEqual(headings.map((x) => x.text), ['Q', 'Real'], html);
  const dir = join(base, 'nested');
  await mkdir(join(dir, 'L3-modules'), { recursive: true });
  await writeFile(join(dir, 'L3-modules.md'), '# M\n\n## A\n\nBy a.\n');
  await writeFile(join(dir, 'L3-modules', 'quote.md'), source);
  const model = await loadPyramid(dir);
  const layer = model.layers.find((l) => l.id === 'L3');
  assert.ok(layer.docs.some((d) => d.title === 'Q'), JSON.stringify(layer.docs.map((d) => d.title)));
  const out = join(base, 'nested.md');
  await exportMarkdown({ root: dir, file: out, toc: true, log: { info() {}, warn() {} } });
  const md = await readFile(out, 'utf8');
  assert.ok(!/> # quoted <a id/.test(md) && !/- # in list <a id/.test(md) && !/ {4}# code indent <a id/.test(md), md);
});
