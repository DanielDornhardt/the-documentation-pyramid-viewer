// Path guard for AC 5 and AC 6 in: pure function level.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRequestPath } from '../viewer.js';

let base;
let root;

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'pv-guard-')));
  root = join(base, 'root');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(join(root, 'dir.md'));
  await mkdir(join(base, 'outside'));
  await writeFile(join(root, 'a.md'), '# A\n');
  await writeFile(join(root, 'sub', 'b.md'), '# B\n');
  await writeFile(join(root, 'notes.txt'), 'text\n');
  await writeFile(join(root, '.secret.md'), '# S\n');
  await writeFile(join(base, 'outside.md'), '# Out\n');
  await writeFile(join(base, 'outside', 'x.md'), '# X\n');
  await symlink(join(base, 'outside.md'), join(root, 'leak.md'));
  await symlink(join(base, 'outside'), join(root, 'linkdir'));
  await symlink(join(root, 'a.md'), join(root, 'inside-link.md'));
  await symlink(join(base, 'root-twin'), join(root, 'dangling.md'));
});

after(async () => {
  await rm(base, { recursive: true });
});

test('a regular markdown file inside the root resolves', async () => {
  const hit = await resolveRequestPath(root, '/a.md');
  assert.deepEqual(hit, { absolutePath: join(root, 'a.md'), relativePath: 'a.md' });
  const sub = await resolveRequestPath(root, '/sub/b.md');
  assert.equal(sub.relativePath, 'sub/b.md');
  assert.equal((await resolveRequestPath(root, 'a.md')).relativePath, 'a.md');
});

test('a percent-encoded name is decoded once', async () => {
  await writeFile(join(root, 'sp ace.md'), '# S\n');
  assert.equal((await resolveRequestPath(root, '/sp%20ace.md')).relativePath, 'sp ace.md');
  assert.equal(await resolveRequestPath(root, '/sp%2520ace.md'), null);
});

test('a symlink that stays inside the root is allowed', async () => {
  const hit = await resolveRequestPath(root, '/inside-link.md');
  assert.equal(hit.absolutePath, join(root, 'a.md'));
});

const rejected = [
  ['parent segment', '/../outside.md'],
  ['nested parent segment', '/sub/../../outside.md'],
  ['encoded dots', '/%2e%2e/outside.md'],
  ['mixed case encoded dots', '/%2E%2e/outside.md'],
  ['encoded slash', '/sub%2fb.md'],
  ['encoded slash upper case', '/sub%2Fb.md'],
  ['encoded backslash', '/sub%5cb.md'],
  ['raw backslash', '/sub\\b.md'],
  ['backslash parent', '/..\\outside.md'],
  ['encoded null byte', '/a.md%00'],
  ['null byte inside', '/a%00.md'],
  ['raw null byte', '/a.md\u0000'],
  ['absolute path', '/etc/passwd'],
  ['absolute path with md', '/etc/hosts.md'],
  ['double slash absolute', '//etc/passwd.md'],
  ['malformed escape', '/%zz.md'],
  ['double encoded dots', '/%252e%252e/outside.md'],
  ['symlink to a file outside', '/leak.md'],
  ['symlink to a folder outside', '/linkdir/x.md'],
  ['dangling symlink', '/dangling.md'],
  ['directory with md name', '/dir.md'],
  ['non-markdown file', '/notes.txt'],
  ['dotfile', '/.secret.md'],
  ['dot folder', '/.git/config.md'],
  ['missing file', '/missing.md'],
  ['root itself', '/'],
  ['empty path', ''],
  ['folder', '/sub'],
  ['not a string', undefined]
];
for (const [name, requestPath] of rejected) {
  test(`rejects: ${name}`, async () => {
    assert.equal(await resolveRequestPath(root, requestPath), null);
  });
}

test('a missing docs root resolves to null, not a crash', async () => {
  assert.equal(await resolveRequestPath(join(base, 'nope'), '/a.md'), null);
});
