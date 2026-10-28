// Vendored library checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const vendorDir = new URL('../vendor/', import.meta.url);

async function vendoredFile() {
  const bytes = await readFile(new URL('markdown-it.esm.min.mjs', vendorDir));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

test('the vendored markdown-it file has a version banner', async () => {
  const { bytes } = await vendoredFile();
  const banner = bytes.toString('utf8', 0, 200);
  const match = /markdown-it (\d+\.\d+\.\d+)/.exec(banner);
  assert.ok(match, 'version banner missing at the top of the vendored file');
  const [major, minor, patch] = match[1].split('.').map(Number);
  const atLeast = major > 15 || (major === 15 && (minor > 0 || patch >= 3));
  assert.ok(atLeast, `markdown-it ${match[1]} is older than 15.0.3`);
  const notice = await readFile(new URL('NOTICE.md', vendorDir), 'utf8');
  assert.ok(notice.includes(match[1]), 'NOTICE.md does not name the vendored version');
});

test('the vendored file hash is recorded in NOTICE.md (a changed file needs a version note)', async () => {
  const { sha256 } = await vendoredFile();
  const notice = await readFile(new URL('NOTICE.md', vendorDir), 'utf8');
  assert.ok(
    notice.includes(sha256),
    `vendor/markdown-it.esm.min.mjs has sha256 ${sha256}, which NOTICE.md does not record. ` +
      'Update the version and the hash in NOTICE.md and add a version history line.'
  );
});

test('NOTICE.md names every bundled package and its licence', async () => {
  const notice = await readFile(new URL('NOTICE.md', vendorDir), 'utf8');
  for (const name of ['markdown-it', 'mdurl', 'uc.micro', 'linkify-it', 'punycode.js', 'entities']) {
    assert.ok(notice.includes(`### ${name} `), `NOTICE.md has no section for ${name}`);
  }
  assert.ok(notice.includes('BSD-2-Clause'));
  assert.ok(notice.includes('Permission is hereby granted, free of charge'));
  assert.ok(notice.includes('Unverified'), 'NOTICE.md must say what is unverified');
});
