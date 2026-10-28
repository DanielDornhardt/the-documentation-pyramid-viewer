// Static export of the document dialog: the pyramid overview embeds every
// document as a template, the script is copied, the tree view is unchanged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { exportHtml, loadPyramid } from '../viewer.js';
import { fixture, walkExport, splitTemplates } from './helpers.js';

const quiet = { info() {}, warn() {} };
const scriptText = await readFile(new URL('../assets/pv-dialog.js', import.meta.url), 'utf8');
let base;
const outs = {};
const DOC_PATHS = [
  'L1-vision', 'L2-architecture', 'L3-modules/index', 'L3-modules/crlf', 'L3-modules/notes', 'L3-modules/storage',
  'L4-operations/index', 'L4-operations/runbook', 'adr/001-record-decisions', 'adr/002-plain-markdown', 'adr/003-use-ids'
].map((d) => `${d}.html`);

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'pv-export-dialog-'));
  for (const view of ['pyramid', 'tree', 'both']) {
    outs[view] = join(base, view);
    await exportHtml({ root: fixture('pyramid'), out: outs[view], view, log: quiet });
  }
});
after(() => rm(base, { recursive: true, force: true }));

test('the export copies the script next to the skins, byte for byte, and links it with a relative URL', async () => {
  for (const view of ['pyramid', 'both']) {
    assert.equal(await readFile(join(outs[view], 'assets/pv-dialog.js'), 'utf8'), scriptText);
    const index = await readFile(join(outs[view], 'index.html'), 'utf8');
    assert.ok(index.includes('<script defer src="assets/pv-dialog.js"></script>'));
  }
  await assert.rejects(stat(join(outs.tree, 'assets')), /ENOENT/, 'a tree-only export has no script');
});

test('index.html has the dialog once and one template for every exported document, each with its relative page URL', async () => {
  const html = await readFile(join(outs.pyramid, 'index.html'), 'utf8');
  assert.equal((html.match(/<dialog\b/g) || []).length, 1);
  assert.doesNotMatch(html, /data-content=/, 'an export fetches nothing');
  const { templates } = splitTemplates(html);
  assert.deepEqual(templates.map((t) => t.page).sort(), [...DOC_PATHS].sort());
  assert.equal((html.match(/<template\b/g) || []).length, DOC_PATHS.length);
  assert.equal((html.match(/<\/template>/g) || []).length, DOC_PATHS.length);
  for (const t of templates) await stat(join(outs.pyramid, t.page)); // the page exists
});

test('every template is the article of its own page: fragment hrefs are relative to that page, so they resolve like there', async () => {
  for (const view of ['pyramid', 'both']) {
    const index = await readFile(join(outs[view], 'index.html'), 'utf8');
    for (const t of splitTemplates(index).templates) {
      const page = await readFile(join(outs[view], t.page), 'utf8');
      assert.ok(page.includes(t.html.trim()), `${view}: ${t.page}`);
    }
  }
  // A document in a subfolder links to its sibling with a bare file name, not with a path from the overview.
  const index = await readFile(join(outs.pyramid, 'index.html'), 'utf8');
  const crlf = splitTemplates(index).templates.find((t) => t.page === 'L3-modules/crlf.html');
  assert.ok(crlf.html.includes('<a href="storage.html">link to storage</a>'));
  // A document at the top links down into a folder.
  const arch = splitTemplates(index).templates.find((t) => t.page === 'L2-architecture.html');
  assert.ok(arch.html.includes('href="L3-modules/storage.html#writing-tides"'));
});

test('the file walk resolves the links of every template against the page URL of that template', async () => {
  for (const view of ['pyramid', 'both']) {
    const walk = await walkExport(outs[view], { allowUnresolved: [/(^|\/)outside\.md$/, /(^|\/)missing\.md$/] });
    assert.deepEqual(walk.problems, []);
    assert.deepEqual(walk.absoluteResources, []);
  }
  // Without the per-template base the same links would not resolve from index.html: the walk really changes base.
  const index = await readFile(join(outs.pyramid, 'index.html'), 'utf8');
  const { templates } = splitTemplates(index);
  const unresolvedFromIndex = [];
  for (const t of templates) {
    for (const m of t.html.matchAll(/<a href="([^"#:]+\.html)(?:#[^"]*)?"/g)) {
      try {
        await stat(join(outs.pyramid, posix.normalize(m[1])));
      } catch {
        unresolvedFromIndex.push(m[1]);
      }
    }
  }
  assert.ok(unresolvedFromIndex.length > 0, 'some fragment links only resolve relative to their own page');
});

test('the tree view pages get no dialog, no template and no script', async () => {
  for (const [view, prefix] of [['tree', ''], ['both', '_tree/']]) {
    for (const file of ['index.html', ...DOC_PATHS]) {
      const html = await readFile(join(outs[view], `${prefix}${file}`), 'utf8');
      assert.doesNotMatch(html, /<dialog|<template|<script|pv-dialog|data-pv-doc/, `${view}/${prefix}${file}`);
    }
  }
});

test('document pages of the pyramid view are unchanged: no dialog, no script', async () => {
  for (const file of DOC_PATHS) {
    const html = await readFile(join(outs.pyramid, file), 'utf8');
    assert.doesNotMatch(html, /<dialog|<template|<script/, file);
  }
});

test('exported bricks keep real links and gain the data attributes', async () => {
  const html = await readFile(join(outs.pyramid, 'index.html'), 'utf8');
  assert.ok(html.includes('<a href="L3-modules/index.html#reader" data-pv-doc="L3-modules/index.md" data-pv-heading="reader">Reader</a>'));
  assert.ok(html.includes('<a href="L1-vision.html" data-pv-doc="L1-vision.md">L1 Vision</a>'));
});

test('embedding cannot break out of the template: a payload with </template> and <script> stays inert text', async () => {
  const root = join(base, 'payload-docs');
  await mkdir(join(root, 'L3-modules'), { recursive: true });
  const payload = '</template><script>alert("pwned")</script><template>';
  await writeFile(join(root, 'L1-vision.md'), `# Vision ${payload}\n\nPlain text ${payload} in a paragraph.\n\n[link ${payload}](L3-modules/a.md "${payload}")\n`);
  await writeFile(join(root, 'L3-modules', 'a.md'), `# A\n\n## Part ${payload}\n\n\`\`\`html\n${payload}\n\`\`\`\n\n<div>${payload}</div>\n\n</TEMPLATE><SCRIPT>x</SCRIPT>\n`);
  const out = join(base, 'payload-out');
  await exportHtml({ root, out, view: 'pyramid', log: quiet });
  const index = await readFile(join(out, 'index.html'), 'utf8');
  // Exactly two templates, opened and closed once each, and the only script element is the real one.
  assert.equal((index.match(/<template\b/gi) || []).length, 2, 'two opening tags');
  assert.equal((index.match(/<\/template>/gi) || []).length, 2, 'two closing tags');
  assert.deepEqual([...index.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]), ['<script defer src="assets/pv-dialog.js">']);
  assert.doesNotMatch(index, /<script>alert|<SCRIPT>x/i);
  assert.ok(index.includes('&lt;/template&gt;&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;'), 'the text is kept, escaped');
  // The template structure is intact: each template holds exactly one article.
  const { templates } = splitTemplates(index);
  assert.equal(templates.length, 2);
  for (const t of templates) assert.equal((t.html.match(/<article\b/g) || []).length, 1);
  // The brick label with the payload is escaped too.
  assert.doesNotMatch(index.replace(/<template[\s\S]*?<\/template>/g, ''), /<script>alert|<\/template><script/);
});

test('a document that somehow carries a closing template tag is neutralised by the embedding itself', async () => {
  const { renderOverviewPage } = await import('../src/pages.js');
  const pyramid = await loadPyramid(fixture('pyramid'));
  const links = { overview: () => 'index.html', doc: (v, p) => p, styles: () => ['s.css'], script: () => 'a.js' };
  const html = renderOverviewPage({ pyramid, links, embedded: [{ page: 'x.html', html: '<article>a</TEMPLATE><script>x</script>b</article>' }] });
  assert.equal((html.match(/<\/template>/gi) || []).length, 1);
  assert.match(html, /&lt;\/TEMPLATE>/);
});
