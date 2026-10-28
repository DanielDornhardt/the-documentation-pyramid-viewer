// Shared checks of a theme file. Used by skin-light.test.js and
// skin-metal.test.js. Colour tokens written as six-digit hex are read from the theme file and their contrast
// is computed (WCAG 2.x). A tokens file of a user is not checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, blend } from './helpers.js';
import { TINT_COUNT } from '../src/pages.js';

/** Read the value of a custom property from CSS text (first definition). */
export function tokenValue(css, name) {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  assert.ok(m, `custom property --${name} not found`);
  return m[1].trim();
}

export function hexToken(css, name) {
  const value = tokenValue(css, name);
  assert.match(value, /^#[0-9a-fA-F]{6}$/, `--${name} must be a six-digit hex colour, is ${value}`);
  return value.toLowerCase();
}

/** Text pairs that every theme must keep at 4.5:1: foreground token, background token. */
export const TEXT_PAIRS = [
  ['pv-text', 'pv-bg'],
  ['pv-text-strong', 'pv-bg'],
  ['pv-muted', 'pv-bg'],
  ['pv-intro-color', 'pv-bg'],
  ['pv-link', 'pv-bg'],
  ['pv-link-hover', 'pv-bg'],
  ['pv-text', 'pv-surface'],
  ['pv-surface-text', 'pv-surface'],
  ['pv-muted', 'pv-surface'],
  ['pv-link', 'pv-surface'],
  ['pv-paper-text', 'pv-paper'],
  ['pv-paper-muted', 'pv-paper'],
  ['pv-paper-link', 'pv-paper'],
  ['pv-paper-text', 'pv-code-bg'],
  ['pv-paper-muted', 'pv-code-bg'],
  ['pv-paper-link', 'pv-code-bg'],
  ['pv-pre-text', 'pv-pre-bg'],
  ['pv-dialog-text', 'pv-dialog-bg'],
  ['pv-dialog-text', 'pv-dialog-header-bg'],
  ['pv-nav-link', 'pv-dialog-bg'],
  ['pv-nav-link-sub', 'pv-dialog-bg'],
  ['pv-nav-link-active', 'pv-dialog-bg'],
  ['pv-nav-link', 'pv-surface'],
  ['pv-nav-link-sub', 'pv-surface'],
  ['pv-nav-link-active', 'pv-surface'],
  ['pv-button-text', 'pv-button-bg'],
  ['pv-button-text', 'pv-button-hover-bg']
];

/** Non-text pairs (borders that carry meaning, focus rings, the active marker): 3:1. */
export const NON_TEXT_PAIRS = [
  ['pv-border', 'pv-bg'],
  ['pv-border', 'pv-surface'],
  ['pv-focus', 'pv-bg'],
  ['pv-focus', 'pv-surface'],
  ['pv-focus', 'pv-dialog-bg'],
  ['pv-nav-active-bar', 'pv-surface'],
  ['pv-nav-active-bar', 'pv-dialog-bg'],
  // Inside the reading surface the focus ring takes the paper link colour.
  ['pv-paper-link', 'pv-paper']
];

/**
 * Register the contrast tests of one theme.
 * @param {string} name Theme name for the test titles.
 * @param {string} css Theme file text.
 * @param {{lit?: number}} [options] lit: share of white that the theme's overlay adds at the lightest point of a brick (metal).
 */
export function registerThemeTests(name, css, { lit = 0 } = {}) {
  for (const [fg, bg, note] of TEXT_PAIRS) {
    test(`${name} theme contrast ${fg} on ${bg}${note ? ` (${note})` : ''} is at least 4.5:1`, (t) => {
      const ratio = contrast(hexToken(css, fg), hexToken(css, bg));
      t.diagnostic(`${hexToken(css, fg)} on ${hexToken(css, bg)}: ${ratio.toFixed(2)}:1`);
      assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1`);
    });
  }

  for (const [fg, bg] of NON_TEXT_PAIRS) {
    test(`${name} theme non-text contrast ${fg} on ${bg} is at least 3:1`, () => {
      const ratio = contrast(hexToken(css, fg), hexToken(css, bg));
      assert.ok(ratio >= 3, `${ratio.toFixed(2)}:1`);
    });
  }

  test(`${name} theme: every layer tint keeps brick text at 4.5:1 on the tint, the hover tint and the lit tint`, () => {
    for (let i = 0; i < TINT_COUNT; i++) {
      const text = hexToken(css, `pv-tint-${i}-text`);
      const tints = [hexToken(css, `pv-tint-${i}`), hexToken(css, `pv-tint-${i}-hover`)];
      if (lit > 0) tints.push(blend(tints[0], '#ffffff', lit));
      for (const bg of tints) assert.ok(contrast(text, bg) >= 4.5, `tint ${i}: ${text} on ${bg} is ${contrast(text, bg).toFixed(2)}:1`);
    }
  });

  test(`${name} theme: a layer label keeps its text at 4.5:1`, () => {
    for (let i = 0; i < TINT_COUNT; i++) {
      const pill = tokenValue(css, `pv-tint-${i}-pill`);
      if (!/^#[0-9a-fA-F]{6}$/.test(pill)) {
        // No pill is drawn: the label is an eyebrow on the page.
        assert.equal(pill, 'transparent', `tint ${i}: a pill is a hex colour or transparent`);
        assert.ok(contrast(hexToken(css, 'pv-pill-text'), hexToken(css, 'pv-bg')) >= 4.5, 'eyebrow text on the page');
        continue;
      }
      const ratio = contrast(hexToken(css, 'pv-pill-text'), pill);
      assert.ok(ratio >= 4.5, `tint ${i}: ${ratio.toFixed(2)}:1`);
    }
  });

  test(`${name} theme: the tinted dialog frame and header keep their text at 4.5:1 for every tint`, () => {
    const hexOfTriplet = (triplet) => `#${triplet.split(',').map((v) => Number(v.trim()).toString(16).padStart(2, '0')).join('')}`;
    for (let i = 0; i < TINT_COUNT; i++) {
      const glow = hexOfTriplet(tokenValue(css, `pv-tint-${i}-glow`));
      for (const [frame, mixName] of [['pv-dialog-bg', 'pv-dialog-accent-mix'], ['pv-dialog-header-bg', 'pv-dialog-header-mix']]) {
        const bg = blend(hexToken(css, frame), glow, Number.parseFloat(tokenValue(css, mixName)) / 100);
        for (const fg of ['pv-dialog-text', 'pv-nav-link', 'pv-nav-link-sub', 'pv-nav-link-active']) {
          assert.ok(contrast(hexToken(css, fg), bg) >= 4.5, `${fg} on ${frame} mixed with tint ${i}: ${contrast(hexToken(css, fg), bg).toFixed(2)}:1`);
        }
      }
    }
  });

  test(`${name} theme defines exactly the tints 0 to ${TINT_COUNT - 1}, each with text, border, hover and pill`, () => {
    const found = new Set([...css.matchAll(/--pv-tint-(\d+)(-[a-z]+)?:/g)].map((m) => Number(m[1])));
    assert.deepEqual([...found].sort(), [...Array(TINT_COUNT).keys()]);
    for (let i = 0; i < TINT_COUNT; i++) {
      for (const suffix of ['', '-text', '-border', '-hover', '-pill', '-glow']) tokenValue(css, `pv-tint-${i}${suffix}`);
    }
  });
}
