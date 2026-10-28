// Light theme: contrast of every text token pair, computed from the
// token values, and the rules of the theme file (tokens only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerThemeTests, hexToken, tokenValue } from './skin-theme.js';

const css = await readFile(new URL('../skins/light.css', import.meta.url), 'utf8');
registerThemeTests('light', css);

test('light theme holds tokens only: no rule outside the :root block, no image, import, web font or remote URL', () => {
  // The compact density is a second block of tokens, set on the body when --density compact is used.
  const density = /body\[data-density="compact"\]\s*\{([^}]*)\}/.exec(css);
  assert.ok(density, 'the compact density block exists');
  assert.equal(density[1].replace(/\/\*[\s\S]*?\*\//g, '').split(';').map((d) => d.trim()).filter((d) => d && !d.startsWith('--pv-')).length, 0, 'only tokens in the density block');
  const outside = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/:root\s*\{[\s\S]*?\n\}/, '').replace(/body\[data-density="compact"\]\s*\{[^}]*\}/, '').trim();
  assert.equal(outside, '');
  assert.doesNotMatch(css, /url\(|@import|@font-face|https?:\/\//);
});

test('light theme: a flat look with pills, a Geist-first font stack and no metal-only token', () => {
  assert.equal(tokenValue(css, 'pv-pill-radius'), '9999px');
  assert.match(tokenValue(css, 'pv-font'), /^"Geist",/);
  assert.match(tokenValue(css, 'pv-mono'), /^"Geist Mono",/);
  assert.doesNotMatch(css, /--pv-grain|--pv-light-|--pv-glow|gradient/);
  assert.equal(hexToken(css, 'pv-accent'), '#00adef');
});
