// AC 9 (Markdown export) and the Markdown side of AC 7 (link policy).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportMarkdown, extractHeadings } from '../viewer.js';
import { fixture } from './helpers.js';
import { assertLinearGrowth, secondsSince } from './helpers.js';

const quiet = { info() {}, warn() {} };
let base;
let n = 0;
before(async () => {
  base = await mkdtemp(join(tmpdir(), 'pv-md-'));
});
after(() => rm(base, { recursive: true, force: true }));

async function run(options = {}, root = fixture('pyramid')) {
  const file = join(base, `out-${n++}.md`);
  const lines = { info: [], warn: [] };
  const result = await exportMarkdown({ root, file, log: { info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) }, ...options });
  return { ...result, file, lines, text: result.written ? await readFile(file, 'utf8') : null };
}

const sources = (text) => [...text.matchAll(/^<!-- source: (.+) -->$/gm)].map((m) => m[1]);

test('defaults: L1, L2, L3 (index first), L4 in order, no decisions and no table of contents', async () => {
  const { text, written } = await run();
  assert.equal(written, true);
  assert.deepEqual(sources(text), [
    'L1-vision.md', 'L2-architecture.md',
    'L3-modules/index.md', 'L3-modules/crlf.md', 'L3-modules/notes.md', 'L3-modules/storage.md',
    'L4-operations/index.md', 'L4-operations/runbook.md'
  ]);
  assert.ok(!text.includes('Record decisions'), 'no decision records');
  assert.ok(!/table of contents|^Contents$/im.test(text), 'no table of contents');
  assert.ok(text.startsWith('<!-- source: L1-vision.md -->'), 'the file does not start with a separator that looks like front matter');
});

test('--decisions appends the decision records after L4', async () => {
  const { text } = await run({ decisions: true });
  const list = sources(text);
  assert.deepEqual(list.slice(-3), ['adr/001-record-decisions.md', 'adr/002-plain-markdown.md', 'adr/003-use-ids.md']);
  assert.equal(list.indexOf('L4-operations/runbook.md'), list.length - 4);
});

test('--toc puts a table of contents with working anchors before the first document', async () => {
  const { text } = await run({ toc: true });
  const firstDoc = text.indexOf('<!-- source: L1-vision.md -->');
  const toc = text.slice(0, firstDoc);
  assert.match(toc, /Table of contents/);
  const anchors = new Set([...text.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]));
  const links = [...toc.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 20, `toc has ${links.length} entries`);
  for (const link of links) assert.ok(anchors.has(link), `toc link #${link} has a target`);
  assert.ok(toc.includes('[Writing tides](#l3-modules-storage--writing-tides)'));
  assert.ok(toc.includes('[Caching](#l3-modules-storage--caching)'), 'level 3 entries are listed');
  assert.ok(!/\[First CRLF section\].*\n.*\[Windows/.test(toc));
  assert.ok(text.slice(firstDoc - 10, firstDoc).includes('---'), 'a separator sits between the toc and the first document');
});

test('anchors carry a document prefix and every heading of level 1 to 4 gets one', async () => {
  const { text } = await run();
  assert.ok(text.includes('<a id="l3-modules-storage--writing-tides"></a>\n\n## Writing tides'));
  assert.ok(text.includes('<a id="l2-architecture--overview"></a>\n\n## Overview'));
  assert.ok(text.includes('<a id="l2-architecture--overview-1"></a>\n\n## Overview'), 'duplicate headings get -1 as in the HTML ids');
  assert.ok(text.includes('<a id="l3-modules-index"></a>'), 'each document has a start anchor');
  const ids = [...text.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'all anchors are unique');
});

test('anchors agree with the heading ids used by the HTML export (one shared slug function)', async () => {
  const { text } = await run();
  const source = await readFile(fixture('pyramid', 'L2-architecture.md'), 'utf8');
  for (const h of extractHeadings(source)) assert.ok(text.includes(`<a id="l2-architecture--${h.slug}"></a>`), h.slug);
});

test('headings with the same text in different documents get unique anchors and links point to the right one', async () => {
  const root = join(base, 'same-headings');
  await mkdir(join(root, 'L3-modules'), { recursive: true });
  await writeFile(join(root, 'L3-modules', 'alpha.md'), '# Alpha\n\n## Setup\n\nSee [beta setup](beta.md#setup), [own setup](#setup) and [beta](beta.md).\n');
  await writeFile(join(root, 'L3-modules', 'beta.md'), '# Beta\n\n## Setup\n\nBack to [alpha setup](alpha.md#setup).\n');
  const { text } = await run({}, root);
  assert.ok(text.includes('<a id="l3-modules-alpha--setup"></a>'));
  assert.ok(text.includes('<a id="l3-modules-beta--setup"></a>'));
  assert.ok(text.includes('[beta setup](#l3-modules-beta--setup)'));
  assert.ok(text.includes('[own setup](#l3-modules-alpha--setup)'));
  assert.ok(text.includes('[beta](#l3-modules-beta)'), 'a link without fragment goes to the document start');
  assert.ok(text.includes('[alpha setup](#l3-modules-alpha--setup)'));
});

test('links follow the policy: documents and folders become anchors, everything else stays', async () => {
  const { text, report, lines } = await run();
  assert.ok(text.includes('[storage module](#l3-modules-storage)'));
  assert.ok(text.includes('[modules folder](#l3-modules-index)'));
  assert.ok(text.includes('[writing section](#l3-modules-storage--writing-tides)'));
  assert.ok(text.includes('[operations index](#l4-operations-index)'));
  assert.ok(text.includes('[outside the docs](../outside.md)'));
  assert.ok(text.includes('[project page](https://example.org/tides)'));
  assert.ok(text.includes('[mail the team](mailto:team@example.org)'));
  assert.ok(text.includes('[this overview](#l2-architecture--overview)'));
  assert.ok(text.includes('[missing page](L3-modules/missing.md)'));
  assert.ok(text.includes('[link to storage](#l3-modules-storage)'), 'the CRLF file is rewritten too');
  // external includes the javascript: link of the L4 payload test: it stays in the text as written.
  assert.deepEqual(report.counts, { rewritten: 6, external: 3, fragment: 1, outsideRoot: 1, notExported: 1, missingFragment: 0 });
  const warned = lines.warn.join('\n');
  assert.match(warned, /outside the docs folder/);
  assert.match(warned, /not exported/);
});

test('a link to a decision record is a warning unless --decisions is given', async () => {
  const root = join(base, 'adr-link');
  await mkdir(join(root, 'adr'), { recursive: true });
  await writeFile(join(root, 'L1-vision.md'), '# Vision\n\nSee [the decision](adr/001-x.md).\n');
  await writeFile(join(root, 'adr', '001-x.md'), '# X\n');
  const without = await run({}, root);
  assert.ok(without.text.includes('(adr/001-x.md)'));
  assert.equal(without.report.counts.notExported, 1);
  const withAdr = await run({ decisions: true }, root);
  assert.ok(withAdr.text.includes('(#adr-001-x)'));
  assert.equal(withAdr.report.counts.notExported, 0);
});

test('fenced code is not rewritten, split or changed', async () => {
  const { text } = await run();
  assert.ok(text.includes('```sh\n## x\necho "not a heading"\n```'));
  assert.ok(!text.includes('--x"'), 'no anchor was made for the fenced "## x"');
  const root = join(base, 'fences');
  await mkdir(root, { recursive: true });
  const fenced = '# Vision\n\n```md\n[x](L2-architecture.md)\n# not a heading\n```\n\n~~~\n[y](L2-architecture.md)\n~~~\n\n    [z](L2-architecture.md)\n\nInline `[w](L2-architecture.md)` stays, [real](L2-architecture.md) changes.\n';
  await writeFile(join(root, 'L1-vision.md'), fenced);
  await writeFile(join(root, 'L2-architecture.md'), '# Architecture\n');
  const out = (await run({}, root)).text;
  assert.ok(out.includes('```md\n[x](L2-architecture.md)\n# not a heading\n```'));
  assert.ok(out.includes('~~~\n[y](L2-architecture.md)\n~~~'));
  assert.ok(out.includes('    [z](L2-architecture.md)'));
  assert.ok(out.includes('`[w](L2-architecture.md)`'));
  assert.ok(out.includes('[real](#l2-architecture)'));
  assert.equal([...out.matchAll(/<a id=/g)].length, 4, 'a start anchor and a heading anchor per document, none for the fenced "# not a heading"');
});

test('front matter is removed, output uses LF only, and the CRLF file keeps its content', async () => {
  const { text } = await run();
  assert.ok(!text.includes('title: Tidewatch vision') && !text.includes('inside front matter'));
  assert.ok(!text.includes('\r'), 'no carriage returns');
  assert.ok(text.includes('## First CRLF section'));
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), 'ends with a single newline');
  assert.ok(!/^﻿/.test(text));
});

test('the source comment holds the relative path only', async () => {
  const { text } = await run();
  assert.ok(!text.includes(fixture('pyramid')));
  assert.ok(!text.includes('/Us' + 'ers/'));
  for (const s of sources(text)) assert.ok(!s.startsWith('/') && !s.includes('..'), s);
});

test('documents are separated by a rule, with a blank line before it', async () => {
  const { text } = await run();
  const parts = text.split('\n---\n');
  assert.equal(parts.length, 8, 'seven separators for eight documents');
  for (const part of parts.slice(0, -1)) assert.ok(part.endsWith('\n'), 'blank line before the rule');
});

test('an existing output file is not overwritten without --force', async () => {
  const file = join(base, 'existing.md');
  await writeFile(file, 'keep me');
  await assert.rejects(exportMarkdown({ root: fixture('pyramid'), file, log: quiet }), (error) => error.code === 'E_EXISTS' && /--force/.test(error.message));
  assert.equal(await readFile(file, 'utf8'), 'keep me');
  const forced = await exportMarkdown({ root: fixture('pyramid'), file, force: true, log: quiet });
  assert.equal(forced.written, true);
  assert.match(await readFile(file, 'utf8'), /^<!-- source: L1-vision\.md -->/);
});

test('--force never overwrites a source document', async () => {
  await assert.rejects(exportMarkdown({ root: fixture('pyramid'), file: fixture('pyramid', 'L1-vision.md'), force: true, log: quiet }), /source document/);
});

test('an empty docs folder warns "no layers found" and writes no file', async () => {
  const root = join(base, 'empty');
  await mkdir(root, { recursive: true });
  const { written, lines, file } = await run({}, root);
  assert.equal(written, false);
  assert.match(lines.warn.join('\n'), /no layers found/i);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('only decision records without --decisions writes nothing and points to --decisions', async () => {
  const root = join(base, 'adr-only');
  await mkdir(join(root, 'adr'), { recursive: true });
  await writeFile(join(root, 'adr', '001-a.md'), '# A\n');
  const none = await run({}, root);
  assert.equal(none.written, false);
  assert.match(none.lines.warn.join('\n'), /--decisions/);
  const withAdr = await run({ decisions: true }, root);
  assert.equal(withAdr.written, true);
});

test('a missing docs folder is an error', async () => {
  await assert.rejects(exportMarkdown({ root: join(base, 'nope'), file: join(base, 'x.md'), log: quiet }), /Docs folder not found/);
});

test('the output file may be in a folder that does not exist yet', async () => {
  const file = join(base, 'new', 'deeper', 'all.md');
  await exportMarkdown({ root: fixture('minimal'), file, log: quiet });
  assert.match(await readFile(file, 'utf8'), /source: L1-vision\.md/);
});

test('a heading inside a block quote or list is no document heading: it gets no anchor and its line is left as written', async () => {
  const root = join(base, 'nested');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'L1-vision.md'), '# Vision\n\n> ## Quoted heading\n> text\n\n- item\n\n  ## List heading\n');
  const { text } = await run({}, root);
  assert.ok(text.includes('> ## Quoted heading\n'), text);
  assert.ok(!text.includes('quoted-heading') && !text.includes('list-heading'), text);
  assert.ok(text.includes('<a id="l1-vision--vision"></a>\n\n# Vision'));
});

test('an anchor never joins the paragraph above a heading that follows it without a blank line', async () => {
  const root = join(base, 'tight');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'L1-vision.md'), 'Intro text\n## Tight heading\nbody\n');
  const { text } = await run({}, root);
  assert.ok(text.includes('Intro text\n\n<a id="l1-vision--tight-heading"></a>\n\n## Tight heading\nbody'));
});

// Review fixes: C3, C4, C5, C6, C8.

async function makeDocs(files) {
  const root = await mkdtemp(join(base, 'docs-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}

test('links with an image as text, brackets in the text or text over two lines are rewritten', async () => {
  const root = await makeDocs({
    'L1-vision.md': '# One\n\n## S\n',
    'L2-architecture.md': '# Two\n\n[![badge](pic.png)](L1-vision.md#s) and [a [b] c](L1-vision.md#s) and [multi\nline](L1-vision.md#s)\n'
  });
  const { text } = await run({}, root);
  assert.ok(text.includes('](#l1-vision--s)'));
  assert.ok(!/\]\([^)]*L1-vision\.md/.test(text), text);
  assert.equal(text.split('(#l1-vision--s)').length - 1, 3);
});

test('a link-like text inside a code span that spans two lines is left alone', async () => {
  const root = await makeDocs({
    'L1-vision.md': '# One\n\n## S\n',
    'L2-architecture.md': '# Two\n\nText `code\n[x](L1-vision.md)` end\n'
  });
  const { text } = await run({}, root);
  assert.ok(text.includes('[x](L1-vision.md)'));
});

test('links inside an HTML comment are left alone', async () => {
  const root = await makeDocs({
    'L1-vision.md': '# One\n\n## S\n',
    'L2-architecture.md': '# Two\n\n<!--\n[x](L1-vision.md)\n-->\n'
  });
  const { text } = await run({}, root);
  assert.ok(text.includes('[x](L1-vision.md)'));
});

test('a document that ends inside an open fence is closed so that the next document is not swallowed', async () => {
  const root = await makeDocs({
    'L1-vision.md': '# One\n\n```\nunclosed\n',
    'L2-architecture.md': '## Two\ntext\n'
  });
  const { text } = await run({}, root);
  const first = text.slice(0, text.indexOf('<!-- source: L2-architecture.md -->'));
  const fences = first.split('\n').filter((l) => /^```\s*$/.test(l));
  assert.equal(fences.length, 2, first);
});

test('table of contents labels escape characters that would turn into markup', async () => {
  const root = await makeDocs({
    'L1-vision.md': '# T\n\n## Vec<T> and `<div>` & x\n',
    'L2-architecture.md': '# Two\n\n## Two\n'
  });
  const { text } = await run({ toc: true }, root);
  const toc = text.slice(0, text.indexOf('<!-- source: L1-vision.md -->'));
  assert.ok(toc.includes('Vec\\<T\\> and \\<div\\> \\& x'), toc);
});

test('a very long line with many brackets is processed in linear time', async () => {
  await assertLinearGrowth(async (n) => {
    const root = await makeDocs({
      'L1-vision.md': `# T\n\n${'['.repeat(n)}\n`,
      'L2-architecture.md': '# Two\n\n## Two\n'
    });
    const start = process.hrtime.bigint();
    await run({}, root);
    return secondsSince(start);
  }, 25000, 100000, { label: 'brackets on one line', maxLarge: 1500000 });
});

test('a link whose fragment names no heading goes to the document start and is reported', async () => {
  const root = await makeDocs({
    'L1-vision.md': '# One\n\n## S\n',
    'L2-architecture.md': '# Two\n\n[d](L1-vision.md#nothing)\n'
  });
  const { text, report, lines } = await run({}, root);
  assert.ok(text.includes('[d](#l1-vision)'));
  assert.equal(report.counts.missingFragment, 1);
  assert.ok(lines.warn.some((l) => /heading/.test(l) && l.includes('#nothing')), lines.warn.join('\n'));
});

test('S4: --force does not write through a symlink at the output path', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const victim = join(base, 'victim.txt');
  await writeFile(victim, 'KEEP');
  const file = join(base, 'linked.md');
  try {
    await symlink(victim, file);
  } catch {
    t.skip('symlinks are not available here');
    return;
  }
  await assert.rejects(exportMarkdown({ root: fixture('minimal'), file, force: true, log: quiet }), /symbolic link/);
  assert.equal(await readFile(victim, 'utf8'), 'KEEP');
});

test('anchors "headings": no HTML anchors, repeated headings numbered across the file, and every link finds a heading', async () => {
  const root = join(base, `headings-${n++}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'L1-vision.md'), '# Vision\n\n## Traps\n\nSee `L2-architecture.md` and [the traps](L2-architecture.md#traps).\n');
  await writeFile(join(root, 'L2-architecture.md'), '# Architecture\n\n## Traps\n\nBack to [vision](L1-vision.md#traps).\n');
  const { text } = await run({ anchors: 'headings', toc: true }, root);
  assert.doesNotMatch(text, /<a id=/);
  assert.match(text, /\[Traps\]\(#traps\)/);
  assert.match(text, /\[Traps\]\(#traps-1\)/);
  assert.match(text, /\[the traps\]\(#traps-1\)/);
  assert.match(text, /\[vision\]\(#traps\)/);
  const headings = new Set(['vision', 'traps', 'architecture', 'traps-1']);
  for (const m of text.matchAll(/\]\(#([^)]+)\)/g)) assert.ok(headings.has(m[1]), `no heading for ${m[1]}`);
});

test('anchors: an unknown mode is refused, "html" is the default', async () => {
  await assert.rejects(run({ anchors: 'nope' }), /Unknown anchors mode/);
  const { text } = await run({});
  assert.match(text, /<a id="/);
});
