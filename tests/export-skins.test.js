// Several skins in one export: a folder per skin, a skin switcher in every page, an entry page at the top.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { exportHtml } from '../viewer.js';
import { fixture, listFiles, runCli, walkExport } from './helpers.js';

const quiet = { info() {}, warn() {} };
let out;
before(async () => {
  out = await mkdtemp(join(tmpdir(), 'pv-skins-'));
  await exportHtml({ root: fixture('pyramid'), out, skins: ['light', 'metal'], log: quiet });
});
after(() => rm(out, { recursive: true, force: true }));

test('one full export per skin and an entry page that opens the first', async () => {
  const files = await listFiles(out);
  assert.ok(files.includes('index.html') && files.includes('light/index.html') && files.includes('metal/_tree/index.html'));
  assert.match(await readFile(join(out, 'index.html'), 'utf8'), /url=light\/index\.html/);
  assert.match(await readFile(join(out, 'light/index.html'), 'utf8'), /data-skin="light"/);
  assert.match(await readFile(join(out, 'metal/index.html'), 'utf8'), /data-skin="metal"/);
});

test('every page has a skin switcher whose links reach the same page in the other skin', async () => {
  const pages = (await listFiles(out)).filter((f) => /^(light|metal)\/.*\.html$/.test(f));
  assert.ok(pages.length > 10);
  for (const page of pages) {
    const [skin, ...rest] = page.split('/');
    const other = skin === 'light' ? 'metal' : 'light';
    const html = await readFile(join(out, page), 'utf8');
    const switcher = /<nav class="skin-switch"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
    assert.ok(switcher, `${page} has a switcher`);
    const target = new RegExp(`<a href="([^"]+)">${other === 'light' ? 'Light' : 'Metal'}</a>`).exec(switcher[1]);
    assert.ok(target, `${page} links to ${other}`);
    const resolved = posix.normalize(posix.join(posix.dirname(page), decodeURIComponent(target[1])));
    assert.equal(resolved, `${other}/${rest.join('/')}`, page);
    await stat(join(out, resolved));
  }
});

test('all links of the combined export resolve', async () => {
  const walk = await walkExport(out, { allowUnresolved: [/(^|\/)outside\.md$/, /(^|\/)missing\.md$/] });
  assert.deepEqual(walk.problems, []);
});

test('a single-skin export has no switcher; --skin and --skins together are refused; an unknown skin is refused', async () => {
  const single = await mkdtemp(join(tmpdir(), 'pv-skin1-'));
  try {
    await exportHtml({ root: fixture('pyramid'), out: single, skin: 'metal', log: quiet });
    assert.doesNotMatch(await readFile(join(single, 'index.html'), 'utf8'), /skin-switch/);
  } finally {
    await rm(single, { recursive: true, force: true });
  }
  const both = await runCli(['export', fixture('pyramid'), join(out, 'x'), '--skin', 'light', '--skins', 'light,metal']);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /either --skin or --skins/);
  const bad = await runCli(['export', fixture('pyramid'), join(out, 'y'), '--skins', 'light,glass']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Unknown value "glass" for --skin/);
});
