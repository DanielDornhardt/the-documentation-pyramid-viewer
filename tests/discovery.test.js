// AC 1 (layer discovery and configuration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverLayers, orderFolderFiles, parseLayerConfig } from '../viewer.js';
import { fixture } from './helpers.js';

const paths = (layer) => layer.files.map((f) => f.path);

test('the fixture yields the default five layers in order', async () => {
  const layers = await discoverLayers(fixture('pyramid'));
  assert.deepEqual(layers.map((l) => l.id), ['L1', 'L2', 'L3', 'L4', 'adr']);
  assert.deepEqual(paths(layers[0]), ['L1-vision.md']);
  assert.deepEqual(paths(layers[1]), ['L2-architecture.md']);
  assert.deepEqual(paths(layers[2]), [
    'L3-modules/index.md',
    'L3-modules/crlf.md',
    'L3-modules/notes.md',
    'L3-modules/storage.md'
  ]);
  assert.deepEqual(paths(layers[3]), ['L4-operations/index.md', 'L4-operations/runbook.md']);
  assert.deepEqual(paths(layers[4]), [
    'adr/001-record-decisions.md',
    'adr/002-plain-markdown.md',
    'adr/003-use-ids.md'
  ]);
});

test('layers carry labels, kinds and the brick rule', async () => {
  const layers = await discoverLayers(fixture('pyramid'));
  assert.deepEqual(layers.map((l) => l.label), ['L1 Vision', 'L2 Architecture', 'L3 Modules', 'L4 Operations', 'ADRs']);
  assert.deepEqual(layers.map((l) => l.kind), ['file', 'file', 'folder', 'folder', 'folder']);
  assert.deepEqual(layers.map((l) => l.bricks), ['file', 'headings', 'index', 'index', 'file']);
  assert.deepEqual(layers.map((l) => l.decisions), [false, false, false, false, true]);
});

test('file titles are derived while discovering', async () => {
  const layers = await discoverLayers(fixture('pyramid'));
  assert.equal(layers[1].files[0].title, 'L2 Architecture');
  assert.equal(layers[2].files[0].title, 'L3 Modules');
  assert.equal(layers[4].files[2].title, '003 Use Ids');
});

test('a missing layer is left out, no error', async () => {
  const layers = await discoverLayers(fixture('minimal'));
  assert.deepEqual(layers.map((l) => l.id), ['L1', 'L2']);
});

test('an empty layer folder (only a dotfile) is dropped, unlisted folders are ignored', async () => {
  const layers = await discoverLayers(fixture('pyramid'));
  assert.ok(!layers.some((l) => l.path.startsWith('L5')));
  assert.ok(!layers.some((l) => l.path.startsWith('scratch')));
});

test('orderFolderFiles puts index.md first, then README.md as fallback, then byte-wise', () => {
  assert.deepEqual(orderFolderFiles(['b.md', 'index.md', 'a.md', 'README.md']), ['index.md', 'README.md', 'a.md', 'b.md']);
  assert.deepEqual(orderFolderFiles(['b.md', 'README.md', 'Z.md', 'a.md']), ['README.md', 'Z.md', 'a.md', 'b.md']);
  assert.deepEqual(orderFolderFiles(['b.md', 'a.md']), ['a.md', 'b.md']);
});

test('byte-wise order means uppercase before lowercase and digits before letters', () => {
  assert.deepEqual(orderFolderFiles(['b.md', 'B.md', '10.md', '9.md', 'a.md']), ['10.md', '9.md', 'B.md', 'a.md', 'b.md']);
});

test('README.md is the index of a decision folder without index.md', async () => {
  const layers = await discoverLayers(fixture('adr-readme'));
  const adr = layers.find((l) => l.id === 'adr');
  assert.deepEqual(paths(adr), ['adr/README.md', 'adr/0001-first.md', 'adr/0002-second.md']);
});

test('dotfiles and non-markdown files are skipped', async () => {
  const layers = await discoverLayers(fixture('pyramid'));
  const l3 = layers.find((l) => l.id === 'L3');
  assert.ok(!paths(l3).some((p) => p.includes('.hidden') || p.endsWith('.txt')));
});

test('a docs folder with no pyramid files gives an empty layer list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pv-empty-'));
  try {
    assert.deepEqual(await discoverLayers(dir), []);
    await writeFile(join(dir, 'notes.md'), '# Notes\n');
    await mkdir(join(dir, 'random'));
    assert.deepEqual(await discoverLayers(dir), []);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('a missing docs folder is an error with a clear message', async () => {
  await assert.rejects(() => discoverLayers(join(tmpdir(), 'pv-does-not-exist-xyz')), /docs folder/i);
});

test('pyramid.json in the docs root replaces the default list', async () => {
  const layers = await discoverLayers(fixture('custom'));
  assert.deepEqual(layers.map((l) => l.id), ['vision', 'guides', 'start']);
  assert.deepEqual(layers.map((l) => l.label), ['Vision', 'Guides', 'Start here']);
  assert.deepEqual(paths(layers[1]), ['guides/index.md', 'guides/setup.md']);
  assert.equal(layers[0].bricks, 'file');
  assert.equal(layers[1].bricks, 'index');
});

test('a layers option takes precedence over pyramid.json', async () => {
  const layers = await discoverLayers(fixture('custom'), {
    layers: [{ id: 'g', label: 'G', path: 'guides', kind: 'folder' }]
  });
  assert.deepEqual(layers.map((l) => l.id), ['g']);
});

test('a layers file option is read like pyramid.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pv-cfg-'));
  try {
    const file = join(dir, 'layers.json');
    await writeFile(file, JSON.stringify([{ id: 'd', label: 'Decisions', path: 'adr', kind: 'folder' }]));
    const layers = await discoverLayers(fixture('pyramid'), { layersFile: file });
    assert.deepEqual(layers.map((l) => l.id), ['d']);
    assert.equal(layers[0].files.length, 3);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('parseLayerConfig accepts an object or an array and rejects bad input', () => {
  const one = { id: 'a', label: 'A', path: 'a', kind: 'folder' };
  assert.equal(parseLayerConfig(JSON.stringify({ layers: [one] }))[0].id, 'a');
  assert.equal(parseLayerConfig(JSON.stringify([one]))[0].id, 'a');
  assert.throws(() => parseLayerConfig('{not json'), /pyramid\.json|layer config/i);
  assert.throws(() => parseLayerConfig('{"layers": 3}'), /layers/);
  assert.throws(() => parseLayerConfig(JSON.stringify([{ ...one, kind: 'blob' }])), /kind/);
  assert.throws(() => parseLayerConfig(JSON.stringify([{ ...one, path: '../x' }])), /path/);
  assert.throws(() => parseLayerConfig(JSON.stringify([{ ...one, path: '/abs' }])), /path/);
  assert.throws(() => parseLayerConfig(JSON.stringify([{ ...one, id: '' }])), /id/);
});

test('a symlinked layer folder that leaves the docs root is not followed', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pv-link-'));
  try {
    await mkdir(join(base, 'root'));
    await mkdir(join(base, 'outside'));
    await writeFile(join(base, 'outside', 'x.md'), '# X\n');
    await writeFile(join(base, 'root', 'L1-vision.md'), '# V\n');
    await symlink(join(base, 'outside'), join(base, 'root', 'L3-modules'));
    await symlink(join(base, 'outside', 'x.md'), join(base, 'root', 'L2-architecture.md'));
    const layers = await discoverLayers(join(base, 'root'));
    assert.deepEqual(layers.map((l) => l.id), ['L1']);
  } finally {
    await rm(base, { recursive: true });
  }
});

test('C10: a file that an earlier layer already lists is not listed again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pv-overlap-'));
  try {
    await mkdir(join(dir, 'a'));
    await writeFile(join(dir, 'a', 'x.md'), '# X\n\n## s\n');
    await writeFile(join(dir, 'a', 'y.md'), '# Y\n');
    const layers = await discoverLayers(dir, {
      layers: [{ id: 'A', kind: 'folder', path: 'a' }, { id: 'B', kind: 'file', path: 'a/x.md' }]
    });
    assert.deepEqual(layers.map((l) => l.id), ['A']);
    assert.deepEqual(paths(layers[0]), ['a/x.md', 'a/y.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
