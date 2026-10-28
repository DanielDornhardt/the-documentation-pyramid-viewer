// The metal skin bundles IBM Plex (SIL Open Font License): files, notice, serve mode and the HTML export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportHtml, startServer } from '../viewer.js';
import { fixture, listFiles } from './helpers.js';

const quiet = { info() {}, warn() {} };
const fontDir = new URL('../vendor/fonts/', import.meta.url);
let out;
let running;
before(async () => {
  out = await mkdtemp(join(tmpdir(), 'pv-fonts-'));
  running = await startServer({ root: fixture('pyramid'), port: 0, log: quiet });
});
after(async () => {
  await running.close();
  await rm(out, { recursive: true, force: true });
});

test('every vendored font file is a woff2 whose sha256 is recorded in vendor/fonts/NOTICE.md, next to the licence text', async () => {
  const notice = await readFile(new URL('NOTICE.md', fontDir), 'utf8');
  const files = (await readdir(fontDir)).filter((f) => f.endsWith('.woff2'));
  assert.equal(files.length, 6);
  for (const file of files) {
    const bytes = await readFile(new URL(file, fontDir));
    assert.equal(bytes.toString('latin1', 0, 4), 'wOF2', file);
    assert.ok(notice.includes(createHash('sha256').update(bytes).digest('hex')), `${file} is not recorded in NOTICE.md`);
  }
  const licence = await readFile(new URL('OFL.txt', fontDir), 'utf8');
  assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(licence, /Reserved Font Name "Plex"/);
});

test('serve: the metal skin links a font stylesheet that points at the font route; the light skin links none', async () => {
  const metal = await (await fetch(`${running.url}?skin=metal`)).text();
  const light = await (await fetch(`${running.url}?skin=light`)).text();
  assert.match(metal, /<link rel="stylesheet" href="\/skins\/metal\.css">\n<link rel="stylesheet" href="\/skins\/metal-fonts\.css">/);
  assert.doesNotMatch(light, /fonts\.css/);
  const css = await fetch(`${running.url}skins/metal-fonts.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  const text = await css.text();
  assert.equal((text.match(/@font-face/g) || []).length, 6);
  assert.match(text, /font-family: "IBM Plex Mono"/);
  assert.match(text, /src: url\("\.\.\/assets\/fonts\/IBMPlexSans-Regular\.woff2"\)/);
  assert.equal((await fetch(`${running.url}skins/light-fonts.css`)).status, 404);
});

test('serve: the font route sends the exact file, refuses other names, and the policy allows fonts from the server itself', async () => {
  const res = await fetch(`${running.url}assets/fonts/IBMPlexSans-Bold.woff2`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'font/woff2');
  assert.match(res.headers.get('content-security-policy'), /font-src 'self'/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), await readFile(new URL('IBMPlexSans-Bold.woff2', fontDir)));
  for (const bad of ['OFL.txt', 'NOTICE.md', '..%2F..%2Fpackage.json', 'IBMPlexSans-Thin.woff2']) {
    assert.equal((await fetch(`${running.url}assets/fonts/${bad}`)).status, 404, bad);
  }
});

test('export: the metal skin embeds its fonts as data URIs and loads nothing external; the light skin has no font stylesheet', async () => {
  await exportHtml({ root: fixture('pyramid'), out: join(out, 'metal'), skin: 'metal', log: quiet });
  await exportHtml({ root: fixture('pyramid'), out: join(out, 'light'), skin: 'light', log: quiet });
  const css = await readFile(join(out, 'metal/skins/metal-fonts.css'), 'utf8');
  assert.equal((css.match(/url\("data:font\/woff2;base64,/g) || []).length, 6);
  assert.doesNotMatch(css, /https?:\/\/|url\("(?!data:)/);
  const files = await listFiles(join(out, 'light'));
  assert.ok(!files.some((f) => f.includes('fonts.css')));
  for (const file of (await listFiles(join(out, 'metal'))).filter((f) => f.endsWith('.html'))) {
    const up = '../'.repeat(file.split('/').length - 1);
    assert.ok((await readFile(join(out, 'metal', file), 'utf8')).includes(`<link rel="stylesheet" href="${up}skins/metal-fonts.css">`), file);
  }
});

test('export with several skins: only the metal folder carries fonts', async () => {
  await exportHtml({ root: fixture('pyramid'), out: join(out, 'both'), skins: ['light', 'metal'], log: quiet });
  const files = await listFiles(join(out, 'both'));
  assert.ok(files.includes('metal/skins/metal-fonts.css'));
  assert.ok(!files.includes('light/skins/metal-fonts.css'));
});
