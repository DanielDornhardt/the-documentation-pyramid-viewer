// Tests: backticked paths of documents become links in the HTML
// views, the HTML export and the Markdown export. Real pyramids point to their module files this way:
// "Details: `combat.md`."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMarkdown, createLinkReport, findDocument, exportHtml, exportMarkdown } from '../viewer.js';
import { tempFixture, walkExport, assertLinearGrowth, secondsSince } from './helpers.js';

const docs = new Set(['L1-vision.md', 'L2-architecture.md', 'L3-modules/index.md', 'L3-modules/storage.md', 'L4-operations/index.md', 'adr/README.md']);
const resolveLink = (target, fragment) => {
  const doc = findDocument(target, docs);
  return doc ? `/${doc.replace(/\.md$/, '.html')}${fragment ? '#' + fragment : ''}` : null;
};
const render = (md, sourcePath = 'L3-modules/index.md', report) => renderMarkdown(md, { sourcePath, resolveLink, report }).html;
const quiet = { info() {}, warn() {} };

test('a backticked file name next to the source document becomes a link around the code', () => {
  const html = render('Details: `storage.md`.');
  assert.match(html, /<a href="\/L3-modules\/storage\.html"><code>storage\.md<\/code><\/a>/);
});

test('a backticked path relative to the docs root becomes a link, also from another folder', () => {
  const html = render('See `L3-modules/storage.md` and `L2-architecture.md`.', 'L4-operations/index.md');
  assert.match(html, /<a href="\/L3-modules\/storage\.html"><code>L3-modules\/storage\.md<\/code><\/a>/);
  assert.match(html, /<a href="\/L2-architecture\.html"><code>L2-architecture\.md<\/code><\/a>/);
});

test('a backticked folder goes to its index document, a fragment to the heading', () => {
  const html = render('Decisions in `adr/` and `L3-modules/storage.md#write-path`.', 'L1-vision.md');
  assert.match(html, /<a href="\/adr\/README\.html"><code>adr\/<\/code><\/a>/);
  assert.match(html, /<a href="\/L3-modules\/storage\.html#write-path"><code>L3-modules\/storage\.md#write-path<\/code><\/a>/);
});

test('backticked paths that are not documents stay plain code and cause no warning', () => {
  const report = createLinkReport();
  const html = render('Edit `src/main.c`, `missing.md`, `../outside.md`, `/etc/passwd.md`, `x.md y` and `a.md#`.', 'L3-modules/index.md', report);
  assert.ok(!html.includes('<a '), html);
  assert.equal(report.warnings.length, 0);
});

test('code inside a link, inside a heading or inside a fence is not turned into a second link', () => {
  const md = ['## Heading with `storage.md`', '', '[the `storage.md` page](storage.md)', '', '[`storage.md`](storage.md)', '', '```', 'storage.md', '```'].join('\n');
  const html = render(md);
  assert.equal((html.match(/<a /g) || []).length, 2, html); // only the two real links
  assert.ok(!/<h2[^>]*>.*<a /.test(html), 'no link in the heading');
  assert.ok(!/<pre><code>[^<]*<a/.test(html));
});

test('without a resolver backticked paths stay code', () => {
  const html = renderMarkdown('Details: `storage.md`.', { sourcePath: 'L3-modules/index.md' }).html;
  assert.ok(!html.includes('<a '));
});

test('every linked backticked path is counted as rewritten', () => {
  const report = createLinkReport();
  render('`storage.md` and `L1-vision.md` and `nothing.md`.', 'L3-modules/index.md', report);
  assert.equal(report.counts.rewritten, 2);
});

test('hostile backticked text never reaches an href unescaped', () => {
  const html = render('`storage.md"onmouseover="x` and `<b>storage.md</b>` and `storage.md#a"b`.');
  assert.ok(!/onmouseover=/.test(html.replace(/<code>[^<]*<\/code>/g, '')), html);
  assert.ok(!html.includes('<b>'));
});

test('the HTML export links the module files named in backticks and all those links resolve', async () => {
  const { root, base, cleanup } = await tempFixture();
  const out = await mkdtemp(join(tmpdir(), 'pv-code-paths-'));
  try {
    const index = join(root, 'L3-modules', 'index.md');
    await writeFile(index, `${await readFile(index, 'utf8')}\n## Backtick links\n\nDetails: \`storage.md\` and \`L4-operations/runbook.md\`.\n`);
    await exportHtml({ root, out, view: 'both', skin: 'plain', log: quiet });
    const html = await readFile(join(out, 'L3-modules', 'index.html'), 'utf8');
    assert.match(html, /<a href="storage\.html"><code>storage\.md<\/code><\/a>/);
    assert.match(html, /<a href="\.\.\/L4-operations\/runbook\.html"><code>L4-operations\/runbook\.md<\/code><\/a>/);
    const tree = await readFile(join(out, '_tree', 'L3-modules', 'index.html'), 'utf8');
    assert.match(tree, /<a href="storage\.html"><code>storage\.md<\/code><\/a>/);
    const walked = await walkExport(out, { allowUnresolved: [/^$/] });
    assert.deepEqual(walked.problems.filter((p) => /storage|runbook/.test(p)), []);
  } finally {
    await cleanup();
    await rm(out, { recursive: true, force: true });
  }
});

test('the Markdown export turns backticked document paths into anchors, and leaves code blocks alone', async () => {
  const { root, cleanup } = await tempFixture();
  const out = await mkdtemp(join(tmpdir(), 'pv-code-paths-md-'));
  try {
    const index = join(root, 'L3-modules', 'index.md');
    await writeFile(index, `${await readFile(index, 'utf8')}\n## Backtick links\n\nDetails: \`storage.md\` and \`nothing.md\`.\n\n\`\`\`\nstorage.md\n\`\`\`\n\n[\`runbook.md\`](../L4-operations/runbook.md)\n`);
    const file = join(out, 'all.md');
    await exportMarkdown({ root, file, log: quiet });
    const text = await readFile(file, 'utf8');
    assert.match(text, /Details: \[`storage\.md`\]\(#[a-z0-9-]*storage[a-z0-9-]*\) and `nothing\.md`\./);
    assert.match(text, /```\nstorage\.md\n```/);
    assert.equal((text.match(/\[`runbook\.md`\]\(#/g) || []).length, 1, 'an existing link around code is rewritten once, not nested');
    assert.ok(!/\[\[`/.test(text), 'no nested link brackets');
  } finally {
    await cleanup();
    await rm(out, { recursive: true, force: true });
  }
});

// ---- Findings of the independent review of the first version -------------------------------------------

const mdOf = async (body, extraDocs = {}) => {
  const { root, cleanup } = await tempFixture();
  const out = await mkdtemp(join(tmpdir(), 'pv-code-paths-rv-'));
  try {
    const index = join(root, 'L3-modules', 'index.md');
    await writeFile(index, `${await readFile(index, 'utf8')}\n## Review cases\n\n${body}\n`);
    for (const [name, text] of Object.entries(extraDocs)) await writeFile(join(root, name), text);
    const file = join(out, 'all.md');
    const result = await exportMarkdown({ root, file, log: quiet });
    const text = await readFile(file, 'utf8');
    return { text: text.slice(text.indexOf('## Review cases')), result };
  } finally {
    await cleanup();
    await rm(out, { recursive: true, force: true });
  }
};

test('review 2: the Markdown export leaves code in ATX and setext headings alone, like the HTML renderer', async () => {
  const { text, result } = await mdOf('### Heading with `storage.md`\n\nSetext with `storage.md`\n------------------------\n\nBody `storage.md`.');
  assert.ok(text.includes('### Heading with `storage.md`'), text);
  assert.ok(text.includes('Setext with `storage.md`\n'), text);
  assert.match(text, /Body \[`storage\.md`\]\(#/);
  assert.equal(result.report.counts.rewritten >= 1, true);
});

test('review 3: code inside reference-style link text is not wrapped again', async () => {
  const { text } = await mdOf('See [ref `storage.md`][r] and [short `storage.md`] and ![alt `storage.md`](pic.png).\n\n[r]: https://example.org\n[short]: https://example.org');
  assert.ok(text.includes('[ref `storage.md`][r]'), text);
  assert.ok(text.includes('[short `storage.md`]'), text);
  assert.ok(text.includes('![alt `storage.md`](pic.png)'), text);
});

test('review 4: link titles, reference titles, inline HTML, comments and autolinks are not edited', async () => {
  const cases = [
    '[t](storage.md "see `storage.md`")',
    '<span title="`storage.md`">x</span>',
    'text <!-- `storage.md` --> more',
    '<a href="https://example.org">`storage.md`</a>',
    '<https://example.org/`storage.md`>'
  ];
  const { text } = await mdOf(`${cases.join('\n\n')}\n\n[r]: https://example.org "title \`storage.md\`"`);
  assert.ok(!text.includes('[`storage.md`]('), `a code span inside one of these was wrapped:\n${text}`);
});

test('review 5: both renderers agree on padded spans, double-backtick spans and a trailing slash after a file', async () => {
  const html = (md) => render(md, 'L3-modules/index.md');
  assert.match(html('`` storage.md ``'), /<a href="\/L3-modules\/storage\.html"><code>storage\.md<\/code><\/a>/);
  assert.ok(!html('`L3-modules/storage.md/`').includes('<a '), 'a slash after a file is not a document path');
  const { text } = await mdOf('Double ``storage.md`` and padded ` storage.md ` and `L3-modules/storage.md/`.');
  assert.match(text, /Double \[``storage\.md``\]\(#[a-z0-9-]+\) and padded \[` storage\.md `\]\(#[a-z0-9-]+\) and `L3-modules\/storage\.md\/`\./);
});

test('review 6: a code span with a fragment that names no heading links to the document start and is reported', async () => {
  const report = createLinkReport();
  const reporting = (target, fragment) => {
    const doc = findDocument(target, docs);
    if (!doc) return null;
    return fragment === 'nope' ? { href: `/${doc.replace(/\.md$/, '.html')}`, missingFragment: true } : `/${doc.replace(/\.md$/, '.html')}#${fragment}`;
  };
  const html = renderMarkdown('`storage.md#nope` and `storage.md#ok`', { sourcePath: 'L3-modules/index.md', resolveLink: reporting, report }).html;
  assert.match(html, /<a href="\/L3-modules\/storage\.html"><code>storage\.md#nope<\/code><\/a>/);
  assert.equal(report.counts.missingFragment, 1);
  assert.equal(report.counts.rewritten, 2);
  assert.deepEqual(report.warnings.map((w) => w.reason), ['fragment-not-found']);
  const { result } = await mdOf('`storage.md#nope` and `storage.md#writing-tides`.');
  assert.equal(result.report.counts.missingFragment, 1);
  assert.equal(result.report.warnings.filter((w) => w.reason === 'fragment-not-found').length, 1);
  const { root, cleanup } = await tempFixture();
  const out = await mkdtemp(join(tmpdir(), 'pv-code-paths-html-'));
  try {
    const index = join(root, 'L3-modules', 'index.md');
    await writeFile(index, `${await readFile(index, 'utf8')}\n## Review cases\n\n\`storage.md#nope\` and \`storage.md#writing-tides\`.\n`);
    const exported = await exportHtml({ root, out, view: 'pyramid', skin: 'plain', log: quiet });
    assert.equal(exported.report.warnings.filter((w) => w.reason === 'fragment-not-found' && w.href === 'storage.md#nope').length >= 1, true);
  } finally {
    await cleanup();
    await rm(out, { recursive: true, force: true });
  }
});

/** Exports a Markdown file made of a repeated unit at two sizes and checks that the time grows about linearly. */
async function timeAnExport(unit, label) {
  const timeExport = async (units) => {
    const { root, cleanup } = await tempFixture();
    const out = await mkdtemp(join(tmpdir(), 'pv-code-paths-big-'));
    try {
      await writeFile(join(root, 'L3-modules', 'big.md'), `# Big\n\n${unit.repeat(units)}\n`);
      const start = process.hrtime.bigint();
      await exportMarkdown({ root, file: join(out, 'big.md'), log: quiet });
      return secondsSince(start);
    } finally {
      await cleanup();
      await rm(out, { recursive: true, force: true });
    }
  };
  await assertLinearGrowth(timeExport, 8000, 32000, { label, maxLarge: Math.floor(1500000 / unit.length) });
}


test('review 1: a huge file of link texts and code spans exports in linear time', async () => {
  const unit = '[a](x)`bc` ';
  await timeAnExport(unit, 'link texts and code spans');
});

test('review 1b: many inline HTML anchors and code spans in one paragraph export in linear time', async () => {
  await timeAnExport('<a href="x">y</a> `storage.md` ', 'inline anchors and code spans');
});
