// Metal theme and skin parity.
// Checks the contrast of the metal token pairs (computed from the token values, bricks also in the lit
// condition), the rules of the metal stylesheet, and that both skins give identical markup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startServer } from '../viewer.js';
import { fixture } from './helpers.js';
import { registerThemeTests, hexToken, tokenValue } from './skin-theme.js';

const metal = await readFile(new URL('../skins/metal.css', import.meta.url), 'utf8');
const light = await readFile(new URL('../skins/light.css', import.meta.url), 'utf8');
const base = await readFile(new URL('../skins/pv-base.css', import.meta.url), 'utf8');

// The metal overlay lightens the top of a brick: gradient (10 percent) plus the light (about 13 percent).
registerThemeTests('metal', metal, { lit: 0.23 });

test('brand values: accent, paper link, paper text and the font stacks', () => {
  assert.equal(hexToken(metal, 'pv-accent'), '#00adef');
  assert.equal(hexToken(light, 'pv-accent'), '#00adef');
  assert.equal(hexToken(metal, 'pv-paper-link'), '#1d4a9e');
  assert.equal(hexToken(metal, 'pv-paper-text'), '#1d2126');
  assert.match(tokenValue(metal, 'pv-font'), /^"IBM Plex Sans",/);
  assert.match(tokenValue(metal, 'pv-mono'), /^"IBM Plex Mono",/);
});

test('metal theme has a data-URI grain, no files, no fonts, no fixed background', () => {
  const urls = [...metal.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(urls.length > 0);
  for (const u of urls) assert.match(u, /^"data:image\/svg\+xml,/);
  assert.match(metal, /feTurbulence/);
  assert.doesNotMatch(metal.replace(/url\("data:[^)]*\)/g, ''), /@import|@font-face|https?:\/\//);
  assert.doesNotMatch(metal, /background-attachment|position:\s*fixed/);
});

test('metal theme: transitions and keyframes animate only opacity and transform, and the grain and light are static', () => {
  for (const m of metal.matchAll(/transition:\s*([^;]+);/g)) {
    if (!m[1].startsWith('none')) assert.match(m[1], /^(opacity|transform)\b/);
  }
  assert.doesNotMatch(metal, /@keyframes|animation:/, 'the metal theme adds no animation of its own');
  assert.doesNotMatch(metal, /transition:\s*all/);
});

test('metal theme: decorations that the base stylesheet does not have, and a forced-colors fallback', () => {
  assert.match(metal, /body::before/);
  assert.match(metal, /\.doc h1\.pyramid-title\s*\{[^}]*background-clip:\s*text/);
  assert.match(metal, /@media \(forced-colors: active\)\s*\{\s*\.doc h1\.pyramid-title\s*\{\s*color:\s*CanvasText/);
  assert.match(metal, /\.pv-dialog-header::after/);
  assert.match(metal, /--pv-bevel:/);
  // The base never refers to a metal-only token.
  for (const name of ['pv-grain', 'pv-light-strength', 'pv-glow', 'pv-plate', 'pv-bevel']) assert.doesNotMatch(base, new RegExp(`--${name}`));
});

const TREE = '/_tree';
let running;
before(async () => {
  running = await startServer({ root: fixture('pyramid'), port: 0, log: { info() {}, warn() {} } });
});
after(() => running.close());

async function page(path, skin) {
  const res = await fetch(`http://127.0.0.1:${running.port}${path}${path.includes('?') ? '&' : '?'}skin=${skin}`);
  assert.equal(res.status, 200);
  return res.text();
}

/** Replace the theme link, data-skin and the skin query strings that links carry, so only the skin is normalised. The skin switcher differs on purpose and is left out. */
function normalise(html) {
  return html
    .replace(/<nav class="skin-switch"[\s\S]*?<\/nav>\n/, '')
    .replace(/<link rel="stylesheet" href="\/skins\/(light|metal)\.css">\n(<link rel="stylesheet" href="\/skins\/metal-fonts\.css">\n)?/, '<link rel="stylesheet" href="THEME">\n')
    .replace(/data-skin="(light|metal)"/, 'data-skin="SKIN"')
    .replace(/(\?|&amp;|&)skin=(light|plain|metal)/g, '');
}

for (const path of ['/', TREE + '/', '/L3-modules/storage.md', TREE + '/L3-modules/storage.md', TREE + '/L3-modules/storage.md?at=x']) {
  test(`markup of ${path} is identical for both skins apart from the theme link and data-skin`, async () => {
    const a = await page(path, 'light');
    const b = await page(path, 'metal');
    assert.match(a, /skins\/light\.css/);
    assert.match(b, /skins\/metal\.css/);
    assert.equal(normalise(a), normalise(b));
  });
}

test('?skin=plain gives exactly the page of ?skin=light', async () => {
  for (const path of ['/', TREE + '/', '/L3-modules/storage.md']) assert.equal(await page(path, 'plain'), await page(path, 'light'), path);
});
