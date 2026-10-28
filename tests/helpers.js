// Shared helpers for the tests.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile, readdir, mkdir, copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';

const fixtureRoot = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Absolute path of a fixture folder or file, for example fixture('pyramid'). */
export function fixture(...parts) {
  return join(fixtureRoot, ...parts);
}

/** Text of a file inside the main fixture. */
export function fixtureText(relPath) {
  return readFile(fixture('pyramid', relPath), 'utf8');
}

/** Copy a folder tree with plain readdir and copyFile (fs.cp is avoided on purpose). Symlinks are skipped. */
export async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else if (entry.isFile()) await copyFile(source, target);
  }
}

/** A temporary copy of a fixture folder. Returns the path of the copy and a cleanup function. */
export async function tempFixture(name = 'pyramid') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pv-fixture-')));
  const root = join(base, name);
  await copyTree(fixture(name), root);
  return { base, root, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/** Run a command line in a child process. Resolves with the exit code and the collected output. */
export async function runCli(args, { cwd, node = process.execPath } = {}) {
  const { execFile } = await import('node:child_process');
  const viewer = fileURLToPath(new URL('../viewer.js', import.meta.url));
  return new Promise((resolve) => {
    execFile(node, [viewer, ...args], { cwd, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

/** All files below a folder, as sorted forward-slash paths relative to it. */
export async function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else out.push(rel);
  }
  return out.sort();
}

/** Split a page into its text without templates and the embedded templates (page attribute and inner HTML). */
export function splitTemplates(html) {
  const templates = [];
  const main = html.replace(/<template data-pv-page="([^"]*)">([\s\S]*?)<\/template>\n?/g, (all, page, inner) => {
    templates.push({ page, html: inner });
    return '';
  });
  return { main, templates };
}

/**
 * Walk every html page of an export folder and check each href and src the way a browser opening the files
 * from file:// would: the target file must exist, and a fragment must name an id in the target page.
 * Links that the link policy leaves as written (outside the root, not exported) can be allowed by pattern.
 * Links with a scheme (external links written by the document authors) are only collected, not resolved.
 * @returns {Promise<{pages: string[], checked: number, problems: string[], absoluteResources: string[], external: string[]}>}
 */
export async function walkExport(outDir, { allowUnresolved = [] } = {}) {
  const { stat } = await import('node:fs/promises');
  const { posix } = await import('node:path');
  const files = (await listFiles(outDir)).filter((f) => f.endsWith('.html'));
  const cache = new Map();
  const idsOf = async (file) => {
    if (!cache.has(file)) {
      const html = splitTemplates(await readFile(join(outDir, ...file.split('/')), 'utf8')).main;
      cache.set(file, new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1])));
    }
    return cache.get(file);
  };
  const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const problems = [];
  const absoluteResources = [];
  const external = [];
  let checked = 0;
  for (const file of files) {
    const whole = splitTemplates(await readFile(join(outDir, ...file.split('/')), 'utf8'));
    // Each embedded fragment is checked as if it were its own page: its links are relative to that page.
    const parts = [{ page: file, html: whole.main }, ...whole.templates.map((t) => ({ page: posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(t.page))), html: t.html }))];
    for (const { page, html } of parts) for (const tag of html.matchAll(/<(a|link|script|img|source|iframe)\b[^>]*>/g)) {
      for (const attr of tag[0].matchAll(/\s(href|src)="([^"]*)"/g)) {
        const url = unescape(attr[2]);
        const isResource = tag[1] !== 'a';
        if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) {
          if (isResource) absoluteResources.push(`${page}: ${url}`);
          else external.push(url);
          continue;
        }
        if (url.startsWith('/')) {
          absoluteResources.push(`${page}: ${url}`);
          continue;
        }
        checked++;
        const hash = url.indexOf('#');
        const filePart = hash === -1 ? url : url.slice(0, hash);
        const fragment = hash === -1 ? '' : decodeURIComponent(url.slice(hash + 1));
        const target = filePart === '' ? page : posix.normalize(posix.join(posix.dirname(page), decodeURIComponent(filePart)));
        try {
          if (!(await stat(join(outDir, ...target.split('/')))).isFile()) throw new Error('not a file');
        } catch {
          if (!allowUnresolved.some((re) => re.test(url))) problems.push(`${page}: ${url} -> missing ${target}`);
          continue;
        }
        if (fragment && target.endsWith('.html') && !(await idsOf(target)).has(fragment)) {
          problems.push(`${page}: ${url} -> no id "${fragment}" in ${target}`);
        }
      }
    }
  }
  return { pages: files, checked, problems, absoluteResources, external };
}

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
export function contrast(a, b) {
  const luminance = (hex) => {
    const channel = (i) => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix two #rrggbb colours: share is the part of b (0 to 1). */
export function blend(a, b, share) {
  const channel = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(channel(a, i) * (1 - share) + channel(b, i) * share).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Checks that work grows about linearly with its input, without depending on how fast or how busy the machine
 * is. measure(n) does the work for input size n and returns the seconds it took (build the input before starting
 * the clock). Each size is timed as the best of several runs. When the small input is too quick to measure
 * (under 50 ms) both sizes are multiplied by 4, up to four times and never beyond maxLarge, so that a quadratic
 * algorithm cannot hide behind tiny times. The test fails when the large input costs more than two and a half
 * times what its size ratio allows (linear needs about 4 times the time for 4 times the input, quadratic about 16).
 * @param {(n: number) => Promise<number>|number} measure
 * @param {number} small
 * @param {number} large
 * @param {{runs?: number, label?: string, maxLarge?: number}} [options]
 */
export async function assertLinearGrowth(measure, small, large, { runs = 3, label = 'work', maxLarge = Infinity } = {}) {
  const best = async (n) => {
    let fastest = Infinity;
    for (let i = 0; i < runs; i++) fastest = Math.min(fastest, await measure(n));
    return fastest;
  };
  const { default: assert } = await import('node:assert/strict');
  let quick = await best(small);
  for (let step = 0; step < 4 && quick < 0.05 && large * 4 <= maxLarge; step++) {
    small *= 4;
    large *= 4;
    quick = await best(small);
  }
  quick = Math.max(quick, 0.001);
  const slow = await best(large);
  const allowed = (large / small) * 2.5;
  assert.ok(slow / quick < allowed, `${label}: ${large / small} times the input (${small} to ${large}) took ${(slow / quick).toFixed(1)} times as long (${quick.toFixed(3)} s, ${slow.toFixed(3)} s); the limit is ${allowed}`);
}

/** Seconds since a start taken with process.hrtime.bigint(). */
export function secondsSince(start) {
  return Number(process.hrtime.bigint() - start) / 1e9;
}
