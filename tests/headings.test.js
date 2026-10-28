// AC 2 (headings, slugs, titles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHeadings, MAX_HEADINGS, slugify, titleFromPath, stripFrontMatter, normalizeSource, renderMarkdown } from '../viewer.js';
import { fixtureText } from './helpers.js';
import { assertLinearGrowth, secondsSince } from './helpers.js';

const EMOJI = String.fromCodePoint(0x1f30a); // a wave symbol, built here so no emoji is committed

test('slugify follows the documented rule', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  Spaced   out  '), 'spaced-out');
  assert.equal(slugify('Rock & Roll!'), 'rock-roll');
  assert.equal(slugify('snake_case and kebab-case'), 'snake_case-and-kebab-case');
  assert.equal(slugify('Version 2.0 (beta)'), 'version-20-beta');
  assert.equal(slugify('Überblick für Größe'), 'überblick-für-größe');
  assert.equal(slugify('日本語 の 見出し'), '日本語-の-見出し');
  assert.equal(slugify('--edge--'), 'edge');
});

test('slugify decodes entities first unless told the text is decoded', () => {
  assert.equal(slugify('Fish &amp; Chips'), 'fish-chips');
  assert.equal(slugify('caf&eacute; &#233;'), 'café-é');
  assert.equal(slugify('&amp;lt;', { decoded: true }), 'amplt');
});

test('slugify gives an empty string for text with no letters or digits', () => {
  assert.equal(slugify(EMOJI), '');
  assert.equal(slugify('!!! ???'), '');
});

test('extractHeadings returns levels 1 to 4 with text, level and unique slugs', async () => {
  const headings = await fixtureText('L2-architecture.md').then(extractHeadings);
  assert.deepEqual(
    headings.map((h) => [h.level, h.text, h.slug]),
    [
      [1, 'Tidewatch architecture', 'tidewatch-architecture'],
      [2, 'Overview', 'overview'],
      [2, 'Data flow', 'data-flow'],
      [3, 'Ingest', 'ingest'],
      [3, 'Publish', 'publish'],
      [2, 'Overview', 'overview-1'],
      [2, 'The storage module in short', 'the-storage-module-in-short'],
      [2, 'Salt & Spray \u00a9 notes', 'salt-spray-notes'],
      [2, 'The tide_table record', 'the-tide_table-record'],
      [2, 'Closing hashes', 'closing-hashes'],
      [2, 'Überblick für Größe', 'überblick-für-größe'],
      [2, 'Limits', 'limits']
    ]
  );
});

test('headings below level 4 are not listed', () => {
  const headings = extractHeadings('# a\n\n##### five\n\n###### six\n\n#### four\n');
  assert.deepEqual(headings.map((h) => h.text), ['a', 'four']);
});

test('emoji-only headings get the section slug, duplicates are numbered', () => {
  const headings = extractHeadings(`## ${EMOJI}\n\n## ${EMOJI}\n\n## section\n`);
  assert.deepEqual(headings.map((h) => h.slug), ['section', 'section-1', 'section-2']);
});

test('duplicate suffixes never collide with a natural slug', () => {
  const headings = extractHeadings('## Setup 1\n\n## Setup\n\n## Setup\n');
  assert.deepEqual(headings.map((h) => h.slug), ['setup-1', 'setup', 'setup-2']);
});

test('duplicates get -1, -2 in document order', () => {
  const headings = extractHeadings('## A\n\n## A\n\n## A\n');
  assert.deepEqual(headings.map((h) => h.slug), ['a', 'a-1', 'a-2']);
});

test('a heading line inside a fenced block is not a heading', async () => {
  const headings = await fixtureText('L3-modules/storage.md').then(extractHeadings);
  assert.deepEqual(headings.map((h) => h.text), ['Storage', 'Writing tides', 'Reading tides', 'Caching', 'Pruning']);
  assert.ok(!headings.some((h) => h.text === 'x'));
  const tilde = extractHeadings('~~~\n## y\n~~~\n\n## real\n');
  assert.deepEqual(tilde.map((h) => h.text), ['real']);
});

test('a heading line inside front matter is not a heading, and front matter is stripped', async () => {
  const text = await fixtureText('L1-vision.md');
  const headings = extractHeadings(text);
  assert.deepEqual(headings.map((h) => h.text), ['Tidewatch vision', 'Why it exists']);
  assert.ok(!stripFrontMatter(normalizeSource(text)).includes('inside front matter'));
});

test('stripFrontMatter only strips a closed block at the very start', () => {
  assert.equal(stripFrontMatter('---\na: 1\n---\nbody\n'), 'body\n');
  assert.equal(stripFrontMatter('---\na: 1\n...\nbody\n'), 'body\n');
  assert.equal(stripFrontMatter('---\nnever closed\nbody\n'), '---\nnever closed\nbody\n');
  assert.equal(stripFrontMatter('text\n---\na: 1\n---\n'), 'text\n---\na: 1\n---\n');
  assert.equal(stripFrontMatter('---\n---\nbody\n'), 'body\n');
});

test('a horizontal rule at the start with later text is not mistaken for front matter', () => {
  const headings = extractHeadings('---\n\n## After rule\n\n---\n');
  assert.deepEqual(headings.map((h) => h.text), ['After rule']);
});

test('CRLF and LF versions give the same headings and the same rendered ids', async () => {
  const lf = await fixtureText('L2-architecture.md');
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.deepEqual(extractHeadings(crlf), extractHeadings(lf));
  assert.equal(renderMarkdown(crlf).html, renderMarkdown(lf).html);
});

test('the committed CRLF fixture really contains CRLF and is parsed like LF', async () => {
  const text = await fixtureText('L3-modules/crlf.md');
  assert.ok(text.includes('\r\n'), 'git normalised the CRLF fixture, check .gitattributes');
  const headings = extractHeadings(text);
  assert.deepEqual(headings.map((h) => h.slug), ['windows-notes', 'first-crlf-section', 'second-crlf-section', 'detail']);
});

test('heading ids in the rendered page equal the extracted slugs for every heading', async () => {
  const text = await fixtureText('L2-architecture.md');
  const { html, headings } = renderMarkdown(text);
  const ids = [...html.matchAll(/<h([1-4]) id="([^"]*)"/g)].map((m) => m[2]);
  assert.deepEqual(ids, headings.map((h) => h.slug));
  assert.deepEqual(headings, extractHeadings(text));
  assert.ok(ids.includes('overview') && ids.includes('overview-1'));
});

test('headings below level 4 get no id', () => {
  const { html } = renderMarkdown('##### five\n\n###### six\n');
  assert.ok(!html.includes('id='));
});

test('ids are decoded text slugs for code, link, entity, hashes and non-ASCII headings', () => {
  const { html } = renderMarkdown('## A `code_x` [link](#x) &amp; more ##\n\n## Größe\n');
  assert.match(html, /<h2 id="a-code_x-link-more">/);
  assert.match(html, /<h2 id="größe">/);
});

test('the heading text strips markup but keeps image alt text and breaks as spaces', () => {
  const headings = extractHeadings('## One **bold** ![alt text](x.png) two\n\nLine one\nline two  \nline three\n---\n');
  assert.deepEqual(headings.map((h) => h.text), ['One bold alt text two', 'Line one line two line three']);
});

test('a heading line inside an HTML block or an HTML comment is not a heading', () => {
  assert.deepEqual(extractHeadings('<div>\n## nope\n</div>\n\n<!--\n## c\n-->\n\n## real\n').map((h) => h.text), ['real']);
});

test('HTML blocks stay inert in the rendering and add no heading id', () => {
  const { html, headings } = renderMarkdown('<div onclick="x()">\n## nope\n</div>\n\n## real\n');
  assert.ok(!html.includes('<div'));
  assert.ok(html.includes('&lt;div'));
  assert.ok(!html.includes('<h2 id="nope"'));
  assert.deepEqual(headings.map((h) => h.text), ['real']);
});

test('titles follow the documented rule', () => {
  assert.equal(titleFromPath('L2-architecture.md'), 'L2 Architecture');
  assert.equal(titleFromPath('L3-modules/index.md'), 'L3 Modules');
  assert.equal(titleFromPath('adr/003-use-ids.md'), '003 Use Ids');
  assert.equal(titleFromPath('API-Guide.md'), 'API Guide');
  assert.equal(titleFromPath('L4-operations/README.md'), 'L4 Operations');
  assert.equal(titleFromPath('docs/ADR-index-notes.md'), 'ADR Index Notes');
  assert.equal(titleFromPath('some_snake_name.md'), 'Some Snake Name');
  assert.equal(titleFromPath('index.md'), 'Index');
});

// Review fixes: S1 (slow duplicate numbering) and C9 (literal slugs).

test('many duplicate headings are numbered in linear time', async () => {
  const headings = extractHeadings('## a\n'.repeat(1500));
  assert.equal(headings[0].slug, 'a');
  assert.equal(headings[1499].slug, 'a-1499');
  await assertLinearGrowth((n) => {
    const text = '## a\n'.repeat(n);
    const start = process.hrtime.bigint();
    extractHeadings(text);
    return secondsSince(start);
  }, 2000, 8000, { label: 'duplicate headings', maxLarge: 64000 });
});

test('a file with a huge number of headings is cut at the cap and still scales linearly', async () => {
  assert.equal(extractHeadings('## a\n'.repeat(60000)).length, MAX_HEADINGS);
  await assertLinearGrowth((n) => {
    const text = '## a\n'.repeat(n);
    const start = process.hrtime.bigint();
    extractHeadings(text);
    return secondsSince(start);
  }, 15000, 60000, { label: 'headings above the cap', maxLarge: 240000 });
});

test('a heading that is literally "foo-1" keeps that slug; the duplicate of "Foo" skips it', () => {
  const slugs = extractHeadings('## Foo\n\n## Foo\n\n## foo-1\n').map((h) => h.slug);
  assert.deepEqual(slugs, ['foo', 'foo-2', 'foo-1']);
});
