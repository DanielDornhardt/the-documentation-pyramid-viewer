// The document dialog of the pyramid overview: fragment route, overview
// markup, layer descriptions and tints, headers, the script file and its pure logic.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, loadPyramid } from '../viewer.js';
import { renderOverviewPage, renderDocumentPage, renderDocumentFragment, STRINGS } from '../src/pages.js';
import { tempFixture, fixture } from './helpers.js';

const scriptFile = fileURLToPath(new URL('../assets/pv-dialog.js', import.meta.url));
const quiet = { info() {}, warn() {} };

/** One raw request, so that paths reach the server as written. */
function rawRequest(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const head = text.slice(0, split).split('\r\n');
      const headers = {};
      for (const line of head.slice(1)) {
        const i = line.indexOf(':');
        headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status: Number(head[0].split(' ')[1]), headers, body: text.slice(split + 4) });
    });
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  });
}

let copy;
let running;
const get = (path, method) => rawRequest(running.port, path, method);

before(async () => {
  copy = await tempFixture();
  running = await startServer({ root: copy.root, port: 0, log: quiet });
});
after(async () => {
  await running.close();
  await copy.cleanup();
});

// ---------------------------------------------------------------------------------------------
// Fragment route

test('the fragment route returns the table of contents and the article, without layout, header or skip link', async () => {
  const res = await get('/_content/L3-modules/storage.md');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html; charset=utf-8$/);
  assert.match(res.body, /^<article class="doc">\n<nav class="page-toc"/);
  assert.match(res.body, /<h2 id="writing-tides">Writing tides<\/h2>/);
  for (const forbidden of [/<!doctype/i, /<html/i, /<head/i, /<body/i, /<header/i, /skip-link/, /<main/, /<link /, /<script/i, /site-nav/]) {
    assert.doesNotMatch(res.body, forbidden);
  }
});

test('the fragment uses the same renderer and link policy as the full page', async () => {
  const fragment = (await get('/_content/L2-architecture.md')).body;
  const page = (await get('/L2-architecture.md')).body;
  // Everything of the fragment is inside the full page, link for link.
  assert.ok(page.includes(fragment.trim()), 'the fragment is a part of the page text');
  assert.match(fragment, /href="\/L3-modules\/storage\.md#writing-tides"/);
  assert.match(fragment, /href="\.\.\/outside\.md"/, 'a link outside the root stays as written');
});

test('the fragment of a document without a title heading has a title without an id', async () => {
  await writeFile(join(copy.root, 'L3-modules', 'untitled.md'), 'Some text first.\n\n## Only section\n\nText.\n');
  const fragment = (await get('/_content/L3-modules/untitled.md')).body;
  const page = (await get('/L3-modules/untitled.md')).body;
  assert.match(page, /<h1 id="pv-title">/);
  assert.doesNotMatch(fragment, /pv-title/);
  assert.match(fragment, /<h1>[^<]+<\/h1>/);
});

test('the fragment route answers 404 for unknown, hidden, non-markdown, folder and empty paths', async () => {
  for (const path of ['/_content/', '/_content', '/_content/nope.md', '/_content/scratch/draft.md', '/_content/L3-modules/.hidden.md', '/_content/L3-modules/readme.txt', '/_content/L3-modules/', '/_content/_tree/L1-vision.md']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers['content-type'], /^text\/plain/, path);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
  }
});

test('the fragment route refuses traversal and encoded separators like the page route does', async () => {
  for (const path of ['/_content/../L1-vision.md', '/_content/%2e%2e/L1-vision.md', '/_content/L3-modules/..%2fL1-vision.md', '/_content/L1-vision.md%00', '/_content/L3-modules%5cstorage.md', '/_content//etc/passwd']) {
    const res = await get(path);
    assert.ok(res.status === 404 || res.status === 400, `${path}: ${res.status}`);
    assert.doesNotMatch(res.body, /Tidewatch|root:/, path);
  }
});

test('the fragment route carries the security headers, answers HEAD, and refuses other methods', async () => {
  const res = await get('/_content/L1-vision.md');
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['cache-control'], 'no-store');
  const head = await get('/_content/L1-vision.md', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await get('/_content/L1-vision.md', 'POST')).status, 405);
});

test('a skin query is kept in the links of a fragment', async () => {
  const res = await get('/_content/L2-architecture.md?skin=metal');
  assert.match(res.body, /href="\/L3-modules\/storage\.md\?skin=metal"/);
});

test('a file over the size limit gives a fragment with the notice and status 413', async () => {
  await writeFile(join(copy.root, 'L3-modules', 'huge.md'), `# Huge\n\n${'x'.repeat(2 * 1024 * 1024 + 10)}\n`);
  const res = await get('/_content/L3-modules/huge.md');
  assert.equal(res.status, 413);
  assert.match(res.body, /class="notice"/);
});

test('a document whose path starts with _content/ is unreachable in serve mode (known limit)', async () => {
  const fake = join(copy.root, '_content');
  await mkdir(fake, { recursive: true });
  await writeFile(join(fake, 'x.md'), '# X\n');
  assert.equal((await get('/_content/x.md')).status, 404);
});

// ---------------------------------------------------------------------------------------------
// Script file

test('the script is served as JavaScript with nosniff and the security headers', async () => {
  const res = await get('/assets/pv-dialog.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/javascript; charset=utf-8$/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(res.body, await readFile(scriptFile, 'utf8'));
  assert.equal((await get('/assets/other.js')).status, 404);
  assert.equal((await get('/assets/')).status, 404);
});

test('the script passes node --check, is short, and is a classic script (no import or export)', async () => {
  await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--check', scriptFile], (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve()));
  });
  const text = await readFile(scriptFile, 'utf8');
  assert.ok(text.split('\n').length < 450, `${text.split('\n').length} lines`);
  assert.doesNotMatch(text, /^\s*(import|export)\s/m);
  assert.doesNotMatch(text, /\beval\s*\(|new Function|document\.write|\.innerHTML\s*=(?!\s*text;)/);
});

test('the CSP allows no inline script, no eval and no other origin', async () => {
  for (const path of ['/', '/L1-vision.md', '/_content/L1-vision.md', '/assets/pv-dialog.js', '/skins/pv-base.css', '/missing']) {
    const csp = (await get(path)).headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/, path);
    assert.match(csp, /script-src 'self'(;|$)/, path);
    assert.match(csp, /connect-src 'self'(;|$)/, path);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/, path);
  }
});

// ---------------------------------------------------------------------------------------------
// Overview markup

test('the overview has the script tag and the dialog once, and the other pages have neither', async () => {
  const body = (await get('/')).body;
  assert.equal((body.match(/<script\b/g) || []).length, 1);
  assert.ok(body.includes('<script defer src="/assets/pv-dialog.js"></script>'));
  assert.equal((body.match(/<dialog\b/g) || []).length, 1);
  assert.equal((body.match(/id="pv-dialog"/g) || []).length, 1);
  assert.match(body, /data-content="\/_content"/);
  assert.doesNotMatch(body, /<template\b/, 'serve mode embeds nothing');
  for (const path of ['/L1-vision.md', '/L3-modules/storage.md', '/_tree/', '/_tree/L3-modules/storage.md']) {
    const page = (await get(path)).body;
    assert.doesNotMatch(page, /<script\b|<dialog\b/, path);
  }
});

test('bricks keep their href and gain data attributes for the document and the heading', async () => {
  const body = (await get('/')).body;
  assert.ok(body.includes('<a href="/L3-modules/index.md#reader" data-pv-doc="L3-modules/index.md" data-pv-heading="reader">Reader</a>'));
  assert.ok(body.includes('<a href="/L1-vision.md" data-pv-doc="L1-vision.md">L1 Vision</a>'), 'a brick without a heading has no heading attribute');
  assert.ok(body.includes('<a href="/adr/001-record-decisions.md" data-pv-doc="adr/001-record-decisions.md">'), 'decision records too');
  const bricks = [...body.matchAll(/<li class="(?:brick|decision)"><a ([^>]*)>/g)];
  assert.ok(bricks.length >= 15);
  for (const [, attrs] of bricks) assert.match(attrs, /^href="[^"]+" data-pv-doc="[^"]+"( data-pv-heading="[^"]+")?$/);
});

test('the dialog markup is accessible: aria-labelledby, a named title, buttons with text, ids with the pv- prefix', async () => {
  const body = (await get('/')).body;
  const dialog = body.slice(body.indexOf('<dialog'), body.indexOf('</dialog>'));
  assert.match(dialog, /<dialog id="pv-dialog" class="pv-dialog" aria-labelledby="pv-dialog-title"/);
  assert.match(dialog, /id="pv-dialog-title"/);
  const buttons = [...dialog.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)];
  assert.equal(buttons.length, 2);
  for (const [, attrs, text] of buttons) {
    assert.match(attrs, /type="button"/);
    assert.ok(text.trim().length > 0, 'button text');
  }
  assert.deepEqual(buttons.map((b) => b[2]), [STRINGS.dialogBack, STRINGS.dialogClose]);
  for (const [, id] of body.matchAll(/\sid="([^"]*)"/g)) {
    if (/^(pv-|L\d|adr|vision)/.test(id)) continue;
    assert.fail(`chrome id without prefix: ${id}`);
  }
  assert.match(dialog, /id="pv-dialog-back"[^>]*hidden/);
  assert.match(dialog, /data-loading="Loading\.\.\."/);
  assert.match(dialog, /data-error="Could not load the document\."/);
});

test('the overview has the intro line and one description line under each default layer label', async () => {
  const body = (await get('/')).body;
  assert.ok(body.includes('<p class="intro">Blurry but complete at the top, sharper with every layer down. Click a brick to read.</p>'));
  const expected = {
    L1: 'Business context, product strategy',
    L2: 'Tech stack, subsystems, data flow',
    L3: 'How each part works',
    L4: 'Git, setup, tests, day-to-day',
    adr: 'Decision records'
  };
  for (const [id, text] of Object.entries(expected)) {
    const section = body.slice(body.indexOf(`data-layer="${id}"`));
    const label = /<h3 class="layer-label" id="[^"]+">[^<]+<\/h3>\n<p class="layer-description">([^<]*)<\/p>/.exec(section);
    assert.ok(label, `description of ${id}`);
    assert.equal(label[1], text);
  }
  assert.equal((body.match(/class="layer-description"/g) || []).length, 5);
});

test('layers get a tint index in turn, and the decision block has the fifth tint', async () => {
  const body = (await get('/')).body;
  const tints = [...body.matchAll(/<section class="layer"[^>]*data-tint="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(tints, [0, 1, 2, 3]);
  assert.match(body, /<section class="decisions"[^>]*data-tint="4"/);
});

test('layers without a default description, and without one in the config, show no description line', async () => {
  const root = join(copy.base, 'plain-docs');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'L7-extras.md'), '# Extras\n\n## One\n\nText.\n');
  await writeFile(join(root, 'L2-architecture.md'), '# Arch\n\n## Two\n\nText.\n');
  const pyramid = await loadPyramid(root);
  const html = renderOverviewPage({ pyramid, links: stubLinks() });
  assert.equal((html.match(/class="layer-description"/g) || []).length, 1, 'only L2 has one');
  assert.match(html, /data-layer="L2"[\s\S]*?layer-description">Tech stack, subsystems, data flow/);
});

function stubLinks() {
  return {
    overview: () => 'index.html',
    doc: (view, path, fragment) => `${path}${fragment ? `#${fragment}` : ''}`,
    styles: () => ['skins/light.css'],
    script: () => 'assets/pv-dialog.js',
    contentBase: () => '/_content'
  };
}

test('a description from pyramid.json is shown and escaped, and a non-string is an error', async () => {
  const root = join(copy.base, 'config-docs');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.md'), '# A\n\n## Part\n\nText.\n');
  const layer = { id: 'L1', label: 'One', path: 'a.md', kind: 'file', description: '<script>alert(1)</script> & "quoted"' };
  const pyramid = await loadPyramid(root, { layers: [layer] });
  const html = renderOverviewPage({ pyramid, links: stubLinks() });
  assert.ok(html.includes('<p class="layer-description">&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;</p>'));
  assert.doesNotMatch(html.replace('<script defer src="assets/pv-dialog.js"></script>', ''), /<script>alert/);
  await assert.rejects(loadPyramid(root, { layers: [{ ...layer, description: 5 }] }), /"description" must be a string/);
  // A config layer named L1 gets no default description: only an explicit one counts.
  const bare = await loadPyramid(root, { layers: [{ id: 'L1', label: 'One', path: 'a.md', kind: 'file' }] });
  assert.doesNotMatch(renderOverviewPage({ pyramid: bare, links: stubLinks() }), /layer-description/);
});

test('without a script URL in the links the overview has no dialog and no script', async () => {
  const pyramid = await loadPyramid(copy.root);
  const links = stubLinks();
  delete links.script;
  const html = renderOverviewPage({ pyramid, links });
  assert.doesNotMatch(html, /<script|<dialog/);
  assert.match(renderDocumentPage({ pyramid, path: 'L1-vision.md', source: '# V\n', links }), /^<!doctype html>/);
  assert.doesNotMatch(renderDocumentFragment({ pyramid, path: 'L1-vision.md', source: '# V\n', links }), /<html|<body/);
});

// ---------------------------------------------------------------------------------------------
// The pure logic of the script, run in a sandbox without a DOM

function loadLogic() {
  const sandbox = { URL, document: undefined };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(scriptFile, 'utf8'), sandbox, { filename: 'pv-dialog.js' });
  assert.ok(sandbox.pvDialogLogic, 'the script exposes its logic');
  return sandbox.pvDialogLogic;
}

test('script logic: splitUrl resolves links between document URLs, with and without fragments', () => {
  const { splitUrl } = loadLogic();
  const a = splitUrl('../L4-operations/runbook.html#restart-the-reader', 'file:///out/L3-modules/storage.html');
  assert.equal(a.url, 'file:///out/L4-operations/runbook.html');
  assert.equal(a.hash, 'restart-the-reader');
  const b = splitUrl('/L3-modules/storage.md#%C3%BCber', 'http://127.0.0.1:4000/L2-architecture.md?skin=metal');
  assert.equal(b.url, 'http://127.0.0.1:4000/L3-modules/storage.md');
  assert.equal(b.hash, 'über');
  assert.equal(b.pathname, '/L3-modules/storage.md');
  const c = splitUrl('storage.md?skin=metal', 'http://127.0.0.1:4000/L3-modules/index.md');
  assert.equal(c.search, '?skin=metal');
  assert.equal(c.hash, '');
  assert.equal(splitUrl('http://[bad', 'http://x/'), null);
  assert.equal(splitUrl('https://example.org/x#y', 'http://x/').origin, 'https://example.org');
  assert.equal(splitUrl('#%E0%A4%A', 'http://x/a.md').hash, '%E0%A4%A', 'a bad escape keeps the raw fragment');
});

test('script logic: a plain click is a left click without modifier keys', () => {
  const { isPlainClick } = loadLogic();
  const click = (extra) => ({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...extra });
  assert.equal(isPlainClick(click()), true);
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }]) {
    assert.equal(isPlainClick(click(extra)), false, JSON.stringify(extra));
  }
});

test('script logic: the history stack pops in reverse order and clears', () => {
  const { createHistory } = loadLogic();
  const h = createHistory();
  assert.equal(h.size(), 0);
  assert.equal(h.pop(), null);
  h.push({ url: 'a', top: 1 });
  h.push({ url: 'b', top: 2 });
  assert.equal(h.size(), 2);
  assert.deepEqual(h.pop(), { url: 'b', top: 2 });
  assert.deepEqual(h.pop(), { url: 'a', top: 1 });
  assert.equal(h.pop(), null);
  h.push({ url: 'c', top: 0 });
  h.clear();
  assert.equal(h.size(), 0);
});

test('script logic: the fragment route URL is built from the page path and query', () => {
  const { splitUrl, contentUrl } = loadLogic();
  const s = splitUrl('/L3-modules/storage.md?skin=metal#x', 'http://127.0.0.1:4000/');
  assert.equal(contentUrl('/_content', s), '/_content/L3-modules/storage.md?skin=metal');
  assert.equal(contentUrl('/_content/', s), '/_content/L3-modules/storage.md?skin=metal');
});

test('the script does nothing and does not fail on a page without the dialog', () => {
  const sandbox = { URL, document: { getElementById: () => null } };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(scriptFile, 'utf8'), sandbox);
  assert.ok(sandbox.pvDialogLogic);
});

test('script logic: findById compares ids as plain strings, so control characters and quotes cannot throw', () => {
  const { findById } = loadLogic();
  const list = [{ id: 'a' }, { id: 'say "hi"' }, { id: 'new\nline' }, { id: 'back\\slash' }];
  assert.equal(findById(list, 'a'), list[0]);
  assert.equal(findById(list, 'say "hi"'), list[1]);
  assert.equal(findById(list, '\n'), null);
  assert.equal(findById(list, 'new\nline'), list[2]);
  assert.equal(findById(list, 'back\\slash'), list[3]);
  assert.equal(findById(list, ''), null);
  assert.equal(findById(list, 'missing'), null);
});

test('script logic: a backdrop click closes only after a press on the backdrop and not right after opening', () => {
  const { backdropCloses } = loadLogic();
  const dlg = {};
  const inner = {};
  const base = { target: dlg, downTarget: dlg, dialog: dlg, openedAt: 1000, now: 2000 };
  assert.equal(backdropCloses(base), true);
  assert.equal(backdropCloses({ ...base, target: inner }), false, 'a click inside the dialog');
  assert.equal(backdropCloses({ ...base, downTarget: inner }), false, 'a text selection that ends on the backdrop');
  assert.equal(backdropCloses({ ...base, downTarget: null }), false, 'a press that started outside the page');
  assert.equal(backdropCloses({ ...base, now: 1200 }), false, 'the second click of a double click on a brick');
  assert.equal(backdropCloses({ ...base, now: 1400 }), true, 'after the guard time');
});

test('script logic: the label of a link is its trimmed text, for the title while loading', () => {
  const { linkLabel } = loadLogic();
  assert.equal(linkLabel({ textContent: '  Reader \n ' }), 'Reader');
  assert.equal(linkLabel(null), '');
});

test('the script keeps the dialog usable: refocus after Back, no cleanup of a reopened dialog, absolute hrefs for foreign links', () => {
  const text = readFileSync(scriptFile, 'utf8');
  assert.match(text, /back\.addEventListener\('click', \(\) => \{[\s\S]*?body\.focus\(/, 'Back refocuses the body');
  assert.match(text, /addEventListener\('close', \(\) => \{(?:\s*\/\/[^\n]*)*\s*if \(dialog\.open\) return;/, 'a close event for a reopened dialog is ignored');
  assert.match(text, /a\.setAttribute\('href', s\.url/, 'a link the script does not take over gets an absolute href');
  assert.doesNotMatch(text, /querySelector\('\[id=/, 'no selector is built from a document id');
});

// ---------------------------------------------------------------------------------------------
// Left navigation, tint and animation

test('the dialog has a left navigation landmark with a label, hidden until a document fills it, beside the scrolling body', async () => {
  const body = (await get('/')).body;
  const dialog = body.slice(body.indexOf('<dialog'), body.indexOf('</dialog>'));
  assert.match(dialog, /<div class="pv-dialog-main">\s*<nav id="pv-dialog-toc" class="pv-dialog-toc" aria-label="On this page" hidden><\/nav>\s*<div id="pv-dialog-body" class="pv-dialog-body" tabindex="-1"><\/div>/);
});

test('script logic: the current heading follows the scroll position, with the first at the top and the last at the bottom', () => {
  const { currentHeadingIndex } = loadLogic();
  const heading = (top) => ({ getBoundingClientRect: () => ({ top }) });
  const container = (scrollTop, clientHeight, scrollHeight, top = 100) => ({ scrollTop, clientHeight, scrollHeight, getBoundingClientRect: () => ({ top }) });
  const hs = [heading(100), heading(120), heading(900)];
  assert.equal(currentHeadingIndex([], container(0, 500, 2000), 24), -1);
  assert.equal(currentHeadingIndex(hs, container(0, 500, 2000), 24), 0, 'at the top');
  assert.equal(currentHeadingIndex(hs, container(300, 500, 2000), 24), 1, 'the heading at 120 is above the line at 124, the one at 900 is not');
  assert.equal(currentHeadingIndex([heading(90), heading(124), heading(125)], container(50, 500, 2000), 24), 1, 'a heading exactly on the line counts, one pixel below does not');
  assert.equal(currentHeadingIndex(hs, container(1500, 500, 2000), 24), 2, 'at the bottom the last heading');
  assert.equal(currentHeadingIndex([heading(500), heading(900)], container(50, 500, 2000), 24), 0, 'before the first heading the first one');
});

test('script logic: the scroll target ignores the scale of the opening animation', () => {
  const { scrollTopFor } = loadLogic();
  const el = (top) => ({ getBoundingClientRect: () => ({ top }) });
  const box = (top, height, offsetHeight, scrollTop) => ({ scrollTop, offsetHeight, getBoundingClientRect: () => ({ top, height }) });
  assert.equal(scrollTopFor(el(300), box(100, 600, 600, 1000)), 1200, 'unscaled');
  // Scaled to 0.96: the element is 200 layout pixels below the top, which is 192 on screen.
  assert.ok(Math.abs(scrollTopFor(el(292), box(100, 576, 600, 1000)) - 1200) < 1e-9, 'scaled');
  assert.equal(scrollTopFor(el(300), { scrollTop: 0, getBoundingClientRect: () => ({ top: 100 }) }), 200, 'no layout size known');
});

test('script logic: the dialog arrives from the side of the brick, at most 24 pixels each way', () => {
  const logic = loadLogic();
  const fromOffset = (...args) => JSON.parse(JSON.stringify(logic.fromOffset(...args)));
  assert.deepEqual(fromOffset({ left: 590, top: 390, width: 100, height: 20 }, 1280, 800), { x: 0, y: 0 });
  assert.deepEqual(fromOffset({ left: 0, top: 0, width: 100, height: 20 }, 1280, 800), { x: -24, y: -24 });
  assert.deepEqual(fromOffset({ left: 1180, top: 780, width: 100, height: 20 }, 1280, 800), { x: 24, y: 24 });
  assert.equal(fromOffset({ left: 690, top: 400, width: 100, height: 20 }, 1280, 800).x, 8);
});

test('the dialog script opens and closes with the animation hooks the stylesheet knows', () => {
  const text = readFileSync(scriptFile, 'utf8');
  assert.match(text, /setAttribute\('data-closing'/);
  assert.match(text, /animationend/);
  assert.match(text, /setTimeout\(finishClose, 250\)/);
  assert.match(text, /setAttribute\('aria-current', 'location'\)/);
  assert.match(text, /setAttribute\('data-tint'/);
  assert.doesNotMatch(text, /addEventListener\('cancel'/, 'Escape keeps its instant native behaviour');
  assert.match(text, /prefers-reduced-motion: reduce/);
});

test('script logic: refreshApplies matches the open document against the changed paths', () => {
  const { refreshApplies } = loadLogic();
  assert.equal(refreshApplies('/L3-modules/storage.md', { paths: ['L3-modules/storage.md'] }), true);
  assert.equal(refreshApplies('/L3-modules/storage.md', { paths: ['L2-architecture.md'] }), false);
  assert.equal(refreshApplies('/L3-modules/storage.md', { paths: [], many: true }), true);
  assert.equal(refreshApplies('/L3-modules/storage.md', undefined), true);
  assert.equal(refreshApplies('/a%20b/c.md', { paths: ['a b/c.md'] }), true);
});

test('the site name links home on document pages and is left out on the overview, where it would repeat the title', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'pv-home-'));
  await writeFile(join(dir, 'L1-vision.md'), '# Vision\n\nWhat it is.\n');
  const pyramid = await loadPyramid(dir);
  const links = { overview: () => 'index.html', doc: (v, p) => p, styles: () => ['a.css'] };
  for (const view of ['pyramid', 'tree']) {
    assert.doesNotMatch(renderOverviewPage({ pyramid, links, view }), /class="site-name"/);
  }
  assert.match(renderDocumentPage({ pyramid, path: 'L1-vision.md', source: '# Vision\n', links }), /class="site-name" href="index.html"/);
});
