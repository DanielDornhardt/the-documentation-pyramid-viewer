// Review fixes: S2 (Host header check), E1 (empty folder warning in
// serve mode), E5 (host warning after the listen succeeds).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../viewer.js';
import { fixture } from './helpers.js';

const quiet = { info() {}, warn() {} };

/** One raw request with a chosen Host header (or none). */
function request(port, hostHeader, path = '/', address = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, address);
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: Number(text.split(' ')[1]), body: text.slice(text.indexOf('\r\n\r\n') + 4) });
    });
    socket.write(`GET ${path} HTTP/1.1\r\n${hostHeader === null ? '' : `Host: ${hostHeader}\r\n`}Connection: close\r\n\r\n`);
  });
}

let running;
before(async () => {
  running = await startServer({ root: fixture('pyramid'), port: 0, log: quiet });
});
after(() => running.close());

test('S2: on loopback only loopback host names are answered', async () => {
  const port = running.port;
  for (const host of ['127.0.0.1', `127.0.0.1:${port}`, 'localhost', `localhost:${port}`, `[::1]:${port}`, 'LOCALHOST']) {
    assert.equal((await request(port, host)).status, 200, host);
  }
  for (const host of ['evil.example.com', `evil.example.com:${port}`, `127.0.0.1.evil.example.com`, `localhost.evil.example.com`, '127.0.0.1:1']) {
    const answer = await request(port, host);
    assert.equal(answer.status, 403, String(host));
    assert.doesNotMatch(answer.body, /Documentation pyramid/);
  }
  assert.equal((await request(port, null)).status, 400, 'Node itself refuses a request without a Host header');
  assert.equal((await request(port, 'evil.example.com', '/L2-architecture.md')).status, 403);
  assert.equal((await request(port, 'evil.example.com', '/skins/light.css')).status, 403);
});

test('S2: a server bound to another address answers its own address and the allowed hosts only', async () => {
  const server = await startServer({ root: fixture('pyramid'), port: 0, host: '127.0.0.1', allowedHosts: ['docs.example.test'], log: quiet });
  try {
    assert.equal((await request(server.port, 'docs.example.test')).status, 200);
    assert.equal((await request(server.port, `docs.example.test:${server.port}`)).status, 200);
    assert.equal((await request(server.port, 'other.example.test')).status, 403);
  } finally {
    await server.close();
  }
  const open = await startServer({ root: fixture('pyramid'), port: 0, host: '0.0.0.0', allowedHosts: ['docs.example.test'], log: quiet });
  try {
    assert.equal((await request(open.port, 'docs.example.test')).status, 200);
    assert.equal((await request(open.port, 'other.example.test')).status, 403);
  } finally {
    await open.close();
  }
});

test('E1: serve warns at start when the folder holds no layers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pv-empty-'));
  const messages = [];
  const server = await startServer({ root: dir, port: 0, log: { info() {}, warn: (m) => messages.push(m) } });
  await server.close();
  await rm(dir, { recursive: true, force: true });
  assert.match(messages.join('\n'), /No layers found/);
  assert.match(messages.join('\n'), /pyramid\.json/);
});

test('E5: the "not only on this computer" warning comes only after the listen succeeded', async () => {
  const messages = [];
  const log = { info() {}, warn: (m) => messages.push(m) };
  await assert.rejects(startServer({ root: fixture('pyramid'), port: 0, host: 'nonsense.invalid', log }));
  assert.deepEqual(messages, []);
});
