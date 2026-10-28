// The server's check for "is this file inside the docs folder".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInside } from '../src/server.js';

test('files below the folder are inside, the folder itself and its parent are not', () => {
  assert.equal(isInside('/docs', '/docs/a.md'), true);
  assert.equal(isInside('/docs', '/docs/sub/a.md'), true);
  assert.equal(isInside('/docs', '/docs'), false);
  assert.equal(isInside('/docs', '/other/a.md'), false);
  assert.equal(isInside('/docs', '/a.md'), false);
});

test('a name that merely starts with two dots is still inside', () => {
  assert.equal(isInside('/docs', '/docs/..notes/a.md'), true);
  assert.equal(isInside('/docs', '/docs/..a.md'), true);
});
