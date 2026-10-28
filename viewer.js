// Pyramid viewer.
//
// This file holds the pure building blocks: layer discovery, headings and slugs, titles, row layout,
// the safe markdown renderer, link rewriting and the request path guard. Importing it starts nothing:
// the command line only runs when the file is started directly (see the guard at the end).
//
// Only stable Node APIs and the one vendored markdown library are used.

import './src/node-guard.js'; // first on purpose: stops with a clear message on a Node version below the floor
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, sep, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from './src/cli.js';
import MarkdownIt from './vendor/markdown-it.esm.min.mjs';

/**
 * One document file that belongs to a layer.
 * @typedef {object} DocFile
 * @property {string} path Path relative to the docs root, with forward slashes.
 * @property {string} name File name.
 * @property {string} title Title derived from the path.
 */

/**
 * A layer as written in a config file (pyramid.json or a layers file).
 * @typedef {object} LayerConfig
 * @property {string} id Short identifier, for example "L3".
 * @property {string} label Text shown for the layer.
 * @property {string} path Path relative to the docs root.
 * @property {'file'|'folder'} kind
 * @property {'index'|'headings'|'file'|'modules'} [bricks] Which documents make bricks: "index" the second-level headings of the
 *   folder's index file only, "headings" the second-level headings of every file, "file" one brick per file,
 *   "modules" the second-level headings of the layer file, then one brick per broken-out file of the folder with the
 *   same name. Default: see resolveBricksMode.
 * @property {string[]} [include] Extra documents (paths relative to the docs root) whose headings also make bricks in "index" mode.
 * @property {boolean} [decisions] A decision-record block, shown apart from the growing rows.
 * @property {string} [description] One line shown under the layer label in the pyramid view.
 */

/**
 * A discovered layer: configuration plus the ordered files that exist.
 * @typedef {object} Layer
 * @property {string} id
 * @property {string} label
 * @property {'file'|'folder'} kind
 * @property {string} path
 * @property {'index'|'headings'|'file'|'modules'} bricks The mode in use (the default is resolved once the files are known).
 * @property {string[]} include Extra documents that make bricks in "index" mode; each is a file of this layer.
 * @property {boolean} decisions
 * @property {string} [description] One line shown under the layer label; absent when there is none.
 * @property {DocFile[]} files In reading order. A layer made of a layer file and a folder with the same name lists the layer file first, then the folder files by name.
 * @property {string|null} [layerFile] Path of the layer file when the layer is a layer file plus a same-name folder; null when only the folder exists.
 * @property {string} [folder] Path of the folder with the broken-out files, set only for such a layer.
 * @property {string|null} [folderIndex] Path of an index.md inside that folder when a layer file exists too (listed as an ordinary document).
 */

/**
 * A heading of level 1 to 4 taken from the token stream.
 * @typedef {object} Heading
 * @property {number} level 1 to 4.
 * @property {string} text Plain text (entities decoded, markup removed).
 * @property {string} slug Unique id within the file; also the id injected into the page.
 */

/**
 * One brick of the pyramid picture.
 * @typedef {object} Brick
 * @property {string} layerId
 * @property {string} label
 * @property {string} path Document path relative to the docs root.
 * @property {string|null} slug Heading id to link to, or null for the document start.
 */

/**
 * Counts and warnings about links met while rendering or exporting.
 * @typedef {object} LinkReport
 * @property {{rewritten:number, external:number, fragment:number, outsideRoot:number, notExported:number, missingFragment:number}} counts
 * @property {{source:string, href:string, reason:'outside-root'|'not-exported'|'fragment-not-found'}[]} warnings
 */

/**
 * Short descriptions of the default layers, shown under the layer labels. They apply only to layers that are
 * found by name (L1 to L4 and adr/); other detected layers get none, and layers from a config file carry
 * their own optional "description".
 */
export const DEFAULT_LAYER_DESCRIPTIONS = {
  L1: 'Business context, product strategy',
  L2: 'Tech stack, subsystems, data flow',
  L3: 'How each part works',
  L4: 'Git, setup, tests, day-to-day',
  adr: 'Decision records'
};

/** Largest file the viewer reads (bytes). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Most headings of one file that the viewer lists; later ones get no id and no brick. Keeps a hostile file cheap. */
export const MAX_HEADINGS = 5000;

const DEFAULT_CONCURRENCY = 8;

/** The values of the layer option "bricks". */
export const BRICK_MODES = ['index', 'headings', 'file', 'modules'];

/** An error in a layer configuration. The command line prints its message and exits with code 1, without a stack trace. */
export class LayerConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LayerConfigError';
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers

/**
 * Escape text for use in HTML content and quoted attributes.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Byte-wise comparison of two strings (UTF-8), the order used for file names. */
function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Run an async function over items with a bounded number in flight, keeping the result order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function isInside(rootReal, candidate) {
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  return candidate === rootReal || candidate.startsWith(prefix);
}

// ---------------------------------------------------------------------------------------------
// Source text, front matter, slugs, headings

/**
 * Remove a byte order mark and make all line endings LF.
 * @param {string} text
 */
export function normalizeSource(text) {
  return String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * Remove front matter: a block that starts on the first line with "---" and ends at the next line that is
 * exactly "---" or "...". An opening line followed by a blank line is a horizontal rule, not front matter.
 * Expects LF line endings (use normalizeSource first).
 * @param {string} text
 */
export function stripFrontMatter(text) {
  if (!text.startsWith('---\n')) return text;
  const lines = text.split('\n');
  if (lines[1] !== undefined && lines[1].trim() === '') return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') return lines.slice(i + 1).join('\n');
  }
  return text;
}

// html is on only so that the parser knows HTML blocks and comments (a "##" line inside one is not a heading).
// Both HTML renderer rules are replaced below, so raw HTML is always written out as escaped text.
const md = new MarkdownIt({ html: true, linkify: false, typographer: false });
md.renderer.rules.html_inline = (tokens, idx) => escapeHtml(tokens[idx].content);
md.renderer.rules.html_block = (tokens, idx) => `<p class="raw-html">${escapeHtml(tokens[idx].content.replace(/\n+$/, ''))}</p>\n`;

/**
 * The one slug rule: decode entities, lowercase, keep Unicode letters, marks, digits, underscore and
 * hyphen, remove other punctuation, turn whitespace runs into one hyphen, trim hyphens.
 * May return an empty string; use a slugger to get unique ids.
 * @param {string} text
 * @param {{decoded?: boolean}} [options] Pass decoded: true when entities are already decoded (token text).
 * @returns {string}
 */
export function slugify(text, options = {}) {
  const decoded = options.decoded ? String(text) : md.utils.unescapeAll(String(text));
  return decoded
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Make a function that turns heading text into slugs that are unique within one file.
 * The first heading keeps the plain slug; later ones get -1, -2 ... in document order. A counter per base slug
 * keeps this cheap even for thousands of duplicates. Slugs in the optional reserved set (headings whose own
 * text gives exactly that slug) are never handed out as a duplicate number.
 * An empty slug becomes "section". This is the only place that numbers duplicates.
 * @param {Set<string>} [reserved]
 * @returns {(text: string, options?: {decoded?: boolean}) => string}
 */
export function createSlugger(reserved = new Set()) {
  const used = new Set();
  const nextNumber = new Map();
  return (text, options) => {
    const base = slugify(text, options) || 'section';
    let slug = base;
    if (used.has(slug)) {
      let n = nextNumber.get(base) || 1;
      slug = `${base}-${n}`;
      while (used.has(slug) || reserved.has(slug)) slug = `${base}-${++n}`;
      nextNumber.set(base, n + 1);
    }
    used.add(slug);
    return slug;
  };
}

/** Plain text of an inline token: text, code, image alt text; line breaks as spaces. */
function inlineText(inline) {
  let out = '';
  for (const child of inline.children || []) {
    if (child.type === 'text' || child.type === 'text_special' || child.type === 'html_inline' || child.type === 'code_inline' || child.type === 'image') {
      out += child.content;
    } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
      out += ' ';
    }
  }
  return out;
}

/**
 * Walk a token stream and list headings of level 1 to 4 with unique slugs, plus the token index of each.
 * Used by both the extraction and the renderer, so ids and lists always agree.
 */
function scanHeadings(tokens) {
  const raw = [];
  for (let i = 0; i < tokens.length && raw.length < MAX_HEADINGS; i++) {
    const token = tokens[i];
    // Only top-level headings count. One inside a blockquote or a list item is part of that block, and the refresh
    // tool ignores it too, so the viewer, the exports and the routing table agree on a document's headings.
    if (token.type !== 'heading_open' || token.level !== 0) continue;
    const level = Number(token.tag.slice(1));
    if (level > 4) continue;
    const text = inlineText(tokens[i + 1]).replace(/\s+/g, ' ').trim();
    raw.push({ index: i, line: token.map ? token.map[0] : null, level, text });
  }
  // Pass one: the slugs the heading texts give on their own. A duplicate number must not take one of them.
  const reserved = new Set(raw.map((h) => slugify(h.text, { decoded: true }) || 'section'));
  const slug = createSlugger(reserved);
  return raw.map((h) => ({ ...h, slug: slug(h.text, { decoded: true }) }));
}

/**
 * Headings (levels 1 to 4) of a token stream.
 * @param {object[]} tokens markdown-it tokens
 * @returns {Heading[]}
 */
export function headingsFromTokens(tokens) {
  return scanHeadings(tokens).map(({ level, text, slug }) => ({ level, text, slug }));
}

/**
 * Headings of a markdown source: front matter stripped, CRLF normalised, fenced code excluded.
 * @param {string} source
 * @returns {Heading[]}
 */
export function extractHeadings(source) {
  return headingsFromTokens(md.parse(stripFrontMatter(normalizeSource(source)), {}));
}

/**
 * The token index of the "##" heading that is the title of a document without an h1, or -1. That is the first
 * block of the document (HTML comments may come before it) when it is a level-2 heading and no h1 exists anywhere.
 * The renderer shows such a heading as the h1 element; the tree view and the Markdown table of contents treat it as
 * the document's own entry instead of listing it again.
 */
function titleHeadingIndex(tokens) {
  if (tokens.some((t) => t.type === 'heading_open' && t.tag === 'h1')) return -1;
  let first = 0;
  while (first < tokens.length && tokens[first].type === 'html_block' && /^\s*<!--[\s\S]*-->\s*$/.test(tokens[first].content)) first++;
  const open = tokens[first];
  return open && open.type === 'heading_open' && open.tag === 'h2' && tokens[first + 2]?.type === 'heading_close' ? first : -1;
}

/**
 * Headings of a markdown source, and whether the document starts with a "##" title and has no h1 (titleAtTop; see
 * titleHeadingIndex). One parse gives both.
 * @param {string} source
 * @returns {{headings: Heading[], titleAtTop: boolean}}
 */
export function scanDocument(source) {
  const tokens = md.parse(stripFrontMatter(normalizeSource(source)), {});
  return { headings: headingsFromTokens(tokens), titleAtTop: titleHeadingIndex(tokens) >= 0 };
}

/**
 * Prepare a markdown source for the Markdown export: normalised text without front matter, the headings
 * (same list as extractHeadings, each with the 0-based line where it starts) and the line ranges of code
 * blocks (fenced or indented), where links must not be rewritten.
 * @param {string} source
 * @returns {{text: string, headings: (Heading & {line: number})[], codeLines: Set<number>, closing: string|null, titleAtTop: boolean}}
 *   closing is the line that closes a fenced block still open at the end of the text, or null.
 */
export function analyzeForExport(source) {
  const text = stripFrontMatter(normalizeSource(source));
  const tokens = md.parse(text, {});
  const codeLines = new Set();
  const lines = text.split('\n');
  let lastMapped = null;
  for (const token of tokens) {
    if (!token.map) continue;
    // Code and HTML blocks are copied as they are: nothing inside them is a link or a heading.
    if (token.type === 'fence' || token.type === 'code_block' || token.type === 'html_block') {
      for (let line = token.map[0]; line < token.map[1]; line++) codeLines.add(line);
    }
    lastMapped = token;
  }
  // A fenced block still open at the end of the text would swallow whatever the exporter appends next.
  let closing = null;
  if (lastMapped && lastMapped.type === 'fence' && lines.slice(lastMapped.map[1]).every((l) => l.trim() === '')) {
    const { markup, map } = lastMapped;
    const closeLine = new RegExp(`^[ >]*${markup[0] === '~' ? '~' : '`'}{${markup.length},}[ \\t]*$`);
    const closed = map[1] - map[0] >= 2 && closeLine.test(lines[map[1] - 1] ?? '');
    if (!closed) closing = `${/^[ >]*/.exec(lines[map[0]])[0]}${markup}`;
  }
  const headings = scanHeadings(tokens).map(({ line, level, text: headingText, slug }) => ({ line, level, text: headingText, slug }));
  return { text, headings, codeLines, closing, titleAtTop: titleHeadingIndex(tokens) >= 0 };
}

// ---------------------------------------------------------------------------------------------
// Titles

function humanize(name) {
  const words = name.split(/[-_\s]+/).filter(Boolean).map((w) => (/[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)));
  return words.join(' ') || name;
}

/**
 * Title for a document path: "L2-architecture.md" gives "L2 Architecture"; index.md and README.md use the
 * parent folder name; words that already contain a capital letter are kept; numeric prefixes are kept.
 * @param {string} relPath Path with forward slashes.
 * @returns {string}
 */
export function titleFromPath(relPath) {
  const parts = relPath.split('/').filter(Boolean);
  const file = parts.pop() || '';
  const stem = file.replace(/\.md$/i, '');
  const isIndex = stem === 'index' || stem === 'README';
  return humanize(isIndex && parts.length ? parts[parts.length - 1] : stem);
}

/**
 * The module title of a broken-out file: its first heading of level 1 or 2 in document order (the refresh tool
 * picks the same one), else the fallback (the title made from the file name). Under the heading rule a broken-out
 * file has no H1 and starts at the module's "##" heading, the same level the module has in the layer file; a level 1
 * heading is the legacy form. The brick label, the tree view, the page title and the Markdown table
 * of contents all take the title from this one function.
 * @param {Heading[]} headings Headings of the document, in order.
 * @param {string} fallback
 * @returns {string}
 */
export function moduleTitle(headings, fallback) {
  const found = headings.find((h) => (h.level === 1 || h.level === 2) && h.text.trim() !== '');
  return found ? found.text : fallback;
}

// ---------------------------------------------------------------------------------------------
// Layer discovery

/**
 * Order the .md file names of one folder: index.md first (README.md as fallback), then byte-wise.
 * @param {string[]} names
 * @returns {string[]}
 */
export function orderFolderFiles(names) {
  const sorted = [...names].sort(compareBytes);
  const first = sorted.includes('index.md') ? 'index.md' : sorted.includes('README.md') ? 'README.md' : null;
  return first ? [first, ...sorted.filter((n) => n !== first)] : sorted;
}

/**
 * Check and normalise a layer config (JSON text, a list, or an object with a "layers" list).
 * @param {string|object} input
 * @returns {Layer[]} layers without files yet (files is an empty list)
 */
export function parseLayerConfig(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new LayerConfigError(`Layer config (pyramid.json) is not valid JSON: ${error.message}`);
    }
  }
  const list = Array.isArray(data) ? data : data && data.layers;
  if (!Array.isArray(list)) throw new LayerConfigError('Layer config: "layers" must be a list');
  const seen = new Set();
  return list.map((entry, i) => {
    const where = `Layer config entry ${i + 1}`;
    if (!entry || typeof entry !== 'object') throw new LayerConfigError(`${where}: must be an object`);
    if (typeof entry.id !== 'string' || !entry.id.trim()) throw new LayerConfigError(`${where}: "id" must be a non-empty string`);
    if (seen.has(entry.id)) throw new LayerConfigError(`${where}: duplicate id "${entry.id}"`);
    seen.add(entry.id);
    if (entry.kind !== 'file' && entry.kind !== 'folder') throw new LayerConfigError(`${where}: "kind" must be "file" or "folder"`);
    if (typeof entry.path !== 'string' || !entry.path.trim()) throw new LayerConfigError(`${where}: "path" must be a non-empty string`);
    const cleaned = entry.path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned) || cleaned.includes('\\') || cleaned.includes('\0') || cleaned.split('/').some((s) => s === '..' || s === '' || s === '.')) {
      throw new LayerConfigError(`${where}: "path" must be a relative path inside the docs folder`);
    }
    if (entry.bricks !== undefined && !BRICK_MODES.includes(entry.bricks)) {
      throw new LayerConfigError(`Layer "${entry.id}": "bricks" must be one of: ${BRICK_MODES.join(', ')} (found ${JSON.stringify(entry.bricks)})`);
    }
    if (entry.include !== undefined && (!Array.isArray(entry.include) || entry.include.some((p) => typeof p !== 'string' || !p.trim()))) {
      throw new LayerConfigError(`Layer "${entry.id}": "include" must be a list of document paths (strings, relative to the docs folder)`);
    }
    const include = [...new Set((entry.include || []).map((p) => p.trim().replace(/^(\.\/)+/, '')))];
    if (entry.decisions !== undefined && typeof entry.decisions !== 'boolean') {
      throw new LayerConfigError(`Layer "${entry.id}": "decisions" must be true or false (found ${JSON.stringify(entry.decisions)})`);
    }
    if (entry.label !== undefined && typeof entry.label !== 'string') {
      throw new LayerConfigError(`Layer "${entry.id}": "label" must be a string (found ${JSON.stringify(entry.label)})`);
    }
    const decisions = entry.decisions === true;
    if (entry.description !== undefined && typeof entry.description !== 'string') throw new LayerConfigError(`${where}: "description" must be a string`);
    const description = typeof entry.description === 'string' ? entry.description.trim() : '';
    return {
      id: entry.id,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label : humanize(cleaned.split('/').pop().replace(/\.md$/i, '')),
      kind: entry.kind,
      path: cleaned,
      // Without a value the mode is chosen after discovery, when the files of the folder are known.
      ...(entry.bricks ? { bricks: entry.bricks } : decisions ? { bricks: 'file' } : {}),
      include,
      decisions,
      ...(description ? { description } : {}),
      files: []
    };
  });
}

/** Regular .md files of a folder, ordered, as DocFile objects (index file first, or plain byte order when indexFirst is false). Skips dotfiles and anything leaving the root. */
async function listFolder(rootReal, relFolder, { indexFirst = true } = {}) {
  const abs = join(rootReal, ...relFolder.split('/'));
  let folderReal;
  try {
    folderReal = await realpath(abs);
    if (!isInside(rootReal, folderReal) || !(await stat(folderReal)).isDirectory()) return [];
  } catch {
    return [];
  }
  const names = (await readdir(folderReal)).filter((n) => !n.startsWith('.') && /\.md$/i.test(n));
  const checked = await mapLimit(names, DEFAULT_CONCURRENCY, async (name) => (await regularFileInside(rootReal, join(folderReal, name))) ? name : null);
  const kept = checked.filter(Boolean);
  const ordered = indexFirst ? orderFolderFiles(kept) : [...kept].sort(compareBytes);
  return ordered.map((name) => docFile(`${relFolder}/${name}`));
}

async function regularFileInside(rootReal, abs) {
  try {
    const real = await realpath(abs);
    return isInside(rootReal, real) && (await stat(real)).isFile();
  } catch {
    return false;
  }
}

function docFile(relPath) {
  return { path: relPath, name: relPath.split('/').pop(), title: titleFromPath(relPath) };
}

/** Layers found by name when no config exists: L<n>-* files and folders, plus adr/. */
async function autodetectLayers(rootReal) {
  const found = [];
  for (const entry of await readdir(rootReal)) {
    if (entry.startsWith('.')) continue;
    const abs = join(rootReal, entry);
    let real;
    let info;
    try {
      real = await realpath(abs);
      if (!isInside(rootReal, real)) continue;
      info = await stat(real);
    } catch {
      continue;
    }
    const match = /^L(\d+)-/i.exec(entry);
    if (match && info.isDirectory()) found.push({ n: Number(match[1]), name: entry, kind: 'folder', stem: entry });
    else if (match && info.isFile() && /\.md$/i.test(entry)) found.push({ n: Number(match[1]), name: entry, kind: 'file', stem: entry.replace(/\.md$/i, '') });
    else if (entry === 'adr' && info.isDirectory()) found.push({ n: Infinity, name: entry, kind: 'folder', stem: entry });
  }
  // A layer file and a folder with the same stem (L3-modules.md and L3-modules/) are one layer. The folder is
  // folded into the file entry; an empty folder (only dotfiles) changes nothing because it adds no document.
  // The names are compared without regard to case: L3-Modules/ next to L3-modules.md is the same mistake as a typo
  // in the case, and two layers with one label would hide it.
  const folderByKey = new Map(found.filter((f) => f.kind === 'folder' && f.name !== 'adr').map((f) => [f.name.toLowerCase(), f.name]));
  const merged = new Set();
  for (const f of found) {
    if (f.kind === 'file' && folderByKey.has(f.stem.toLowerCase())) {
      f.folder = folderByKey.get(f.stem.toLowerCase());
      merged.add(f.folder);
    }
  }
  found.splice(0, found.length, ...found.filter((f) => !(f.kind === 'folder' && merged.has(f.name))));
  found.sort((a, b) => (a.n === b.n ? compareBytes(a.name, b.name) : a.n - b.n));
  const counts = new Map();
  for (const f of found) counts.set(f.n, (counts.get(f.n) || 0) + 1);
  return found.map((f) => {
    const isAdr = f.name === 'adr';
    const id = isAdr ? 'adr' : counts.get(f.n) > 1 ? f.stem : `L${f.n}`;
    const description = Object.hasOwn(DEFAULT_LAYER_DESCRIPTIONS, id) ? DEFAULT_LAYER_DESCRIPTIONS[id] : null;
    return {
      id,
      label: isAdr ? 'ADRs' : humanize(f.stem),
      kind: f.kind,
      path: f.name,
      ...(isAdr || f.n === 1 ? { bricks: 'file' } : f.folder ? { bricks: 'modules' } : {}),
      ...(f.folder ? { folder: f.folder } : {}),
      include: [],
      decisions: isAdr,
      ...(description ? { description } : {}),
      files: []
    };
  });
}

/**
 * Discover the layers of a docs folder and the ordered files of each. Layers without files are dropped, and a
 * file that an earlier layer already lists is not listed again.
 * Layer list precedence: options.layers, options.layersFile, pyramid.json in the docs root, then detection
 * by name (L<n>-* and adr/).
 * @param {string} root Docs folder.
 * @param {{layers?: LayerConfig[], layersFile?: string}} [options]
 * @returns {Promise<Layer[]>}
 */
export async function discoverLayers(root, options = {}) {
  let rootReal;
  try {
    rootReal = await realpath(root);
    if (!(await stat(rootReal)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Docs folder not found or not a folder: ${root}`);
  }

  let layers;
  if (options.layers) {
    layers = parseLayerConfig(options.layers);
  } else if (options.layersFile) {
    layers = parseLayerConfig(await readFile(options.layersFile, 'utf8'));
  } else {
    let configText = null;
    try {
      configText = await readFile(join(rootReal, 'pyramid.json'), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    layers = configText === null ? await autodetectLayers(rootReal) : parseLayerConfig(configText);
  }

  const filled = await Promise.all(
    layers.map(async (layer) => {
      const parts = layerParts(layer);
      if (parts) {
        // One layer from a layer file and the folder with the same stem: the layer file first, then every
        // document of the folder by name. A folder index.md is an ordinary document here.
        const ok = await regularFileInside(rootReal, join(rootReal, ...parts.layerFile.split('/')));
        const inFolder = await listFolder(rootReal, parts.folder, { indexFirst: false });
        const folderIndex = ok ? inFolder.find((f) => f.name === 'index.md') : undefined;
        return {
          ...layer,
          folder: parts.folder,
          layerFile: ok ? parts.layerFile : null,
          folderIndex: folderIndex ? folderIndex.path : null,
          files: [...(ok ? [docFile(parts.layerFile)] : []), ...inFolder]
        };
      }
      if (layer.kind === 'file') {
        const ok = await regularFileInside(rootReal, join(rootReal, ...layer.path.split('/')));
        return { ...layer, files: ok ? [docFile(layer.path)] : [] };
      }
      return { ...layer, files: await listFolder(rootReal, layer.path) };
    })
  );
  // A document belongs to the first layer that lists it (layers may overlap in a custom config).
  const listed = new Set();
  return filled
    .map((layer) => {
      const files = layer.files.filter((f) => !listed.has(f.path));
      for (const f of files) listed.add(f.path);
      // A layer file that an earlier layer already lists is not this layer's layer file.
      const own = Object.hasOwn(layer, 'layerFile') ? { layerFile: files.some((f) => f.path === layer.layerFile) ? layer.layerFile : null } : {};
      // Only a folder index that this layer really lists counts as one next to a layer file.
      const index = layer.folderIndex && files.some((f) => f.path === layer.folderIndex) ? layer.folderIndex : null;
      return { ...layer, ...own, ...(Object.hasOwn(layer, 'folderIndex') ? { folderIndex: index } : {}), files };
    })
    .filter((layer) => layer.files.length > 0)
    .map((layer) => {
      for (const path of layer.include || []) {
        if (!layer.files.some((f) => f.path === path)) {
          throw new LayerConfigError(`Layer "${layer.id}": "include" lists "${path}", which is not a document of this layer. Use a path relative to the docs folder, with forward slashes, of a .md file in ${layer.path}.`);
        }
      }
      return { ...layer, bricks: resolveBricksMode(layer) };
    });
}

/**
 * The layer file and the folder of a layer that is both: an auto-detected pair (folder set) or a configured layer
 * with "bricks": "modules" (then the stem of its path names both). Null for every other layer.
 */
function layerParts(layer) {
  if (!layer.folder && layer.bricks !== 'modules') return null;
  const stem = layer.kind === 'file' ? layer.path.replace(/\.md$/i, '') : layer.path;
  return { layerFile: layer.kind === 'file' ? layer.path : `${layer.path}.md`, folder: layer.folder || stem };
}

/** True for the file names that act as the index of a folder. */
function isIndexName(path) {
  return /(^|\/)(index|README)\.md$/.test(path);
}

/**
 * The brick mode of a layer. An explicit "bricks" value is used as it is. Without one: decision records give one
 * brick per file; a folder whose first file is an index file (index.md, else README.md) uses "index"; anything
 * else uses "headings".
 * @param {{bricks?: string, decisions?: boolean, kind: string, files: DocFile[]}} layer
 * @returns {'index'|'headings'|'file'|'modules'}
 */
export function resolveBricksMode(layer) {
  if (layer.bricks) return layer.bricks;
  if (layer.decisions) return 'file';
  return layer.kind === 'folder' && layer.files.length > 0 && isIndexName(layer.files[0].path) ? 'index' : 'headings';
}

// ---------------------------------------------------------------------------------------------
// Documents, bricks and rows

/**
 * Read a document, refusing files above the size cap.
 * @param {string} absolutePath
 * @returns {Promise<string>}
 */
export async function readDocumentText(absolutePath) {
  const info = await stat(absolutePath);
  if (info.size > MAX_FILE_BYTES) {
    throw Object.assign(new Error(`File is larger than ${MAX_FILE_BYTES} bytes and is not shown`), { code: 'E_TOO_LARGE' });
  }
  return readFile(absolutePath, 'utf8');
}

/** The bricks of one document: its second-level headings, or one brick labelled with the title when it has none. */
function headingBricks(layerId, doc) {
  // A heading with no text would make a blank, unnamed link, so it makes no brick.
  const sections = doc.headings.filter((h) => h.level === 2 && h.text.trim() !== '');
  if (sections.length === 0) return [{ layerId, label: doc.title, path: doc.path, slug: null }];
  return sections.map((h) => ({ layerId, label: h.text, path: doc.path, slug: h.slug }));
}

/**
 * Bricks of one layer, by its mode:
 * "file" gives one brick per file; "headings" gives the second-level headings of every file in order (a file
 * without one gives a brick labelled with its title); "index" gives the headings of the index file only (a
 * single-file layer counts as its own index), then those of the documents in layer.include. An index
 * without a second-level heading gives one brick labelled with its title. A folder without an index file
 * falls back to "headings". "modules" gives the second-level headings of the layer file (layer.layerFile) in
 * document order, then one brick per other document in order, labelled with its module title (moduleTitle: the first
 * heading of level 1, else the first of level 2, else the title from the file name) and linking to the document start.
 * @param {{id: string, bricks: 'index'|'headings'|'file'|'modules', include?: string[], layerFile?: string|null}} layer
 * @param {{path: string, title: string, headings: Heading[]}[]} docs In file order.
 * @returns {Brick[]}
 */
export function buildBricks(layer, docs) {
  if (layer.bricks === 'modules') {
    // The sections of the layer file, then one brick per broken-out file. A broken-out file adds no brick for its own ## headings.
    const own = docs.find((d) => d.path === layer.layerFile);
    const broken = docs.filter((d) => d !== own).map((doc) => {
      return { layerId: layer.id, label: moduleTitle(doc.headings, doc.title), path: doc.path, slug: null };
    });
    return [...(own ? headingBricks(layer.id, own) : []), ...broken];
  }
  if (layer.bricks === 'file') return docs.map((doc) => ({ layerId: layer.id, label: doc.title, path: doc.path, slug: null }));
  const index = layer.bricks === 'index' && docs.length > 0 && (isIndexName(docs[0].path) || docs.length === 1) ? docs[0] : null;
  if (!index) return docs.flatMap((doc) => headingBricks(layer.id, doc));
  const extra = (layer.include || []).filter((path) => path !== index.path).map((path) => docs.find((d) => d.path === path)).filter(Boolean);
  return [index, ...extra].flatMap((doc) => headingBricks(layer.id, doc));
}

/**
 * Lay bricks out in rows that grow 1, 2, 3 ... across layers. Each layer takes rows of the current width,
 * growing by one per row, until its bricks run out. If a layer has at least two rows and the last is shorter
 * than the one before, that short row moves to the top and receives the first bricks. The width counter
 * advances by the number of rows built; an empty layer does not advance it.
 * @template T
 * @param {{id: string, bricks: T[]}[]} layers
 * @param {number} [startWidth]
 * @returns {{layers: {id: string, rows: T[][]}[], nextWidth: number}}
 */
export function layoutRows(layers, startWidth = 1) {
  let width = startWidth;
  const out = layers.map(({ id, bricks }) => {
    const sizes = [];
    for (let left = bricks.length, w = width; left > 0; w++) {
      const size = Math.min(w, left);
      sizes.push(size);
      left -= size;
    }
    if (sizes.length >= 2 && sizes[sizes.length - 1] < sizes[sizes.length - 2]) sizes.unshift(sizes.pop());
    const rows = [];
    let at = 0;
    for (const size of sizes) {
      rows.push(bricks.slice(at, at + size));
      at += size;
    }
    width += rows.length;
    return { id, rows };
  });
  return { layers: out, nextWidth: width };
}

/**
 * The document paths (relative to the docs folder) that a markdown text points to, by inline link or by a backticked
 * .md path. Relative targets are resolved against the document's folder, and a backticked path is also tried from
 * the docs folder. Links to other sites are ignored. Only a plain scan: it does not check that the targets exist.
 * @param {string} text
 * @param {string} docPath
 * @returns {Set<string>}
 */
function linkTargets(text, docPath) {
  const out = new Set();
  const base = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  const add = (raw, fromRoot) => {
    let target = raw.trim().replace(/^<|>$/g, '').replace(/[#?].*$/, '');
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return;
    try {
      target = decodeURIComponent(target);
    } catch {
      return;
    }
    const parts = [];
    for (const seg of (target.startsWith('/') ? target.slice(1) : `${base}/${target}`).split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    out.add(parts.join('/'));
    if (fromRoot) out.add(target.replace(/^(\.\/)+/, '').replace(/^\//, ''));
  };
  for (const m of text.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)/g)) add(m[1], false);
  for (const m of text.matchAll(/`([^`\n]+\.md)`/g)) add(m[1], true);
  return out;
}

/**
 * Read every document of the layers (bounded parallelism) and build the pyramid model: per layer the
 * documents with headings, the bricks and, for non-decision layers, the rows. offPyramid lists the documents
 * of each layer that make no brick; the model's offPyramid is their total. offPyramidUnlinked lists those of them that
 * no on-pyramid document of the layer links to (they are reachable only through the tree view or by typing the path).
 * @param {string} root
 * @param {{layers?: LayerConfig[], layersFile?: string, concurrency?: number}} [options]
 */
export async function loadPyramid(root, options = {}) {
  const layers = await discoverLayers(root, options);
  const rootReal = await realpath(root);
  const loaded = [];
  // Per document, the document paths it links to (by markdown link or backticked path); used to tell which off-pyramid documents nothing links to.
  const targets = new Map();
  for (const layer of layers) {
    const docs = await mapLimit(layer.files, options.concurrency || DEFAULT_CONCURRENCY, async (file) => {
      const doc = { path: file.path, title: file.title, headings: [], titleAtTop: false };
      try {
        const text = await readDocumentText(join(rootReal, ...file.path.split('/')));
        const scanned = scanDocument(text);
        doc.headings = scanned.headings;
        // A broken-out file of a modules layer is named by its module title everywhere, as its brick is.
        if (layer.bricks === 'modules' && file.path !== layer.layerFile) doc.title = moduleTitle(doc.headings, doc.title);
        // The title of the document is its own first heading, a "##" at the top: lists show it once, as the file entry.
        doc.titleAtTop = scanned.titleAtTop && doc.headings[0].text === doc.title;
        targets.set(file.path, linkTargets(text, file.path));
      } catch (error) {
        if (error.code !== 'E_TOO_LARGE') throw error;
        doc.tooLarge = true;
      }
      return doc;
    });
    const bricks = buildBricks(layer, docs);
    const onPyramid = new Set(bricks.map((b) => b.path));
    // Documents that make no brick stay in the tree view, the pages and the exports; only the picture leaves them out.
    const offPyramid = docs.filter((d) => !onPyramid.has(d.path)).map((d) => d.path);
    const linked = new Set();
    for (const path of onPyramid) for (const target of targets.get(path) || []) linked.add(target);
    loaded.push({ ...layer, brickMode: layer.bricks, docs, bricks, offPyramid, offPyramidUnlinked: offPyramid.filter((p) => !linked.has(p)) });
  }
  const growing = loaded.filter((l) => !l.decisions);
  const laid = layoutRows(growing.map((l) => ({ id: l.id, bricks: l.bricks })));
  return {
    layers: growing.map((l, i) => ({ ...l, rows: laid.layers[i].rows })),
    decisions: loaded.filter((l) => l.decisions),
    all: loaded,
    offPyramid: loaded.reduce((sum, l) => sum + l.offPyramid.length, 0),
    // Folder index files that sit next to a layer file: they are listed as ordinary documents and reported once.
    folderIndexes: loaded.flatMap((l) => (l.folderIndex ? [l.folderIndex] : [])),
    offPyramidUnlinked: loaded.flatMap((l) => l.offPyramidUnlinked)
  };
}

// ---------------------------------------------------------------------------------------------
// Link policy

/**
 * A fresh link report.
 * @returns {LinkReport}
 */
export function createLinkReport() {
  return { counts: { rewritten: 0, external: 0, fragment: 0, outsideRoot: 0, notExported: 0, missingFragment: 0 }, warnings: [] };
}

/**
 * Find the document a link target points to. A folder target goes to its index.md, else its README.md.
 * @param {string} target Path relative to the docs root, normalised, with or without a trailing slash.
 * @param {Iterable<string>} docPaths Paths of the exported documents.
 * @returns {string|null}
 */
export function findDocument(target, docPaths) {
  const set = docPaths instanceof Set ? docPaths : new Set(docPaths);
  const clean = target.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (clean && /\.md$/i.test(clean)) return set.has(clean) ? clean : null;
  const prefix = clean ? `${clean}/` : '';
  for (const name of ['index.md', 'README.md']) if (set.has(prefix + name)) return prefix + name;
  return null;
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Apply the link policy to one href. External, mailto and pure fragment links stay unchanged. A relative link
 * is resolved against the source file; if it leaves the docs root or is not an exported document it stays
 * unchanged and is counted as a warning. Otherwise the resolver callback builds the new href.
 * @param {string} href
 * @param {{
 *   sourcePath: string,
 *   resolveLink: (target: string, fragment: string) => string|null,
 *   report?: LinkReport
 * }} options sourcePath is relative to the docs root; resolveLink gets the normalised target path (a file or
 *   a folder) and the fragment without "#", and returns the new href or null when the target is not exported.
 *   It may return {href, missingFragment: true} when the document exists but has no heading of that name: the
 *   link is still rewritten (to the document start) and a "fragment-not-found" warning is counted.
 * @returns {string}
 */
export function rewriteLink(href, { sourcePath, resolveLink, report }) {
  const count = (key, reason) => {
    if (!report) return;
    report.counts[key]++;
    if (reason) report.warnings.push({ source: sourcePath, href, reason });
  };
  if (!href) return href;
  if (href.startsWith('#')) {
    count('fragment');
    return href;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
    count('external');
    return href;
  }
  const hash = href.indexOf('#');
  const fragment = hash === -1 ? '' : href.slice(hash + 1);
  const withoutFragment = hash === -1 ? href : href.slice(0, hash);
  const query = withoutFragment.indexOf('?');
  const rawPath = query === -1 ? withoutFragment : withoutFragment.slice(0, query);
  if (rawPath === '') {
    count('fragment');
    return href;
  }
  const decoded = safeDecode(rawPath);
  if (decoded === null || /[\\\0]/.test(decoded)) {
    count('notExported', 'not-exported');
    return href;
  }
  if (decoded.startsWith('/')) {
    count('outsideRoot', 'outside-root');
    return href;
  }
  const dir = posix.dirname(sourcePath);
  const joined = posix.normalize(posix.join(dir === '.' ? '' : dir, decoded));
  if (joined === '..' || joined.startsWith('../')) {
    count('outsideRoot', 'outside-root');
    return href;
  }
  const target = joined === '.' ? '' : joined.replace(/\/+$/, '');
  const resolved = resolveLink(target, fragment);
  if (resolved === null || resolved === undefined) {
    count('notExported', 'not-exported');
    return href;
  }
  if (typeof resolved === 'object') {
    count('rewritten');
    if (resolved.missingFragment) count('missingFragment', 'fragment-not-found');
    return resolved.href;
  }
  count('rewritten');
  return resolved;
}

// ---------------------------------------------------------------------------------------------
// Renderer

// Rule order matters: both rules run after the inline rule, so the link tokens and the heading
// children exist. They read their settings from the render environment.
md.core.ruler.push('pyramid_headings', (state) => {
  const found = scanHeadings(state.tokens);
  for (const h of found) state.tokens[h.index].attrSet('id', h.slug);
  state.env.headings = found.map(({ level, text, slug }) => ({ level, text, slug }));
});

// One h1 per page, and an outline without a gap. Under the heading rule a broken-out module file has no H1 and starts
// at the module's "##" title, with "###" sections. Shown as written, the page and the dialog would have either a
// generated h1 with the same words right above that heading (a visible duplicate), or no h1 at all, or an h1 that
// is followed by h3 elements (a skipped level, which assistive technology and audits report). So, when asked
// (env.promoteTitle) and when the document has no h1 and its first block is a "##" heading (only HTML comments may
// come before it), the file is shown as the document it is: that heading is rendered as the h1 element, every
// heading of level 3 to 6 below it one level up (h3 as h2, and so on), and the document gets no generated h1. The
// reading experience is the same as that of a file written with "# Title" and "## sections". Only element names
// change. The ids (slugs of the text), the text, the order and the heading list (levels as written, so the page
// index in the dialog and on the page lists the "##" and "###" entries as before) are not touched. The tree view and
// the Markdown table of contents use the document's titleAtTop flag to show the title once, as the file's own entry.
// A document that starts with something else keeps the generated h1 from its title and its headings as written.
md.core.ruler.push('pyramid_title', (state) => {
  if (!state.env.promoteTitle) return;
  const { tokens } = state;
  const first = titleHeadingIndex(tokens);
  if (first < 0) return;
  tokens[first].tag = 'h1';
  tokens[first + 2].tag = 'h1';
  for (let i = first + 3; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t.type === 'heading_open' || t.type === 'heading_close') && /^h[3-6]$/.test(t.tag)) t.tag = `h${Number(t.tag[1]) - 1}`;
  }
  state.env.titlePromoted = true;
});

md.core.ruler.push('pyramid_links', (state) => {
  const { resolveLink, sourcePath, report } = state.env;
  if (typeof resolveLink !== 'function') return;
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    for (const child of token.children) {
      if (child.type !== 'link_open') continue;
      const href = child.attrGet('href');
      const next = rewriteLink(href, { sourcePath, resolveLink, report });
      if (next !== href) child.attrSet('href', next);
    }
  }
});

// A backticked document path such as `combat.md`, `L3-modules/combat.md#fire` or `adr/`. Real pyramids point to
// their module files this way. Only plain path characters are accepted, so nothing odd can reach an href.
const CODE_DOC_PATH = /^((?:\.{1,2}\/)*[A-Za-z0-9_][A-Za-z0-9_.\-/]*?(?:\.md|\/))(#[A-Za-z0-9_\-%.]+)?$/;

/**
 * Read the content of a code span as a document path.
 * @param {string} content
 * @returns {{path: string, fragment: string}|null} null when the span does not look like a document path.
 */
export function parseCodePath(content) {
  const match = CODE_DOC_PATH.exec(content);
  // A slash after a file name ("a.md/") names no document.
  if (!match || /\.md\//i.test(match[1])) return null;
  return { path: match[1], fragment: match[2] ? match[2].slice(1) : '' };
}

/**
 * The document targets a backticked path may mean: first relative to the source document, then relative to the
 * docs root (routing tables write root-relative paths). Targets outside the docs root are dropped.
 * @param {string} path Path part of the code span, for example "combat.md" or "adr/".
 * @param {string} sourcePath Source document, relative to the docs root.
 * @returns {string[]}
 */
export function codePathTargets(path, sourcePath) {
  const dir = posix.dirname(sourcePath || '');
  const found = [];
  for (const candidate of [posix.join(dir === '.' ? '' : dir, path), path]) {
    const target = posix.normalize(candidate).replace(/\/+$/, '');
    if (target === '..' || target.startsWith('../') || target.startsWith('/') || found.includes(target)) continue;
    found.push(target === '.' ? '' : target);
  }
  return found;
}

/**
 * Find the link for a code span that may name a document.
 * @param {string} content Content of the code span.
 * @param {string} sourcePath
 * @param {(target: string, fragment: string) => string|{href: string, missingFragment?: boolean}|null} resolveLink
 * @param {LinkReport} [report] Counts a rewritten link; a fragment naming no heading is also reported.
 * @returns {string|null} The href, or null when the span names no exported document (not reported).
 */
export function resolveCodePath(content, sourcePath, resolveLink, report) {
  const parsed = parseCodePath(content);
  if (!parsed) return null;
  for (const target of codePathTargets(parsed.path, sourcePath)) {
    const resolved = resolveLink(target, parsed.fragment);
    if (resolved === null || resolved === undefined) continue;
    if (report) {
      report.counts.rewritten++;
      if (typeof resolved === 'object' && resolved.missingFragment) {
        report.counts.missingFragment++;
        report.warnings.push({ source: sourcePath, href: content, reason: 'fragment-not-found' });
      }
    }
    return typeof resolved === 'object' ? resolved.href : resolved;
  }
  return null;
}

// Runs after the link rule. Code spans that name an exported document become links, unless they already sit
// inside a link or a heading. Paths that are not documents stay plain code and are not reported (code spans
// name many things that are not documents).
md.core.ruler.push('pyramid_code_paths', (state) => {
  const { resolveLink, sourcePath, report } = state.env;
  if (typeof resolveLink !== 'function') return;
  const { tokens } = state;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'inline' || !token.children || (i > 0 && tokens[i - 1].type === 'heading_open')) continue;
    const children = [];
    let linkDepth = 0;
    for (const child of token.children) {
      if (child.type === 'link_open') linkDepth++;
      else if (child.type === 'link_close') linkDepth--;
      const href = child.type === 'code_inline' && linkDepth === 0 ? resolveCodePath(child.content, sourcePath, resolveLink, report) : null;
      if (href === null) {
        children.push(child);
        continue;
      }
      const open = new state.Token('link_open', 'a', 1);
      open.attrs = [['href', href]];
      children.push(open, child, new state.Token('link_close', 'a', -1));
    }
    token.children = children;
  }
});

/**
 * Render markdown to HTML safely: raw HTML is escaped, links with script URLs are not turned into links,
 * headings of level 1 to 4 get ids from the shared slug function, and relative links follow the link policy
 * when a resolver is given.
 * @param {string} source
 * With promoteTitle, a document without an h1 whose first block is a "##" heading renders that heading as the h1
 * element and the headings below it one level up (titlePromoted is then true); the heading list is not changed.
 * @param {{sourcePath?: string, resolveLink?: (target: string, fragment: string) => string|null, report?: LinkReport, promoteTitle?: boolean}} [options]
 * @returns {{html: string, headings: Heading[], titlePromoted: boolean}}
 */
export function renderMarkdown(source, options = {}) {
  const env = { sourcePath: options.sourcePath || '', resolveLink: options.resolveLink, report: options.report, promoteTitle: options.promoteTitle === true, headings: [] };
  const html = md.render(stripFrontMatter(normalizeSource(source)), env);
  return { html, headings: env.headings, titlePromoted: env.titlePromoted === true };
}

// ---------------------------------------------------------------------------------------------
// Request path guard

/**
 * Resolve a requested URL path to a regular .md file inside the docs root, or null.
 * The path is decoded once. Null bytes, backslashes, encoded separators (%2f, %5c), empty, "." and ".."
 * segments and dot-segments are rejected. The real path (symlinks followed) must lie inside the real path of
 * the docs root, and must be a regular file.
 * @param {string} root Docs folder.
 * @param {string} requestPath Path part of the request URL, for example "/L3-modules/index.md".
 * @returns {Promise<{absolutePath: string, relativePath: string}|null>}
 */
export async function resolveRequestPath(root, requestPath) {
  if (typeof requestPath !== 'string') return null;
  if (/[\0\\]/.test(requestPath) || /%(00|2f|5c)/i.test(requestPath)) return null;
  const decoded = safeDecode(requestPath);
  if (decoded === null || /[\x00-\x1f\\]/.test(decoded)) return null;
  const segments = (decoded.startsWith('/') ? decoded.slice(1) : decoded).split('/');
  if (segments.some((s) => s === '' || s.startsWith('.'))) return null;
  if (!/\.md$/i.test(segments[segments.length - 1])) return null;
  try {
    const rootReal = await realpath(root);
    const real = await realpath(join(rootReal, ...segments));
    if (!isInside(rootReal, real) || !(await stat(real)).isFile()) return null;
    return { absolutePath: real, relativePath: segments.join('/') };
  } catch {
    return null;
  }
}

// Page builders and serve mode live in src/ (split out to keep this file small). They import from this file
// and are re-exported here so that this file stays the one entry point.
export * from './src/pages.js';
export { startServer, runServe, SKINS } from './src/server.js';
export { exportHtml, exportFileName, EXPORT_VIEWS, formatLinkReport } from './src/export.js';
export { exportMarkdown } from './src/markdown-export.js';
export { main } from './src/cli.js';
export { MIN_NODE_VERSION, checkNodeVersion } from './src/node-guard.js';

// Run only when started directly, never on import.
const entry = process.argv[1];
if (entry) {
  let invokedDirectly = false;
  try {
    invokedDirectly = import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    invokedDirectly = false;
  }
  if (invokedDirectly) {
    main(process.argv.slice(2)).then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        process.stderr.write(`Error: ${error && error.message ? error.message : error}\n`);
        process.exitCode = 1;
      }
    );
  }
}
