// The motion tokens that the live script reads must be defined in the base stylesheet,.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const base = read('../skins/pv-base.css');
const live = read('../assets/pv-live.js');

function tokensOf(css) {
  const map = new Map();
  const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  for (const m of rootBlock.matchAll(/^\s*(--pv-[a-z0-9-]+):\s*(.+?);\s*$/gm)) map.set(m[1], m[2]);
  return map;
}

test('every motion token that the live script reads is defined in the base file', () => {
  const defined = tokensOf(base);
  const read = new Set([...live.matchAll(/'(--pv-(?:dur|ease|stagger)[a-z-]*)'/g)].map((m) => m[1]));
  assert.ok(read.size >= 4, 'the live script reads motion tokens');
  for (const name of read) assert.ok(defined.has(name), `${name} is defined in pv-base.css`);
});
