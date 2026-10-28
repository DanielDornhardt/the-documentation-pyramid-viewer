// AC 6 (safety of rendering) and AC 7 (link policy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, rewriteLink, createLinkReport, findDocument, escapeHtml } from '../viewer.js';
import { fixtureText } from './helpers.js';

const ALLOWED_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'ul', 'ol', 'li', 'code', 'pre', 'em', 'strong', 'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 's', 'img']);

/** Fails when the HTML holds a tag outside the allowed set, an event attribute or a script URL. */
function assertInert(html) {
  for (const m of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)) {
    assert.ok(ALLOWED_TAGS.has(m[1].toLowerCase()), `unexpected tag <${m[1]}> in ${html}`);
    const attributes = m[2].replace(/"[^"]*"/g, '""'); // quoted values are text, only real attributes count
    assert.ok(!/\son[a-z]+\s*=/i.test(attributes), `event attribute in ${m[0]}`);
    assert.ok(!/(href|src)\s*=\s*"\s*(javascript|vbscript|data|file):/i.test(m[2]), `script url in ${m[0]}`);
  }
}

const docs = new Set(['L1-vision.md', 'L2-architecture.md', 'L3-modules/index.md', 'L3-modules/storage.md', 'L3-modules/crlf.md', 'L4-operations/index.md', 'adr/README.md']);
const resolveLink = (target, fragment) => {
  const doc = findDocument(target, docs);
  return doc ? `/${doc.replace(/\.md$/, '.html')}${fragment ? '#' + fragment : ''}` : null;
};

test('raw HTML in markdown is escaped (script, img onerror)', () => {
  const md = [
    '<script>alert(1)</script>',
    '',
    '<img src=x onerror=alert(1)>',
    '',
    'Inline <b onclick="x()">bold</b> and <script>x</script> text.',
    '',
    '<!-- a comment -->',
    '',
    '<iframe src="https://example.org"></iframe>'
  ].join('\n');
  const { html } = renderMarkdown(md);
  assertInert(html);
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<!--'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('script URLs in links are not rendered as links', () => {
  const md = [
    '[a](javascript:alert(1))',
    '[b](JaVaScRiPt:alert(1))',
    '[c](data:text/html;base64,PHNjcmlwdD4=)',
    '[d](vbscript:msgbox(1))',
    '[e](&#106;avascript:alert(1))',
    '[f](java&#x73;cript:alert(1))',
    '[g](file:///etc/passwd)',
    '![h](javascript:alert(1))',
    '<javascript:alert(1)>',
    '[i]: javascript:alert(1)',
    '[j][i]'
  ].join('\n\n');
  const { html } = renderMarkdown(md);
  assertInert(html);
  assert.ok(!/href="[^"]*script/i.test(html));
  assert.ok(!/<a /.test(html), html);
});

test('a quote in a link title cannot break out of the attribute', () => {
  const { html } = renderMarkdown('[w](a.md "q\\" onmouseover=\\"alert(1)")\n\n[x](b.md \'t" onfocus="y\')');
  assertInert(html);
  assert.ok(html.includes('title="q&quot; onmouseover=&quot;alert(1)"'));
  assert.ok(!/"\s+on[a-z]+=/.test(html));
});

test('quotes and angle brackets in link targets and alt text stay inside their attributes', () => {
  const { html } = renderMarkdown('[a](x"onclick="y.md)\n\n[b](<a"b.md>)\n\n![al"t onerror=x](i.png)');
  assertInert(html);
  assert.ok(!/<[^>]*"\s+on[a-z]+=/.test(html), html);
});

test('the fixture payload document renders inert', async () => {
  const { html } = renderMarkdown(await fixtureText('L4-operations/index.md'));
  assertInert(html);
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('Daily check'));
});

test('pathological input finishes within the time budget', () => {
  const budgetMs = 5000;
  const inputs = [
    '<!--'.repeat(50000),
    '\t\n'.repeat(50000),
    '<!--\t\n'.repeat(30000),
    '['.repeat(20000),
    '*'.repeat(30000),
    '`'.repeat(30000) + 'a',
    '> '.repeat(5000) + 'x',
    '- '.repeat(5000) + 'x',
    '<a '.repeat(20000),
    '&'.repeat(30000),
    '[a](' + '('.repeat(20000)
  ];
  for (const input of inputs) {
    // Best of two runs, so that one stall on a busy machine cannot fail it; the budget itself stays generous.
    let ms = Infinity;
    for (let run = 0; run < 2 && ms >= budgetMs; run++) {
      const start = process.hrtime.bigint();
      renderMarkdown(input);
      ms = Math.min(ms, Number(process.hrtime.bigint() - start) / 1e6);
    }
    assert.ok(ms < budgetMs, `input starting ${JSON.stringify(input.slice(0, 12))} took ${ms.toFixed(0)} ms`);
  }
});

test('escapeHtml escapes the five dangerous characters', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeHtml(5), '5');
});

test('code blocks keep their content as text', () => {
  const { html } = renderMarkdown('```html\n<script>alert(1)</script>\n```\n');
  assertInert(html);
  assert.ok(html.includes('&lt;script&gt;'));
});

test('tables render', async () => {
  const { html } = renderMarkdown(await fixtureText('L2-architecture.md'));
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>Limit</th>'));
});

// ---- link policy (AC 7)

test('findDocument maps files and folders to exported documents', () => {
  assert.equal(findDocument('L3-modules/storage.md', docs), 'L3-modules/storage.md');
  assert.equal(findDocument('L3-modules', docs), 'L3-modules/index.md');
  assert.equal(findDocument('L3-modules/', docs), 'L3-modules/index.md');
  assert.equal(findDocument('adr', docs), 'adr/README.md');
  assert.equal(findDocument('L4-operations/missing.md', docs), null);
  assert.equal(findDocument('nope', docs), null);
  assert.equal(findDocument('', docs), null);
  const both = new Set(['f/README.md', 'f/index.md']);
  assert.equal(findDocument('f', both), 'f/index.md');
});

function rewrite(href, sourcePath = 'L2-architecture.md') {
  const report = createLinkReport();
  const out = rewriteLink(href, { sourcePath, resolveLink, report });
  return { out, report };
}

test('relative links of every kind are rewritten or left as the policy says', () => {
  assert.equal(rewrite('L3-modules/storage.md').out, '/L3-modules/storage.html');
  assert.equal(rewrite('L3-modules/').out, '/L3-modules/index.html');
  assert.equal(rewrite('L3-modules').out, '/L3-modules/index.html');
  assert.equal(rewrite('L3-modules/storage.md#writing-tides').out, '/L3-modules/storage.html#writing-tides');
  assert.equal(rewrite('./L1-vision.md').out, '/L1-vision.html');
  assert.equal(rewrite('../outside.md').out, '../outside.md');
  assert.equal(rewrite('https://example.org/x').out, 'https://example.org/x');
  assert.equal(rewrite('//example.org/x').out, '//example.org/x');
  assert.equal(rewrite('mailto:a@example.org').out, 'mailto:a@example.org');
  assert.equal(rewrite('#overview').out, '#overview');
  assert.equal(rewrite('L3-modules/missing.md').out, 'L3-modules/missing.md');
});

test('links are resolved against the source file', () => {
  assert.equal(rewrite('storage.md', 'L3-modules/crlf.md').out, '/L3-modules/storage.html');
  assert.equal(rewrite('../L2-architecture.md', 'L3-modules/crlf.md').out, '/L2-architecture.html');
  assert.equal(rewrite('../../x.md', 'L3-modules/crlf.md').out, '../../x.md');
  assert.equal(rewrite('index.md', 'L3-modules/storage.md').out, '/L3-modules/index.html');
});

test('encoded and backslash tricks that leave the root are not followed', () => {
  assert.equal(rewrite('%2e%2e/secret.md').out, '%2e%2e/secret.md');
  assert.equal(rewrite('L3-modules/..%2f..%2fsecret.md').report.counts.outsideRoot, 1);
  assert.equal(rewrite('..\\secret.md').out, '..\\secret.md');
  assert.equal(rewrite('/etc/passwd').out, '/etc/passwd');
  assert.equal(rewrite('/etc/passwd').report.counts.outsideRoot, 1);
});

test('the link report counts every kind and lists warnings', () => {
  const report = createLinkReport();
  const opts = { sourcePath: 'L2-architecture.md', resolveLink, report };
  for (const href of ['L3-modules/storage.md', 'L3-modules/', 'https://example.org', 'mailto:x@example.org', '#a', '../out.md', 'L3-modules/none.md', 'file.png']) {
    rewriteLink(href, opts);
  }
  assert.deepEqual(report.counts, { rewritten: 2, external: 2, fragment: 1, outsideRoot: 1, notExported: 2, missingFragment: 0 });
  assert.equal(report.warnings.length, 3);
  assert.deepEqual(report.warnings[0], { source: 'L2-architecture.md', href: '../out.md', reason: 'outside-root' });
  assert.equal(report.warnings[1].reason, 'not-exported');
});

test('links in rendered markdown are rewritten and reported, the heading link too', async () => {
  const report = createLinkReport();
  const { html } = renderMarkdown(await fixtureText('L2-architecture.md'), { sourcePath: 'L2-architecture.md', resolveLink, report });
  assert.ok(html.includes('href="/L3-modules/storage.html"'));
  assert.ok(html.includes('href="/L3-modules/index.html"'));
  assert.ok(html.includes('href="/L3-modules/storage.html#writing-tides"'));
  assert.ok(html.includes('href="/L4-operations/index.html"'));
  assert.ok(html.includes('href="https://example.org/tides"'));
  assert.ok(html.includes('href="mailto:team@example.org"'));
  assert.ok(html.includes('href="#overview"'));
  assert.ok(html.includes('href="../outside.md"'));
  assert.ok(html.includes('href="L3-modules/missing.md"'));
  assert.deepEqual(report.counts, { rewritten: 5, external: 2, fragment: 1, outsideRoot: 1, notExported: 1, missingFragment: 0 });
  assert.equal(report.warnings.length, 2);
});

test('a link inside fenced or inline code is never rewritten', () => {
  const report = createLinkReport();
  const md = '```md\n[x](L3-modules/storage.md)\n```\n\nInline `[y](L3-modules/storage.md)` code.\n';
  const { html } = renderMarkdown(md, { sourcePath: 'L2-architecture.md', resolveLink, report });
  assert.ok(html.includes('[x](L3-modules/storage.md)'));
  assert.ok(html.includes('[y](L3-modules/storage.md)'));
  assert.equal(report.counts.rewritten, 0);
});

test('reference-style and autolinks pass through the same policy', () => {
  const report = createLinkReport();
  const md = '[ref][r] and <https://example.org/auto>\n\n[r]: L3-modules/storage.md\n';
  const { html } = renderMarkdown(md, { sourcePath: 'L2-architecture.md', resolveLink, report });
  assert.ok(html.includes('href="/L3-modules/storage.html"'));
  assert.ok(html.includes('href="https://example.org/auto"'));
  assert.equal(report.counts.rewritten, 1);
  assert.equal(report.counts.external, 1);
});

test('without a resolver, links are left alone', () => {
  const { html } = renderMarkdown('[a](b.md)');
  assert.ok(html.includes('href="b.md"'));
});
