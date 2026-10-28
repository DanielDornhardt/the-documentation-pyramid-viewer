// Skin names, the plain alias and the user tokens file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSkin, readTokensFile, TokensError, SKINS, DEFAULT_SKIN, skinFromCookie, skinCookieHeader } from '../src/skins.js';

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pv-skins-'));
});
after(() => rm(dir, { recursive: true, force: true }));

test('resolveSkin: canonical names, the plain alias, case, and unknown values', () => {
  assert.deepEqual(SKINS, ['light', 'metal']);
  assert.equal(DEFAULT_SKIN, 'light');
  assert.equal(resolveSkin('light'), 'light');
  assert.equal(resolveSkin('metal'), 'metal');
  assert.equal(resolveSkin('plain'), 'light');
  assert.equal(resolveSkin('PLAIN'), 'light');
  assert.equal(resolveSkin(' Metal '), 'metal');
  for (const bad of ['gold', '', 'light.css', '__proto__', 'constructor', null, undefined, 3, {}]) assert.equal(resolveSkin(bad), null, String(bad));
});

test('readTokensFile: a regular file is read and a byte order mark is removed', async () => {
  const file = join(dir, 'a.css');
  await writeFile(file, '\ufeff:root { --pv-bg: #fff; }\n');
  assert.equal(await readTokensFile(file), ':root { --pv-bg: #fff; }\n');
});

test('readTokensFile: a symlink to a file works, a missing file and a folder are errors with a plain sentence', async () => {
  const file = join(dir, 'b.css');
  await writeFile(file, ':root {}');
  const link = join(dir, 'link.css');
  await symlink(file, link);
  assert.equal(await readTokensFile(link), ':root {}');
  await assert.rejects(readTokensFile(join(dir, 'nope.css')), (e) => e instanceof TokensError && /^--tokens: the file ".*nope\.css" does not exist\.$/.test(e.message));
  await mkdir(join(dir, 'folder'));
  await assert.rejects(readTokensFile(join(dir, 'folder')), /--tokens: ".*folder" is not a regular file\./);
});

test('readTokensFile: 262143 bytes are fine, 262144 bytes and a NUL byte are errors', async () => {
  const ok = join(dir, 'ok.css');
  await writeFile(ok, 'a'.repeat(262143));
  assert.equal((await readTokensFile(ok)).length, 262143);
  const big = join(dir, 'big.css');
  await writeFile(big, 'a'.repeat(262144));
  await assert.rejects(readTokensFile(big), /larger than 256 KB \(262144 bytes\)/);
  const nul = join(dir, 'nul.css');
  await writeFile(nul, Buffer.from('a\u0000b'));
  await assert.rejects(readTokensFile(nul), /not a text file/);
  const bad = join(dir, 'bad.css');
  await writeFile(bad, Buffer.from([0xff, 0xfe, 0x41]));
  await assert.rejects(readTokensFile(bad), /not valid UTF-8/);
});

test('skinFromCookie: only a valid pv-skin value counts; the alias is applied; nothing else is read', () => {
  assert.equal(skinFromCookie('pv-skin=metal'), 'metal');
  assert.equal(skinFromCookie('a=b; pv-skin=plain; c=d'), 'light');
  assert.equal(skinFromCookie('other=metal'), null);
  assert.equal(skinFromCookie('pv-skin=gold'), null);
  assert.equal(skinFromCookie('pv-skin='), null);
  assert.equal(skinFromCookie('pv-skin=__proto__'), null);
  assert.equal(skinFromCookie(undefined), null);
  assert.equal(skinFromCookie('x'.repeat(5000)), null);
});

test('skinCookieHeader: exact attributes, and only canonical skin names', () => {
  assert.equal(skinCookieHeader('metal'), 'pv-skin=metal; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly');
  assert.throws(() => skinCookieHeader('plain'));
  assert.throws(() => skinCookieHeader('x; Path=/evil'));
});
