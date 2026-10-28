// AC 4 (tree view), AC 5 (serve mode), AC 6 (headers) and AC 11 (landmarks).
// The tests start the real server on port 0 and talk to it over a plain socket, so request paths reach the
// server exactly as written (no client-side clean-up of "..").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, readFile, symlink, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../viewer.js';
import { tempFixture, fixture } from './helpers.js';

const viewerFile = fileURLToPath(new URL('../viewer.js', import.meta.url));

/** Send one raw HTTP request and parse the answer. */
function rawRequest(port, path, method = 'GET', host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
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
let outside;
let running;
let port;
const get = (path) => rawRequest(port, path);

/** The tree index nav of a page. */
function treeIndexOf(body) {
  const start = body.indexOf('<nav class="tree"');
  assert.ok(start !== -1, 'page has no tree index');
  return body.slice(start, body.indexOf('</nav>', start));
}

before(async () => {
  copy = await tempFixture();
  outside = await mkdtemp(join(tmpdir(), 'pv-outside-'));
  await writeFile(join(outside, 'secret.md'), '# Secret\n\nOutside text.\n');
  await symlink(join(outside, 'secret.md'), join(copy.root, 'L3-modules', 'leak.md'));
  await symlink(outside, join(copy.root, 'linkdir'));
  running = await startServer({ root: copy.root, port: 0, log: { info() {}, warn() {} } });
  port = running.port;
});

after(async () => {
  await running.close();
  await copy.cleanup();
  await rm(outside, { recursive: true, force: true });
});

const DOCS = [
  'L1-vision.md',
  'L2-architecture.md',
  'L3-modules/index.md',
  'L3-modules/storage.md',
  'L3-modules/notes.md',
  'L3-modules/crlf.md',
  'L4-operations/index.md',
  'L4-operations/runbook.md',
  'adr/001-record-decisions.md',
  'adr/002-plain-markdown.md',
  'adr/003-use-ids.md'
];

test('startServer reports the real port when asked for port 0, bound to 127.0.0.1', () => {
  assert.ok(port > 0);
  assert.equal(running.host, '127.0.0.1');
  assert.equal(running.server.address().address, '127.0.0.1');
});

test('the overview returns 200 with the pyramid view and real links', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html; charset=utf-8/);
  assert.match(res.body, /<html lang="en">/);
  assert.match(res.body, /<a class="skip-link" href="#pv-main">/);
  assert.match(res.body, /href="\/L3-modules\/index\.md#reader"/);
  assert.match(res.body, /href="\/_tree\/"/); // the view switch
});

for (const doc of DOCS) {
  test(`document ${doc} returns 200 in both views`, async () => {
    const pyramidView = await get(`/${doc}`);
    assert.equal(pyramidView.status, 200);
    const treeView = await get(`/_tree/${doc}`);
    assert.equal(treeView.status, 200);
  });
}

test('every page has nav, main and article landmarks, one h1 and a stylesheet link', async () => {
  for (const path of ['/', '/_tree/', ...DOCS.map((d) => `/${d}`), ...DOCS.map((d) => `/_tree/${d}`)]) {
    const { body } = await get(path);
    assert.match(body, /<nav /, path);
    assert.match(body, /<main /, path);
    assert.match(body, /<article /, path);
    assert.equal((body.match(/<h1[ >]/g) || []).length, 1, `${path} must have one h1`);
    assert.match(body, /<link rel="stylesheet" href="\/skins\/pv-base\.css">\n<link rel="stylesheet" href="\/skins\/light\.css">\n/, path);
    assert.match(body, /<body class="view-(pyramid|tree)" data-skin="light">/, path);
    assert.match(body, /<meta name="viewport"/, path);
    assert.match(body, /<meta charset="utf-8">/, path);
  }
});

test('the document page has a page table of contents whose targets exist as ids', async () => {
  const { body } = await get('/L2-architecture.md');
  assert.match(body, /<nav class="page-toc" aria-label="On this page">/);
  const targets = [...body.matchAll(/<li class="toc-level-\d"><a href="#([^"]+)">/g)].map((m) => decodeURIComponent(m[1]));
  assert.ok(targets.length > 5);
  for (const id of targets) assert.ok(body.includes(`id="${id}"`), `missing id ${id}`);
  assert.ok(targets.includes('overview') && targets.includes('overview-1'));
});

test('relative links in a document follow the link policy in the server', async () => {
  const { body } = await get('/L2-architecture.md');
  assert.match(body, /href="\/L3-modules\/storage\.md"/);
  assert.match(body, /href="\/L3-modules\/index\.md"/); // folder link goes to the index file
  assert.match(body, /href="\/L3-modules\/storage\.md#writing-tides"/);
  assert.match(body, /href="\.\.\/outside\.md"/); // outside the root: left alone
  assert.match(body, /href="https:\/\/example\.org\/tides"/);
});

test('the overview groups the decision records apart from the growing rows', async () => {
  const { body } = await get('/');
  const decisions = body.indexOf('class="decisions"');
  assert.ok(decisions > body.lastIndexOf('class="layer"'));
  assert.match(body.slice(decisions), /003-use-ids\.md/);
  assert.doesNotMatch(body.slice(0, decisions), /003-use-ids\.md/);
});

test('bricks are real links in a list per layer with a visible layer label', async () => {
  const { body } = await get('/');
  const layers = body.split('<section class="layer"').slice(1);
  assert.ok(layers.length >= 3);
  for (const layer of layers) {
    assert.match(layer, /<h3 class="layer-label" id="pv-layer-[^"]+">[^<]+<\/h3>/);
    assert.match(layer, /<ul class="rows">/);
    assert.match(layer, /<li class="brick"><a href="\//);
  }
});

// -- Tree view ---------------------------------------------------------------------------------

test('the tree index lists layers, files in order and their ## headings, with real links', async () => {
  const { body } = await get('/_tree/L3-modules/storage.md');
  const index = treeIndexOf(body);
  assert.match(index, /<details class="tree-toggle">\s*<summary>/);
  // a document that carries its layer's title is the layer heading itself, so files are layer-label links or file entries
  const files = [...index.matchAll(/<(?:li class="tree-file"|p class="layer-label")><a href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(files.filter((f) => f.startsWith('/_tree/L3-modules/')), [
    '/_tree/L3-modules/index.md',
    '/_tree/L3-modules/storage.md',
    '/_tree/L3-modules/notes.md',
    '/_tree/L3-modules/crlf.md'
  ].sort((a, b) => files.indexOf(a) - files.indexOf(b)));
  assert.ok(files.indexOf('/_tree/L3-modules/index.md') < files.indexOf('/_tree/L3-modules/storage.md'));
  assert.ok(files.indexOf('/_tree/L1-vision.md') < files.indexOf('/_tree/L2-architecture.md'));
  assert.ok(files.indexOf('/_tree/L2-architecture.md') < files.indexOf('/_tree/L3-modules/index.md'));
  assert.match(index, /<a href="\/_tree\/L3-modules\/index\.md\?at=reader#reader">Reader<\/a>/);
  assert.match(index, /ADRs/);
  for (const href of [...index.matchAll(/href="([^"]+)"/g)].map((m) => m[1])) assert.ok(href.startsWith('/_tree/'), href);
});

test('the current entry carries aria-current and the document is the right pane', async () => {
  const { body } = await get('/_tree/L3-modules/storage.md');
  const current = [...body.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((m) => m[1]);
  assert.deepEqual(current, ['/_tree/L3-modules/storage.md']);
  assert.match(body.slice(body.indexOf('<main')), /<h1 id="storage">/);
});

/** Find a level 2 heading with level 3 children in the fixture, through the served markdown. */
test('### headings appear only under the open ## heading (depth 3)', async () => {
  const plain = await get('/_tree/L2-architecture.md');
  assert.doesNotMatch(plain.body, /tree-subheadings/); // nothing open yet
  const open = await get('/_tree/L2-architecture.md?at=data-flow');
  const index = treeIndexOf(open.body);
  assert.equal((index.match(/<ul class="tree-subheadings">/g) || []).length, 1);
  assert.match(index, /<a href="\/_tree\/L2-architecture\.md\?at=data-flow#data-flow" aria-current="location">Data flow<\/a>/);
  const subs = index.slice(index.indexOf('<ul class="tree-subheadings">'));
  assert.match(subs, /Ingest/);
  assert.match(subs, /Publish/);
  // the ### entries sit inside the "Data flow" item, not inside another one
  const before = index.slice(0, index.indexOf('<ul class="tree-subheadings">'));
  assert.ok(before.lastIndexOf('>Data flow<') > before.lastIndexOf('>Overview<'));
});

test('a ### heading as current entry opens its parent ##', async () => {
  const { body } = await get('/_tree/L2-architecture.md?at=ingest');
  const index = treeIndexOf(body);
  assert.match(index, /aria-current="location">Ingest</);
  assert.match(index, /Publish/);
});

test('an unknown "at" value opens nothing', async () => {
  const { body } = await get('/_tree/L2-architecture.md?at=no-such-heading');
  assert.doesNotMatch(body, /tree-subheadings/);
  assert.doesNotMatch(body, /aria-current="location"/);
});

test('depth 2 never lists ### headings', async () => {
  const two = await startServer({ root: copy.root, port: 0, depth: 2, log: { info() {}, warn() {} } });
  try {
    const { body } = await rawRequest(two.port, '/_tree/L2-architecture.md?at=data-flow');
    assert.doesNotMatch(body, /tree-subheadings/);
    assert.doesNotMatch(treeIndexOf(body), />Ingest</);
    assert.match(treeIndexOf(body), />Data flow</);
  } finally {
    await two.close();
  }
});

test('the tree view opens on the first document, with the index beside it', async () => {
  const { status, body } = await get('/_tree/');
  assert.equal(status, 200);
  assert.doesNotMatch(body, /Choose a document from the index/);
  assert.deepEqual([...body.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((m) => m[1]), ['/_tree/L1-vision.md']);
  assert.match(body.slice(body.indexOf('<main')), /<h1 /);
  assert.equal((await get('/_tree')).status, 200);
});

// -- Safety ------------------------------------------------------------------------------------

const BAD_PATHS = [
  ['unknown path', '/nothing-here.md'],
  ['non-markdown file', '/L3-modules/readme.txt'],
  ['unlisted folder', '/scratch/draft.md'],
  ['dotfile', '/L3-modules/.hidden.md'],
  ['dot dot', '/../outside.md'],
  ['dot dot deep', '/L3-modules/../../etc/passwd'],
  ['encoded dot dot', '/%2e%2e/%2e%2e/etc/passwd'],
  ['encoded dot dot upper', '/%2E%2E/secret.md'],
  ['encoded slash', '/L3-modules%2fstorage.md'],
  ['encoded backslash', '/L3-modules%5cstorage.md'],
  ['null byte', '/L1-vision.md%00'],
  ['null byte inside', '/L1-vision%00.md'],
  ['absolute path', '//etc/passwd'],
  ['absolute path with scheme', '/file:///etc/passwd'],
  ['backslashes', '/..\\..\\etc\\passwd'],
  ['backslash in name', '/L3-modules\\storage.md'],
  ['double encoded', '/%252e%252e/secret.md'],
  ['malformed escape', '/%zz.md'],
  ['symlink to a file outside', '/L3-modules/leak.md'],
  ['symlink to a folder outside', '/linkdir/secret.md'],
  ['symlink in tree view', '/_tree/L3-modules/leak.md'],
  ['traversal in tree view', '/_tree/../outside.md'],
  ['encoded traversal in tree view', '/_tree/%2e%2e/secret.md'],
  ['skin file traversal', '/skins/..%2fviewer.js'],
  ['skin file with other extension', '/skins/light.js'],
  ['the plain skin has no file, it is an alias', '/skins/plain.css'],
  ['user tokens route without --tokens', '/_pv/tokens.css'],
  ['skin name not known', '/skins/other.css'],
  ['folder', '/L3-modules/'],
  ['favicon', '/favicon.ico']
];
for (const [name, path] of BAD_PATHS) {
  test(`404 for ${name}`, async () => {
    const res = await get(path);
    assert.equal(res.status, 404, `${path} gave ${res.status}`);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-type'], /^text\/plain/);
    assert.ok(!res.body.includes('Secret'));
    assert.ok(!res.body.includes('Outside text'));
  });
}

test('a raw null byte in the request line never reads a file (400 or 404)', async () => {
  const res = await get('/L1-vision.md\u0000');
  assert.ok([400, 404].includes(res.status), String(res.status));
  assert.ok(!res.body.includes('Tidewatch'));
});

test('the symlinked file is not listed in the overview or the tree', async () => {
  for (const path of ['/', '/_tree/']) {
    const { body } = await get(path);
    assert.doesNotMatch(body, /leak\.md/);
    assert.doesNotMatch(body, /Secret/);
  }
});

for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
  test(`${method} gives 405 with an Allow header`, async () => {
    const res = await rawRequest(port, '/', method);
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, HEAD');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });
}

test('HEAD answers with headers and no body', async () => {
  const res = await rawRequest(port, '/L1-vision.md', 'HEAD');
  assert.equal(res.status, 200);
  assert.equal(res.body, '');
  assert.ok(Number(res.headers['content-length']) > 0);
});

test('every kind of response carries Content-Security-Policy and nosniff', async () => {
  const paths = ['/', '/_tree/', '/L1-vision.md', '/skins/light.css', '/skins/pv-base.css', '/missing.md', '/skins/metal.css'];
  for (const path of paths) {
    const res = await get(path);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/, path);
    assert.match(res.headers['content-security-policy'], /style-src 'self'/, path);
    // No inline script: script comes from this server only, and nothing allows unsafe-inline or eval.
    assert.match(res.headers['content-security-policy'], /script-src 'self'(;|$)/, path);
    assert.doesNotMatch(res.headers['content-security-policy'], /unsafe-inline|unsafe-eval|\*|https?:/, path);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
  }
  const post = await rawRequest(port, '/', 'POST');
  assert.match(post.headers['content-security-policy'], /default-src 'none'/);
});

test('titles and paths with HTML characters are escaped in pages', async () => {
  await mkdir(join(copy.root, 'L4-operations'), { recursive: true });
  const name = 'a&b"c.md';
  await writeFile(join(copy.root, 'L4-operations', name), '## <b>x</b>\n\nText.\n');
  // The new file is not the index of its folder, so it makes no brick; the tree view lists it.
  const { body } = await get('/_tree/');
  assert.doesNotMatch(body, /<b>x<\/b>/);
  assert.match(body, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(body, /a&b"c/);
  assert.match(body, /a%26b%22c\.md/);
  const doc = await get('/L4-operations/a%26b%22c.md');
  assert.equal(doc.status, 200);
  assert.match(doc.body, /<title>A&amp;b&quot;c - /);
  await rm(join(copy.root, 'L4-operations', name));
});

test('script payloads in documents do not reach the page as markup', async () => {
  await writeFile(join(copy.root, 'L1-vision.md'), '# Vision\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n');
  const { body } = await get('/L1-vision.md');
  assert.doesNotMatch(body, /<script/i);
  assert.doesNotMatch(body, /href="javascript:/i);
});

// -- Live reading ------------------------------------------------------------------------------

test('a file edited on disk shows up on the next request', async () => {
  const path = join(copy.root, 'L2-architecture.md');
  const original = await readFile(path, 'utf8');
  try {
    assert.doesNotMatch((await get('/L2-architecture.md')).body, /Brand new section/);
    await writeFile(path, `${original}\n## Brand new section\n\nFresh text.\n`);
    const after = await get('/L2-architecture.md');
    assert.match(after.body, /Brand new section/);
    assert.match((await get('/')).body, /Brand new section/); // a new brick appears too
    assert.match((await get('/_tree/L2-architecture.md')).body, /Brand new section/);
  } finally {
    await writeFile(path, original);
  }
});

test('a new file and a deleted file are noticed without a restart', async () => {
  const path = join(copy.root, 'L4-operations', 'added.md');
  await writeFile(path, '# Added\n\n## Added brick\n');
  assert.equal((await get('/L4-operations/added.md')).status, 200);
  await rm(path);
  assert.equal((await get('/L4-operations/added.md')).status, 404);
});

test('a file over 2 MB gets a clear message instead of being read', async () => {
  const path = join(copy.root, 'L4-operations', 'huge.md');
  await writeFile(path, `# Huge\n\n${'x'.repeat(2 * 1024 * 1024 + 10)}\n`);
  try {
    const res = await get('/L4-operations/huge.md');
    assert.equal(res.status, 413);
    assert.match(res.body, /larger than 2 MB and is not shown/);
    assert.ok(res.body.length < 20000);
    assert.equal((await get('/')).status, 200); // the overview still works
  } finally {
    await rm(path);
  }
});

// -- Skins -------------------------------------------------------------------------------------

test('the base stylesheet and the light theme are served as CSS', async () => {
  for (const [path, token] of [['/skins/pv-base.css', /var\(--pv-bg\)/], ['/skins/light.css', /--pv-bg:/], ['/skins/metal.css', /--pv-bg:/]]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers['content-type'], /^text\/css/, path);
    assert.match(res.body, token, path);
  }
});

test('?skin=metal switches only the stylesheet link and keeps the skin while browsing', async () => {
  const light = (await get('/L1-vision.md')).body;
  const metal = (await get('/L1-vision.md?skin=metal')).body;
  assert.match(metal, /href="\/skins\/pv-base\.css"/);
  assert.match(metal, /href="\/skins\/metal\.css"/);
  const noSwitch = (html) => html.replace(/<nav class="skin-switch"[\s\S]*?<\/nav>\n/, '');
  assert.match(metal, /href="\/skins\/metal-fonts\.css"/);
  assert.equal(noSwitch(metal).replace('<link rel="stylesheet" href="/skins/metal-fonts.css">\n', '').replace('/skins/metal.css', '/skins/light.css').replace('data-skin="metal"', 'data-skin="light"').replace(/\?skin=metal/g, ''), noSwitch(light));
  assert.match((await get('/?skin=metal')).body, /href="\/L1-vision\.md\?skin=metal"/);
});

test('an unknown skin name falls back to light and is never echoed', async () => {
  const body = (await get('/?skin=bogus')).body;
  assert.match(body, /href="\/skins\/light\.css"/);
  assert.doesNotMatch(body, /bogus/);
});

test('?skin=plain is an alias of light: the same page, and links carry the canonical name', async () => {
  const alias = (await get('/?skin=plain')).body;
  const light = (await get('/?skin=light')).body;
  assert.equal(alias, light);
  assert.match(alias, /href="\/skins\/light\.css"/);
  assert.doesNotMatch(alias, /skin=plain/);
  assert.match(alias, /href="\/L1-vision\.md\?skin=light"/);
});

test('the --skin option accepts plain as another name for light', async () => {
  const aliased = await startServer({ root: fixture('pyramid'), port: 0, skin: 'plain', log: { info() {}, warn() {} } });
  try {
    const { body } = await rawRequest(aliased.port, '/');
    assert.match(body, /href="\/skins\/light\.css"/);
    assert.match(body, /data-skin="light"/);
  } finally {
    await aliased.close();
  }
});

test('the --skin default applies without a query', async () => {
  const metalDefault = await startServer({ root: fixture('pyramid'), port: 0, skin: 'metal', log: { info() {}, warn() {} } });
  try {
    const { body } = await rawRequest(metalDefault.port, '/');
    assert.match(body, /href="\/skins\/metal\.css"/);
    assert.doesNotMatch(body.replace(/<nav class="skin-switch"[\s\S]*?<\/nav>/, ''), /\?skin=/); // nothing was chosen in the URL, so links stay clean
  } finally {
    await metalDefault.close();
  }
});

// -- Start and stop ----------------------------------------------------------------------------

test('a busy port gives a clear message', async () => {
  await assert.rejects(
    startServer({ root: copy.root, port, log: { info() {}, warn() {} } }),
    (error) => error.code === 'EADDRINUSE' && /already in use/.test(error.message) && error.message.includes(String(port))
  );
});

test('a missing docs folder fails before listening', async () => {
  await assert.rejects(startServer({ root: join(copy.base, 'nope'), port: 0 }), /Docs folder not found/);
});

test('an unknown skin or invalid port is refused', async () => {
  await assert.rejects(startServer({ root: copy.root, port: 0, skin: 'gold' }), /Valid skins: light, metal \(plain is also accepted\)/);
  await assert.rejects(startServer({ root: copy.root, port: 70000 }), /Invalid port/);
});

test('another host prints a warning, the default does not', async () => {
  const messages = [];
  const log = { info() {}, warn: (m) => messages.push(m) };
  const quiet = await startServer({ root: copy.root, port: 0, log });
  await quiet.close();
  assert.deepEqual(messages, []);
  const open = await startServer({ root: copy.root, port: 0, host: '0.0.0.0', log });
  await open.close();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Warning: listening on 0\.0\.0\.0/);
});

test('SIGINT closes the server cleanly (exit code 0)', async () => {
  const code = `import('${new URL('../viewer.js', import.meta.url).href}').then((m) => m.runServe({ root: ${JSON.stringify(fixture('pyramid'))}, port: 0 }))`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  while (!/Serving .* at http:\/\/127\.0\.0\.1:(\d+)\//.test(out)) {
    if (child.exitCode !== null) assert.fail(`child ended early: ${out} ${err}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  const childPort = Number(/127\.0\.0\.1:(\d+)\//.exec(out)[1]);
  assert.equal((await rawRequest(childPort, '/')).status, 200);
  child.kill('SIGINT');
  const [exitCode, signal] = await once(child, 'exit');
  assert.equal(signal, null);
  assert.equal(exitCode, 0);
  assert.match(out, /Stopped\./);
  assert.equal(err, '');
});

// -- User tokens -------------------------------------------------------------------------------

test('--tokens: the route serves the file read fresh on every request, the page links it last, and a missing file gives a 404 with the page intact', async () => {
  const tokens = join(copy.base, 'tokens.css');
  await writeFile(tokens, ':root { --pv-bg: #111111; }\n');
  const withTokens = await startServer({ root: fixture('pyramid'), port: 0, skin: 'metal', tokensFile: tokens, log: { info() {}, warn() {} } });
  try {
    const page = await rawRequest(withTokens.port, '/');
    assert.match(page.body, /<link rel="stylesheet" href="\/skins\/pv-base\.css">\n<link rel="stylesheet" href="\/skins\/metal\.css">\n<link rel="stylesheet" href="\/skins\/metal-fonts\.css">\n<link rel="stylesheet" href="\/_pv\/tokens\.css">\n/);
    let res = await rawRequest(withTokens.port, '/_pv/tokens.css');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/css; charset=utf-8/);
    assert.match(res.headers['content-security-policy'], /style-src 'self'/);
    assert.match(res.body, /#111111/);
    await writeFile(tokens, ':root { --pv-bg: #222222; }\n');
    assert.match((await rawRequest(withTokens.port, '/_pv/tokens.css')).body, /#222222/);
    await rm(tokens);
    res = await rawRequest(withTokens.port, '/_pv/tokens.css');
    assert.equal(res.status, 404);
    assert.match(res.body, /tokens file is not available/);
    assert.ok(!res.body.includes(copy.base) && !res.body.includes('tokens.css"'), 'no local path in the body');
    assert.equal((await rawRequest(withTokens.port, '/')).status, 200);
    assert.equal((await rawRequest(withTokens.port, '/_pv/other.css')).status, 404);
  } finally {
    await withTokens.close();
  }
});

test('--tokens: an unusable file is refused at start', async () => {
  await assert.rejects(startServer({ root: fixture('pyramid'), port: 0, tokensFile: join(copy.base, 'absent.css') }), /--tokens: the file ".*absent\.css" does not exist\./);
});

// -- Skin switcher, cookie and tokens route ----------------------------------------------------

/** A raw request that can carry a Cookie header. */
function requestWithCookie(port, path, cookie) {
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
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}Connection: close\r\n\r\n`);
  });
}

const switcherOf = (body) => (/<nav class="skin-switch"[\s\S]*?<\/nav>/.exec(body) || [''])[0];

test('the skin switcher: two text links after the site nav, the current one marked, keeping the page and the open section', async () => {
  const nav = switcherOf((await get('/')).body);
  assert.match(nav, /aria-label="Skin"/);
  assert.match(nav, /<a href="\/\?skin=light" aria-current="true">Light<\/a>/);
  assert.match(nav, /<a href="\/\?skin=metal">Metal<\/a>/);
  assert.equal((nav.match(/aria-current/g) || []).length, 1);
  const page = (await get('/_tree/L3-modules/storage.md?at=writing-tides&skin=metal')).body;
  assert.match(switcherOf(page), /href="\/_tree\/L3-modules\/storage\.md\?at=writing-tides&amp;skin=light"/);
  assert.match(switcherOf(page), /href="\/_tree\/L3-modules\/storage\.md\?at=writing-tides&amp;skin=metal" aria-current="true"/);
  assert.ok(page.indexOf('class="site-nav"') < page.indexOf('class="skin-switch"'));
});

test('cookie: a valid ?skin= sets pv-skin once; the same value again sets nothing; pages vary on Cookie', async () => {
  const first = await requestWithCookie(port, '/?skin=metal');
  assert.equal(first.headers['set-cookie'], 'pv-skin=metal; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly');
  assert.equal(first.headers.vary, 'Cookie');
  const again = await requestWithCookie(port, '/?skin=metal', 'pv-skin=metal');
  assert.equal(again.headers['set-cookie'], undefined);
  const alias = await requestWithCookie(port, '/?skin=plain', 'pv-skin=metal');
  assert.equal(alias.headers['set-cookie'], 'pv-skin=light; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly');
  assert.equal((await requestWithCookie(port, '/')).headers['set-cookie'], undefined);
});

test('cookie: the cookie picks the skin without a query; a query wins; a bad query is ignored as a whole and sets none; a bad cookie is ignored', async () => {
  const withCookie = await requestWithCookie(port, '/', 'pv-skin=metal');
  assert.match(withCookie.body, /href="\/skins\/metal\.css"/);
  assert.match(withCookie.body, /data-skin="metal"/);
  assert.doesNotMatch(withCookie.body.replace(switcherOf(withCookie.body), ''), /\?skin=/); // nothing carried in links
  assert.match((await requestWithCookie(port, '/?skin=light', 'pv-skin=metal')).body, /href="\/skins\/light\.css"/);
  const bad = await requestWithCookie(port, '/?skin=bogus', 'pv-skin=metal');
  // An invalid value is ignored as a whole: the cookie still decides, no skin is carried in links and no cookie is set.
  assert.match(bad.body, /href="\/skins\/metal\.css"/);
  assert.doesNotMatch(bad.body.replace(switcherOf(bad.body), ''), /\?skin=/);
  assert.equal(bad.headers['set-cookie'], undefined);
  const badCookie = await requestWithCookie(port, '/', 'pv-skin=<script>');
  assert.match(badCookie.body, /href="\/skins\/light\.css"/);
  assert.doesNotMatch(badCookie.body, /<script>/);
});

test('--tokens in serve mode: validated at start, linked last, read on every request, a lost file gives 404 and the page still renders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pv-serve-tokens-'));
  const file = join(dir, 'my.css');
  await writeFile(file, ':root { --pv-bg: #fdf6e3; }\n');
  const plain = await requestWithCookie(port, '/');
  const withTokens = await startServer({ root: fixture('pyramid'), port: 0, tokensFile: file, log: { info() {}, warn() {} } });
  try {
    const page = await rawRequest(withTokens.port, '/');
    assert.match(page.body, /<link rel="stylesheet" href="\/skins\/light\.css">\n<link rel="stylesheet" href="\/_pv\/tokens\.css">\n/);
    assert.equal(page.headers['content-security-policy'], plain.headers['content-security-policy']);
    const css = await rawRequest(withTokens.port, '/_pv/tokens.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /^text\/css; charset=utf-8$/);
    assert.equal(css.body, ':root { --pv-bg: #fdf6e3; }\n');
    await writeFile(file, ':root { --pv-bg: #000; }\n');
    assert.equal((await rawRequest(withTokens.port, '/_pv/tokens.css')).body, ':root { --pv-bg: #000; }\n');
    await rm(file);
    assert.equal((await rawRequest(withTokens.port, '/_pv/tokens.css')).status, 404);
    assert.equal((await rawRequest(withTokens.port, '/')).status, 200);
  } finally {
    await withTokens.close();
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal((await get('/_pv/tokens.css')).status, 404); // no --tokens, no route
  assert.doesNotMatch(plain.body, /tokens\.css/);
  await assert.rejects(startServer({ root: fixture('pyramid'), port: 0, tokensFile: join(tmpdir(), 'pv-no-such-tokens.css'), log: { info() {}, warn() {} } }), /does not exist/);
});
