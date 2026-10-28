// AC 3 (pyramid view geometry).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBricks, layoutRows, loadPyramid } from '../viewer.js';
import { fixture } from './helpers.js';

const make = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const layer = (id, n) => ({ id, bricks: make(id, n) });
const widths = (laid) => laid.layers.flatMap((l) => l.rows.map((r) => r.length));

test('exact fills give row widths 1, 2, 3 ... continuing across layers', () => {
  const laid = layoutRows([layer('a', 1), layer('b', 5), layer('c', 9)]);
  assert.deepEqual(widths(laid), [1, 2, 3, 4, 5]);
  assert.deepEqual(laid.layers[1].rows, [['b1', 'b2'], ['b3', 'b4', 'b5']]);
  assert.equal(laid.nextWidth, 6);
});

test('a short last row moves to the top of its layer and takes the first bricks', () => {
  const laid = layoutRows([layer('a', 1), layer('b', 6), layer('c', 9)]);
  assert.deepEqual(laid.layers[1].rows, [['b1'], ['b2', 'b3'], ['b4', 'b5', 'b6']]);
  // the counter advanced by the three rows built, so the next layer starts at width 5:
  // rows of 5 and 4 bricks, and the short row of 4 moves to the top
  assert.deepEqual(laid.layers[2].rows, [['c1', 'c2', 'c3', 'c4'], ['c5', 'c6', 'c7', 'c8', 'c9']]);
});

test('with only two rows the short second row also moves up', () => {
  const laid = layoutRows([layer('a', 1), layer('b', 3)]);
  assert.deepEqual(laid.layers[1].rows, [['b1'], ['b2', 'b3']]);
});

test('a last row as long as the row before is not reordered', () => {
  const laid = layoutRows([layer('a', 1), layer('b', 4)]);
  assert.deepEqual(laid.layers[1].rows, [['b1', 'b2'], ['b3', 'b4']]);
});

test('a one-row layer is never reordered, even when short', () => {
  const laid = layoutRows([layer('a', 1), layer('b', 1), layer('c', 2)]);
  assert.deepEqual(laid.layers[1].rows, [['b1']]);
  // b is a width-2 row holding one brick; counter advanced by one row, so c starts at width 3
  assert.deepEqual(laid.layers[2].rows, [['c1', 'c2']]);
  assert.equal(laid.nextWidth, 4);
});

test('an empty layer does not advance the width counter', () => {
  const laid = layoutRows([layer('a', 1), layer('empty', 0), layer('c', 2)]);
  assert.deepEqual(laid.layers.map((l) => l.id), ['a', 'empty', 'c']);
  assert.deepEqual(laid.layers[1].rows, []);
  assert.deepEqual(laid.layers[2].rows, [['c1', 'c2']]);
  assert.equal(laid.nextWidth, 3);
});

test('no layers and no bricks lay out to nothing', () => {
  assert.deepEqual(layoutRows([]), { layers: [], nextWidth: 1 });
});

test('bricks keep document order across the rows of a layer', () => {
  const laid = layoutRows([layer('a', 20)]);
  assert.deepEqual(laid.layers[0].rows.flat(), make('a', 20));
});

const docA = { path: 'a.md', title: 'A Title', headings: [{ level: 1, text: 'A', slug: 'a' }, { level: 2, text: 'One', slug: 'one' }, { level: 3, text: 'Sub', slug: 'sub' }, { level: 2, text: 'Two', slug: 'two' }] };
const docB = { path: 'b.md', title: 'B Title', headings: [{ level: 1, text: 'B', slug: 'b' }] };

test('headings layers make one brick per second-level heading', () => {
  const bricks = buildBricks({ id: 'L3', bricks: 'headings' }, [docA]);
  assert.deepEqual(bricks, [
    { layerId: 'L3', label: 'One', path: 'a.md', slug: 'one' },
    { layerId: 'L3', label: 'Two', path: 'a.md', slug: 'two' }
  ]);
});

test('a file with no second-level heading is one brick labelled with the file title', () => {
  const bricks = buildBricks({ id: 'L3', bricks: 'headings' }, [docB, docA]);
  assert.deepEqual(bricks[0], { layerId: 'L3', label: 'B Title', path: 'b.md', slug: null });
  assert.equal(bricks.length, 3);
});

test('file layers make one brick per file', () => {
  const bricks = buildBricks({ id: 'L1', bricks: 'file' }, [docA, docB]);
  assert.deepEqual(bricks.map((b) => [b.label, b.path, b.slug]), [['A Title', 'a.md', null], ['B Title', 'b.md', null]]);
});

test('the pyramid model keeps decision records out of the growing rows', async () => {
  const model = await loadPyramid(fixture('pyramid'));
  assert.deepEqual(model.layers.map((l) => l.id), ['L1', 'L2', 'L3', 'L4']);
  assert.deepEqual(model.decisions.map((l) => l.id), ['adr']);
  assert.deepEqual(model.decisions[0].bricks.map((b) => b.label), ['001 Record Decisions', '002 Plain Markdown', '003 Use Ids']);
  const rowWidths = model.layers.flatMap((l) => l.rows.map((r) => r.length));
  assert.equal(rowWidths[0], 1);
  assert.ok(!model.layers.some((l) => l.rows.flat().some((b) => b.layerId === 'adr')));
});

test('the pyramid model of the fixture has the expected bricks and targets', async () => {
  const model = await loadPyramid(fixture('pyramid'));
  const byId = Object.fromEntries(model.layers.map((l) => [l.id, l]));
  assert.deepEqual(byId.L1.rows.flat().map((b) => [b.label, b.path, b.slug]), [['L1 Vision', 'L1-vision.md', null]]);
  const l2 = byId.L2.rows.flat();
  // two headings are called Overview: each brick targets its own heading
  const overviews = l2.filter((b) => b.label === 'Overview').map((b) => b.slug);
  assert.deepEqual(overviews, ['overview', 'overview-1']);
  // L3 has an index file, so only its sections are bricks (the forked files are not); bricks "headings" gives the old all-files list
  const l3 = byId.L3.rows.flat();
  assert.deepEqual(l3.map((b) => [b.path, b.label]), [['L3-modules/index.md', 'Reader'], ['L3-modules/index.md', 'Page builder']]);
  const all = await loadPyramid(fixture('pyramid'), { layers: [{ id: 'L3', label: 'L3', path: 'L3-modules', kind: 'folder', bricks: 'headings' }] });
  const l3all = all.layers[0].rows.flat();
  assert.ok(l3all.some((b) => b.path === 'L3-modules/notes.md' && b.label === 'Notes' && b.slug === null));
  assert.ok(l3all.some((b) => b.path === 'L3-modules/storage.md' && b.slug === 'writing-tides'));
  assert.ok(!l3all.some((b) => b.label === 'x'));
  // every brick slug exists as a heading of its document
  for (const l of model.layers) {
    for (const b of l.rows.flat()) {
      if (!b.slug) continue;
      const doc = l.docs.find((d) => d.path === b.path);
      assert.ok(doc.headings.some((h) => h.slug === b.slug && h.level === 2), `${b.path}#${b.slug}`);
    }
  }
});

test('the model of a folder with no layers is empty', async () => {
  const model = await loadPyramid(fixture('pyramid', 'scratch'));
  assert.deepEqual(model, { layers: [], decisions: [], all: [], offPyramid: 0, folderIndexes: [], offPyramidUnlinked: [] });
});
