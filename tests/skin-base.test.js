// Base stylesheet: structure only, every look value a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TINT_COUNT } from '../src/pages.js';
import { tokenValue } from './skin-theme.js';

const read = (name) => readFile(new URL(`../skins/${name}`, import.meta.url), 'utf8');
const base = await read('pv-base.css');
const light = await read('light.css');
const metal = await read('metal.css');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('base defines no colour, no font and no radius: no hex, rgb, hsl, font name or image, only tokens', () => {
  const css = stripComments(base);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  // A colour function may only wrap tokens (rgb(var(--...)) builds a colour from a theme's red, green, blue triplet).
  assert.doesNotMatch(css, /\brgba?\((?!var\()|\bhsla?\(/);
  assert.doesNotMatch(css, /url\(|@import|@font-face|https?:\/\//);
  assert.doesNotMatch(css, /font-family:\s*(?!var\()\S/);
  assert.doesNotMatch(css, /position:\s*fixed|background-attachment/);
});

test('every token that base or metal use is defined in both themes (metal-only tokens in metal only)', () => {
  const defined = (css) => new Set([...css.matchAll(/(--pv-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = (css) => new Set([...css.matchAll(/var\((--pv-[a-z0-9-]+)/g)].map((m) => m[1]));
  const baseOwn = defined(base);
  const metalOnly = new Set(['--pv-grain', '--pv-grain-strength', '--pv-grain-strength-frame', '--pv-light-strength', '--pv-light-x', '--pv-light-y', '--pv-glow', '--pv-plate', '--pv-bevel']);
  // Properties set by the layer and dialog rules, or by the script, are not theme tokens.
  const local = new Set(['--pv-brick-bg', '--pv-brick-text', '--pv-brick-border', '--pv-brick-hover', '--pv-label-bg', '--pv-dialog-accent', '--pv-dialog-glow', '--pv-dialog-frame', '--pv-dialog-rule', '--pv-from-x', '--pv-from-y']);
  for (const name of used(base)) {
    if (local.has(name) || baseOwn.has(name) && /--pv-(ease|dur|stagger)/.test(name)) continue;
    assert.ok(defined(light).has(name), `${name} is not defined in light.css`);
    assert.ok(defined(metal).has(name), `${name} is not defined in metal.css`);
  }
  for (const name of used(metal)) {
    if (local.has(name) || baseOwn.has(name)) continue;
    assert.ok(defined(metal).has(name), `${name} is not defined in metal.css`);
  }
  for (const name of metalOnly) assert.ok(!defined(light).has(name), `${name} must not be in light.css`);
});

test('the layer tint rules have the exact shape, six tints and no seventh', () => {
  for (let i = 0; i < TINT_COUNT; i++) {
    assert.match(base, new RegExp(`\\.layer\\[data-tint="${i}"\\]\\s*\\{\\s*--pv-brick-bg:\\s*var\\(--pv-tint-${i}\\);\\s*--pv-brick-text:\\s*var\\(--pv-tint-${i}-text\\)`));
    assert.match(base, new RegExp(`\\.pv-dialog\\[data-tint="${i}"\\]\\s*\\{\\s*--pv-dialog-accent:\\s*var\\(--pv-tint-${i}-pill\\)`));
  }
  assert.doesNotMatch(base, new RegExp(`data-tint="${TINT_COUNT}"`));
});

test('dialog: flex column when open, two columns inside, tinted frame with a plain fallback, Back button hides', () => {
  assert.match(base, /\.pv-dialog\[open\]\s*\{[^}]*display:\s*flex/);
  assert.match(base, /\.pv-dialog-main\s*\{[^}]*display:\s*flex/);
  assert.match(base, /\.pv-dialog-toc\s*\{[^}]*flex:\s*0 0 calc\(var\(--pv-toc-width\) \+ 12px\)/);
  assert.match(base, /\.pv-dialog-button\[hidden\]\s*\{\s*display:\s*none/);
  const frame = /\.pv-dialog\s*\{([^}]*)\}/.exec(base)[1];
  assert.ok(frame.indexOf('background: var(--pv-dialog-bg)') < frame.indexOf('color-mix('), 'the plain value comes first, as the fallback');
  assert.match(base, /@media \(max-width: 47\.5rem\)\s*\{\s*\.pv-dialog-toc\s*\{\s*display:\s*none/);
  assert.match(base, /@media \(max-width: 40rem\)\s*\{\s*\.pv-dialog\s*\{\s*width:\s*calc\(100% - 2 \* var\(--pv-dialog-inset, 0\.75rem\)\);\s*height:\s*calc\(100% - 2 \* var\(--pv-dialog-inset, 0\.75rem\)\)/);
});

test('focus: visible rings on links, buttons and summaries; the dialog body ring is drawn inside', () => {
  assert.match(base, /a:focus-visible,\s*summary:focus-visible,\s*button:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--pv-focus\)/);
  assert.match(base, /\.pv-dialog-body:focus-visible\s*\{[^}]*outline-offset:\s*-/);
});

test('motion: only opacity and transform animate, no transition all, hover only on hover devices, reduced motion and print blocks exist', () => {
  const css = stripComments(base);
  for (const m of css.matchAll(/transition:\s*([^;]+);/g)) assert.match(m[1], /^(opacity|transform|none)\b/, m[0]);
  assert.doesNotMatch(css, /transition:\s*all|transition-property:\s*all/);
  const frames = [...css.matchAll(/@keyframes[^{]+\{([\s\S]*?\n\})\s*\n/g)].map((m) => m[1]);
  assert.ok(frames.length >= 4);
  for (const f of frames) assert.doesNotMatch(f.replace(/(opacity|transform):\s*[^;]+;/g, ''), /[a-z-]+:\s*[^;]+;/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)\s*\{\s*\.brick a:hover,\s*\.decision a:hover\s*\{\s*transform:\s*translateY\(-2px\)/);
  assert.match(css, /\.brick a:active,\s*\.decision a:active\s*\{\s*transform:\s*scale\(0\.97\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce\)\s*\{\s*\.pv-dialog,\s*\.pv-dialog::backdrop\s*\{\s*animation:\s*none/);
  assert.match(css, /prefers-reduced-motion[\s\S]*transition:\s*none/);
  assert.match(css, /@media print/);
  // The motion tokens are the only tokens that base defines, and they are plain durations and curves.
  assert.match(tokenValue(base, 'pv-dur-enter'), /^200ms$/);
});

test('the layer label is a pill or an eyebrow depending only on tokens', () => {
  const label = /\n\.layer-label\s*\{([^}]*)\}/.exec(base)[1];
  for (const token of ['--pv-pill-pad', '--pv-pill-radius', '--pv-label-bg', '--pv-pill-text', '--pv-pill-tracking', '--pv-pill-size']) assert.ok(label.includes(token), token);
  assert.match(label, /text-transform:\s*uppercase/);
});

test('the left navigation marks the current link with a bar in the active colour, in the dialog and in the tree', () => {
  assert.match(base, /\.pv-dialog-toc a\[aria-current\],\s*\.tree a\[aria-current\]\s*\{[^}]*color:\s*var\(--pv-nav-link-active\);[^}]*border-left-color:\s*var\(--pv-nav-active-bar\)/);
});
