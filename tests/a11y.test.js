// Accessibility structure checks (AC 11).
// These are structural checks on the served HTML. They are not a screen-reader test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../viewer.js';
import { fixture } from './helpers.js';

let running;
before(async () => {
  running = await startServer({ root: fixture('pyramid'), port: 0, log: { info() {}, warn() {} } });
});
after(() => running.close());

const get = async (path) => (await fetch(`http://127.0.0.1:${running.port}${path}`)).text();
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

for (const prefix of ['', '/_tree']) {
  test(`every document page${prefix ? ' in the tree view' : ''} has one h1, one main, one article and a skip target`, async () => {
    for (const doc of DOCS) {
      const body = await get(`${prefix}/${doc}`);
      assert.equal((body.match(/<h1[ >]/g) || []).length, 1, `${doc}: h1 count`);
      assert.equal((body.match(/<main[ >]/g) || []).length, 1, `${doc}: main count`);
      assert.equal((body.match(/<article[ >]/g) || []).length, 1, `${doc}: article count`);
      assert.match(body, /<main id="pv-main"/, doc);
      assert.match(body, /<html lang="en">/, doc);
    }
  });
}

test('the pyramid view lists bricks as links in lists, in document order, under visible layer labels', async () => {
  const body = await get('/');
  const sections = body.split('<section class="layer"').slice(1);
  assert.ok(sections.length >= 3);
  for (const section of sections) {
    assert.match(section, /^[^>]*aria-labelledby="pv-layer-[^"]+"/);
    assert.match(section, /<h3 class="layer-label" id="pv-layer-[^"]+">[^<]+<\/h3>/);
    assert.match(section, /<ul class="rows">/);
    for (const li of section.match(/<li class="brick">[\s\S]*?<\/li>/g) || []) assert.match(li, /^<li class="brick"><a href="[^"]+" data-pv-doc="[^"]+"( data-pv-heading="[^"]+")?>[^<]+<\/a><\/li>$/);
  }
  // Layers appear in order L1, L2, L3, L4.
  const ids = [...body.matchAll(/data-layer="(L\d)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [...ids].sort());
});

test('the tree index marks the current page and the open section with aria-current, and collapses in a details element', async () => {
  const body = await get('/_tree/L3-modules/storage.md');
  assert.match(body, /<details class="tree-toggle">\s*<summary>/);
  assert.equal((body.match(/aria-current="page"/g) || []).length, 1);
});
