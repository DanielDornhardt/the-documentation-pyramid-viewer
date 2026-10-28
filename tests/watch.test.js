// Watch mode: serve --watch, the event stream, the limits and the shutdown.
// Real server on port 0, a temporary copy of the fixture, a node:http client for the server-sent events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { writeFile, mkdir, rm, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../viewer.js';
import { classifyDocsChange, createLiveHub } from '../src/watch.js';
import { tempFixture } from './helpers.js';

const quiet = { info() {}, warn() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open an event stream. Collects the text; resolves once the headers have arrived. */
function openStream(port, { path = '/_pv/events', host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      const stream = { res, req, text: '', ended: false, events: [] };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        stream.text += chunk;
        stream.events = [...stream.text.matchAll(/event: change\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1]));
      });
      res.on('end', () => {
        stream.ended = true;
      });
      res.on('error', () => {
        stream.ended = true;
      });
      resolve(stream);
    });
    req.on('error', reject);
  });
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await sleep(15);
  }
  throw new Error('timed out');
}

function rawGet(port, path, { method = 'GET', host = 'localhost' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      resolve({ status: Number(text.split(' ')[1]), head: text.slice(0, split), body: text.slice(split + 4) });
    });
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });
}

async function withServer(extra, body) {
  const copy = await tempFixture();
  const running = await startServer({ root: copy.root, port: 0, log: quiet, watch: true, watchDebounceMs: 25, ...extra(copy) });
  try {
    // File events of the copy itself can arrive late (macOS reports recent history): let them pass before the test starts.
    await sleep(400);
    await body(running, copy);
  } finally {
    await running.close();
    await copy.cleanup();
  }
}

test('classifyDocsChange: markdown and pyramid.json count, dot folders, node_modules and other files do not', () => {
  assert.deepEqual(classifyDocsChange('L2-architecture.md'), { docs: true, path: 'L2-architecture.md' });
  assert.deepEqual(classifyDocsChange('adr\\003-use-ids.md'), { docs: true, path: 'adr/003-use-ids.md' });
  assert.deepEqual(classifyDocsChange('pyramid.json'), { docs: true, path: 'pyramid.json' });
  assert.deepEqual(classifyDocsChange('L3-modules'), { docs: true }); // a folder that came or went
  assert.equal(classifyDocsChange('.git/index.md'), null);
  assert.equal(classifyDocsChange('a/.hidden/b.md'), null);
  assert.equal(classifyDocsChange('node_modules/x/readme.md'), null);
  assert.equal(classifyDocsChange('photo.png'), null);
  assert.equal(classifyDocsChange(''), null);
});

test('the event stream: 200, text/event-stream, security headers, retry and a connected comment first', async () => {
  await withServer(() => ({}), async (running) => {
    const s = await openStream(running.port);
    assert.equal(s.res.statusCode, 200);
    assert.match(s.res.headers['content-type'], /^text\/event-stream; charset=utf-8$/);
    assert.equal(s.res.headers['cache-control'], 'no-store');
    assert.equal(s.res.headers['x-content-type-options'], 'nosniff');
    assert.match(s.res.headers['content-security-policy'], /default-src 'none'/);
    await until(() => s.text.includes(': connected'));
    assert.ok(s.text.startsWith('retry: 2000\n'));
    s.req.destroy();
  });
});

test('a changed file gives one change message with the relative path, a counter and no content', async () => {
  await withServer(() => ({}), async (running, copy) => {
    const s = await openStream(running.port);
    await until(() => s.text.includes(': connected'));
    await writeFile(join(copy.root, 'L2-architecture.md'), '# Tidewatch architecture\n\n## A secret heading text\n');
    await until(() => s.events.length >= 1);
    const first = s.events[0];
    assert.equal(first.docs, true);
    assert.equal(first.css, false);
    assert.equal(typeof first.n, 'number');
    assert.ok(first.paths.includes('L2-architecture.md'));
    assert.ok(!s.text.includes('secret heading'), 'no document content on the stream');
    s.req.destroy();
  });
});

test('many writes inside the debounce window give one message with the merged paths', async () => {
  await withServer(() => ({ watchDebounceMs: 150 }), async (running, copy) => {
    const s = await openStream(running.port);
    await until(() => s.text.includes(': connected'));
    for (let i = 0; i < 8; i++) await writeFile(join(copy.root, `note-${i % 3}.md`), `# Note ${i}\n`);
    await until(() => s.events.length >= 1);
    await sleep(400);
    assert.equal(s.events.length, 1);
    assert.deepEqual(s.events[0].paths, ['note-0.md', 'note-1.md', 'note-2.md']);
    s.req.destroy();
  });
});

test('dot folders, node_modules and files that are not markdown give no message', async () => {
  await withServer(() => ({}), async (running, copy) => {
    await mkdir(join(copy.root, '.git'));
    await mkdir(join(copy.root, 'node_modules'));
    await mkdir(join(copy.root, '.cache'));
    const s = await openStream(running.port);
    await until(() => s.text.includes(': connected'));
    await writeFile(join(copy.root, '.git', 'notes.md'), 'x');
    await writeFile(join(copy.root, 'node_modules', 'pkg.md'), 'x');
    await writeFile(join(copy.root, '.cache', 'a.md'), 'x');
    await writeFile(join(copy.root, 'picture.png'), 'x');
    await sleep(350);
    assert.equal(s.events.length, 0);
    s.req.destroy();
  });
});

test('a change of the tokens file is a css change, and a change of a skin file too (injected skins folder)', async () => {
  const skinDir = await mkdtemp(join(tmpdir(), 'pv-skins-'));
  const tokensDir = await mkdtemp(join(tmpdir(), 'pv-tokens-'));
  const tokens = join(tokensDir, 'tokens.css');
  await writeFile(tokens, ':root { --pv-bg: #fff; }\n');
  await writeFile(join(skinDir, 'light.css'), ':root {}\n');
  try {
    await withServer(() => ({ tokensFile: tokens, skinDir }), async (running) => {
      const s = await openStream(running.port);
      await until(() => s.text.includes(': connected'));
      await writeFile(tokens, ':root { --pv-bg: #fdf6e3; }\n');
      await until(() => s.events.length >= 1);
      assert.deepEqual([s.events[0].css, s.events[0].docs], [true, false]);
      await writeFile(join(skinDir, 'light.css'), ':root { --x: 1; }\n');
      await until(() => s.events.length >= 2);
      assert.equal(s.events[1].css, true);
      assert.ok(s.events[1].n > s.events[0].n);
      s.req.destroy();
    });
  } finally {
    await rm(skinDir, { recursive: true, force: true });
    await rm(tokensDir, { recursive: true, force: true });
  }
});

test('the 21st connection gets 503 with Retry-After; after one closes a new one is accepted', async () => {
  await withServer(() => ({}), async (running) => {
    const open = [];
    for (let i = 0; i < 20; i++) open.push(await openStream(running.port));
    const refused = await openStream(running.port);
    assert.equal(refused.res.statusCode, 503);
    assert.equal(refused.res.headers['retry-after'], '5');
    await until(() => refused.text.includes('Too many live connections.'));
    open[0].req.destroy();
    await until(async () => true);
    let accepted;
    await until(() => {
      openStream(running.port).then((s) => {
        if (s.res.statusCode === 200) accepted = s;
        else s.req.destroy();
      });
      return accepted;
    }, 3000).catch(() => {});
    await sleep(100);
    assert.ok(accepted, 'a slot became free');
    for (const s of open) s.req.destroy();
    accepted?.req.destroy();
  });
});

test('a comment ping arrives on an open stream', async () => {
  await withServer(() => ({ pingMs: 30 }), async (running) => {
    const s = await openStream(running.port);
    await until(() => s.text.includes(': ping'));
    s.req.destroy();
  });
});

test('without --watch the event route and the live script are 404 and pages do not link the live script', async () => {
  const copy = await tempFixture();
  const running = await startServer({ root: copy.root, port: 0, log: quiet });
  try {
    assert.equal((await rawGet(running.port, '/_pv/events')).status, 404);
    assert.equal((await rawGet(running.port, '/assets/pv-live.js')).status, 404);
    assert.doesNotMatch((await rawGet(running.port, '/')).body, /pv-live/);
  } finally {
    await running.close();
    await copy.cleanup();
  }
});

test('with --watch the pages link the live script with the events address, and the script is served', async () => {
  await withServer(() => ({}), async (running) => {
    for (const path of ['/', '/_tree/', '/L1-vision.md']) {
      const page = await rawGet(running.port, path);
      assert.match(page.body, /<script defer src="\/assets\/pv-live\.js" data-events="\/_pv\/events"><\/script>/, path);
    }
    const script = await rawGet(running.port, '/assets/pv-live.js');
    assert.equal(script.status, 200);
    assert.match(script.head, /text\/javascript/);
    assert.equal(script.body, await readFile(new URL('../assets/pv-live.js', import.meta.url), 'utf8'));
  });
});

test('the event route checks the Host header and only answers GET', async () => {
  await withServer(() => ({}), async (running) => {
    assert.equal((await rawGet(running.port, '/_pv/events', { host: 'evil.example' })).status, 403);
    assert.equal((await rawGet(running.port, '/assets/pv-live.js', { host: 'evil.example' })).status, 403);
    assert.equal((await rawGet(running.port, '/_pv/events', { method: 'POST' })).status, 405);
    const head = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: running.port, path: '/_pv/events', method: 'HEAD' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(head, 405);
  });
});

test('close() ends every open stream and resolves', async () => {
  const copy = await tempFixture();
  const running = await startServer({ root: copy.root, port: 0, log: quiet, watch: true });
  const streams = [await openStream(running.port), await openStream(running.port)];
  await until(() => streams.every((s) => s.text.includes(': connected')));
  await running.close();
  await until(() => streams.every((s) => s.ended));
  await copy.cleanup();
});

test('the hub counts messages and sends many without a path list', () => {
  const hub = createLiveHub({ pingMs: 100000 });
  const written = [];
  const res = { writeHead() {}, write: (t) => written.push(t), end() {}, on() {} };
  hub.attach({ on() {} }, res, {});
  hub.broadcast({ docs: true, css: false, paths: ['a.md'], many: false });
  hub.broadcast({ docs: true, css: false, paths: [], many: true });
  const messages = written.filter((t) => t.startsWith('event: change')).map((t) => JSON.parse(t.split('\n')[1].slice(6)));
  assert.deepEqual(messages[0], { n: 1, docs: true, css: false, paths: ['a.md'] });
  assert.deepEqual(messages[1], { n: 2, docs: true, css: false, many: true });
  hub.close();
});

test('a symbolic link as the tokens file: an edit of the target is a css change', async (t) => {
  const realDir = await mkdtemp(join(tmpdir(), 'pv-tokens-real-'));
  const linkDir = await mkdtemp(join(tmpdir(), 'pv-tokens-link-'));
  const target = join(realDir, 'real.css');
  const link = join(linkDir, 'link.css');
  await writeFile(target, ':root { --pv-bg: #fff; }\n');
  try {
    await symlink(target, link);
  } catch {
    t.skip('symlinks are not available here');
    return;
  }
  try {
    await withServer(() => ({ tokensFile: link }), async (running) => {
      const s = await openStream(running.port);
      await until(() => s.text.includes(': connected'));
      await writeFile(target, ':root { --pv-bg: #fdf6e3; }\n');
      await until(() => s.events.length >= 1);
      assert.equal(s.events[0].css, true);
      s.req.destroy();
    });
  } finally {
    await rm(realDir, { recursive: true, force: true });
    await rm(linkDir, { recursive: true, force: true });
  }
});

test('the event stream refuses a request that carries the Origin of another site', async () => {
  await withServer(() => ({}), async (running) => {
    const status = (origin) =>
      new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: running.port, path: '/_pv/events', headers: origin ? { Origin: origin } : {} }, (res) => {
          resolve(res.statusCode);
          req.destroy();
        });
        req.on('error', (e) => (e.code === 'ECONNRESET' ? undefined : reject(e)));
      });
    assert.equal(await status('https://other.example'), 403);
    assert.equal(await status('not a url'), 403);
    assert.equal(await status(`http://127.0.0.1:${running.port}`), 200);
    assert.equal(await status(null), 200);
  });
});
