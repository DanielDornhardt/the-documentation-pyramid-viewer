#!/usr/bin/env node
/**
 * refresh-pyramid: keeps the routing blocks of a documentation pyramid's root index.md in step with the
 * documents and reports problems with messages that say what to do. It never edits a document other than
 * the generated blocks of index.md. Reference: refresh-pyramid.md next to this file or in tools/.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const MARKER = /^<!-- pyramid:(begin|end) (\S+) -->\s*$/;
// A line that starts a list, table, quote or thematic break: such a line is not part of a byline paragraph.
const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|\||>|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_END = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BYLINE_CAP = 2000; // characters of a paragraph considered for a byline
const DEFAULT_SECTION_LINES = 100;
const DEFAULT_BYLINE = 100;
const USAGE = `usage: node refresh-pyramid.js [docs-folder] [--dry-run | --check] [--max-section-lines N] [--max-byline N] [--help]
  Regenerates the routing blocks of <docs-folder>/index.md (default ./docs) and reports problems.
  --dry-run              write nothing, show which blocks would change
  --check                write nothing, exit 1 when the index is stale or errors exist
  --max-section-lines N  longest section before warning W1 (default ${DEFAULT_SECTION_LINES})
  --max-byline N         longest byline in characters before warning W3 (default ${DEFAULT_BYLINE}); errors above twice that
  exit codes: 0 fine, 1 errors or stale index (--check), 2 usage or unreadable folder`;

// ---------------------------------------------------------------- text helpers

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (all, name) => {
    if (name[0] !== '#') return NAMED_ENTITIES[name.toLowerCase()];
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

/** The viewer's slug for heading text: lowercase, punctuation removed, spaces to hyphens, Unicode letters kept. */
export function slugify(text) {
  return decodeEntities(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Markdown reduced to plain text: links to their text, emphasis and code marks removed. */
export function plainText(markdown) {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*{1,3})(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/(^|\W)(_{1,3})(\S(?:.*?\S)?)\2(?!\w)/g, '$1$3')
    .replace(/\s+/g, ' ')
    .trim();
}

const characters = (text) => [...text].length;
const cell = (text) => text.replace(/\|/g, '\\|');

// ---------------------------------------------------------------- scanning one document

/** Front matter as the viewer sees it: "---" on line 1, not followed by a blank line, closed by "---" or "...". */
function frontMatterEnd(lines) {
  if (lines[0] !== '---' || !lines[1]?.trim()) return 0;
  const close = lines.findIndex((line, i) => i > 0 && (line === '---' || line === '...'));
  return close === -1 ? 0 : close + 1;
}

/**
 * The kind of every line, one rule for the heading scan, the marker scan and the byline scan (CommonMark):
 * 'front' (front matter), 'code' (fenced code, fences included), 'comment' (first line of an HTML comment block),
 * 'comment-body' (its later lines) or 'text'.
 */
export function lineKinds(lines) {
  const front = frontMatterEnd(lines);
  const kinds = [];
  let fence = null;
  let inComment = false;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const open = FENCE.exec(line);
    if (i < front) {
      kinds.push('front');
    } else if (fence) {
      const close = FENCE_END.exec(line)?.[1];
      if (close?.[0] === fence[0] && close.length >= fence.length) fence = null;
      kinds.push('code');
    } else if (inComment) {
      inComment = !line.includes('-->');
      kinds.push('comment-body');
    } else if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      kinds.push('code');
    } else if (/^ {0,3}<!--/.test(line)) {
      inComment = !line.includes('-->');
      kinds.push('comment');
    } else {
      kinds.push('text');
    }
  });
  return kinds;
}

/** Anchors as the viewer makes them: levels 1 to 4 count, duplicates get -1, -2, and never take a slug another heading owns. */
function assignAnchors(headings) {
  const counted = headings.filter((h) => h.level <= 4);
  const reserved = new Set(counted.map((h) => slugify(h.title) || 'section'));
  const used = new Set();
  const nextNumber = new Map();
  for (const heading of counted) {
    const base = slugify(heading.title) || 'section';
    let anchor = base;
    if (used.has(anchor)) {
      let n = nextNumber.get(base) || 1;
      anchor = `${base}-${n}`;
      while (used.has(anchor) || reserved.has(anchor)) anchor = `${base}-${++n}`;
      nextNumber.set(base, n + 1);
    }
    used.add(anchor);
    heading.anchor = anchor;
  }
}

/** Lines, line kinds and ATX headings of a document. */
export function scanDocument(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const kinds = lineKinds(lines);
  const headings = [];
  lines.forEach((line, i) => {
    const match = kinds[i] === 'text' && HEADING.exec(line);
    if (match) headings.push({ line: i + 1, level: match[1].length, title: plainText(match[2] ?? '') });
  });
  assignAnchors(headings);
  return { lines, kinds, headings };
}

/**
 * First sentence of the first paragraph below the heading at index `at` of doc.headings (none for lists, tables,
 * quotes, code, thematic breaks). Comments are skipped, images contribute nothing, reference links stay as written.
 */
export function bylineAfter(doc, at) {
  const { lines, kinds, headings } = doc;
  const end = headings[at + 1] ? headings[at + 1].line - 1 : lines.length;
  const startsParagraph = (i) => kinds[i] === 'text' && lines[i].trim() !== '' && !BLOCK_START.test(lines[i]);
  let i = headings[at].line;
  while (i < end && (lines[i].trim() === '' || kinds[i].startsWith('comment'))) i++;
  if (i >= end || !startsParagraph(i)) return '';
  const paragraph = [lines[i++]];
  while (i < end && startsParagraph(i)) paragraph.push(lines[i++]);
  // A bold label such as "**Purpose.**" is not the description; the sentence after it is.
  const capped = paragraph.join(' ').slice(0, BYLINE_CAP).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/^\s*\*\*[^*]+?[.:]\*\*\s*/, '');
  const text = plainText(capped);
  return /^.*?[.?!](?=\s)/.exec(text)?.[0] ?? text;
}

// ---------------------------------------------------------------- modules of a layer

const finding = (severity, code, where, message, fix) => ({ severity, code, where, message, fix });
const asModule = (doc, at, place, where) => {
  const heading = doc.headings[at];
  return { title: heading.title, slug: slugify(heading.title) || 'section', what: bylineAfter(doc, at), place, where };
};

/** Every ## section of a layer file is a module; W1 for long ones. */
function sectionsOf(file, doc, maxSectionLines, findings) {
  const modules = [];
  doc.headings.forEach((heading, at) => {
    if (heading.level !== 2) return;
    const next = doc.headings.slice(at + 1).find((h) => h.level === 2);
    const length = (next ? next.line - 1 : doc.lines.length) - heading.line + 1;
    const place = `${file}:${heading.line}`;
    if (length > maxSectionLines) {
      const folder = file.replace(/\.md$/, '');
      findings.push(finding('warning', 'W1', place, `"${heading.title}" is ${length} lines, over the limit of ${maxSectionLines}`,
        `move it to its own file in ${folder}/ starting at its ## heading, never cut detail to get under the limit, then run this tool`));
    }
    modules.push(asModule(doc, at, place, `\`${file}#${heading.anchor}\` (line ${heading.line})`));
  });
  return modules;
}

/** A broken-out file is one module named by its first level 1 or 2 heading; W5 when it is not shaped that way. */
function brokenOutOf(path, doc, findings, checkShape) {
  const at = doc.headings.findIndex((h) => h.level <= 2);
  const title = doc.headings[at];
  if (!checkShape) return title ? asModule(doc, at, path, `\`${path}\``) : untitled(path);
  const firstLine = doc.lines.findIndex((line, i) => line.trim() !== '' && ['text', 'code'].includes(doc.kinds[i])) + 1;
  if (!title) {
    findings.push(finding('warning', 'W5', path, 'broken-out file has no heading', 'start the file with the module title as a ## heading'));
  } else if (title.level === 1 || title.line !== firstLine) {
    const found = title.level === 1 ? 'an H1 (# heading)' : 'text or another heading before its ## title';
    findings.push(finding('warning', 'W5', `${path}:${firstLine}`, `broken-out file starts with ${found}`,
      'start the file with the module title as a ## heading (no H1) and keep its sections at ###'));
  } else {
    const second = doc.headings.slice(at + 1).find((h) => h.level === 2);
    if (second) {
      findings.push(finding('warning', 'W5', `${path}:${second.line}`, `broken-out file holds a second module, "${second.title}"`,
        'give it its own file, move it into the layer file, or make it a ### section'));
    }
  }
  return title ? asModule(doc, at, path, `\`${path}\``) : untitled(path);
}

const untitled = (path) => ({ title: path.split('/').pop().replace(/\.md$/, ''), slug: '', what: '', place: path, where: `\`${path}\`` });

/** E2: the same module title (compared by slug) twice in one layer. */
function duplicateTitles(layerId, modules) {
  const first = new Map();
  const errors = [];
  for (const module of modules) {
    const earlier = module.slug && first.get(module.slug);
    if (!earlier) {
      first.set(module.slug, module);
    } else {
      errors.push(finding('error', 'E2', module.place, `module "${module.title}" appears twice in ${layerId} (also at ${earlier.place})`,
        'keep one copy: merge the two into one place and delete the other'));
    }
  }
  return errors;
}

/** E5, W2, W3 for the byline of every module. */
function bylineFindings(modules, maxByline) {
  return modules.flatMap((module) => {
    const length = characters(module.what);
    if (length === 0) return [finding('warning', 'W2', module.place, `"${module.title}" has no byline`, 'write one sentence directly under the heading that says what the module is')];
    if (length > 2 * maxByline) return [finding('error', 'E5', module.place, `byline of "${module.title}" is ${length} characters, over twice the limit of ${maxByline}`, 'shorten the first sentence under the heading')];
    if (length > maxByline) return [finding('warning', 'W3', module.place, `byline of "${module.title}" is ${length} characters, over the limit of ${maxByline}`, 'shorten the first sentence under the heading')];
    return [];
  });
}

const read = (path) => readFileSync(path, 'utf8');

/** Reads the documents of one layer. Throws when any of them cannot be read. */
function readLayer(docs, layer, options) {
  const findings = [];
  const modules = [];
  let sections = 0;
  if (layer.file) {
    modules.push(...sectionsOf(layer.file, scanDocument(read(join(docs, layer.file))), options.maxSectionLines, findings));
    sections = modules.length;
  }
  if (layer.dir) {
    const isAdr = layer.id === 'adr';
    for (const entry of listEntries(join(docs, layer.dir))) {
      const path = `${layer.dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!isAdr) findings.push(finding('warning', 'W4', path, 'sub-folder inside a layer folder is not scanned', 'move its files up into the layer folder or break them out one level'));
      } else if (entry.name === 'index.md' && !isAdr) {
        findings.push(finding('error', 'E1', path, 'folder index inside a layer folder (routing lives in the root index.md)',
          `move its content into ${layer.id}.md, break out only long sections as files starting at their ## heading, delete ${path}`));
      } else if (entry.name.endsWith('.md') && !(isAdr && ['index.md', 'README.md'].includes(entry.name))) {
        modules.push(brokenOutOf(path, scanDocument(read(join(docs, path))), findings, !isAdr));
      }
    }
  }
  findings.push(...duplicateTitles(layer.id, modules), ...bylineFindings(modules, options.maxByline));
  findings.push({ severity: 'info', where: layer.id, message: `${sections} sections, ${modules.length - sections} broken out` });
  return { modules, findings };
}

// ---------------------------------------------------------------- the docs folder

/** Directory entries in name order, without hidden ones and without symbolic links (which are ignored, never followed). */
function listEntries(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !e.isSymbolicLink())
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Layers in order: L<n> by number, then adr. A layer may be a file, a folder, or both with the same stem. */
function discoverLayers(docs) {
  const layers = new Map();
  let hasIndex = false;
  for (const entry of listEntries(docs)) {
    const stem = entry.isFile() ? /^(L\d+-.+)\.md$/.exec(entry.name)?.[1] : /^L\d+-.+$|^adr$/.exec(entry.name)?.[0];
    hasIndex ||= entry.isFile() && entry.name === 'index.md';
    if (!stem) continue;
    const layer = layers.get(stem) ?? { id: stem, number: stem === 'adr' ? Infinity : parseInt(stem.slice(1), 10) };
    layer[entry.isFile() ? 'file' : 'dir'] = entry.name;
    layers.set(stem, layer);
  }
  const ordered = [...layers.values()].sort((a, b) => a.number - b.number || (a.id < b.id ? -1 : 1));
  return { layers: ordered, hasIndex };
}

// ---------------------------------------------------------------- the generated blocks

export function tableLines(modules) {
  if (modules.length === 0) return ['', '_No modules yet._', ''];
  const rows = modules.map((m) => `| ${cell(m.title)} | ${m.where} | ${cell(m.what)} |`);
  return ['', '| Module | Where | What |', '| --- | --- | --- |', ...rows, ''];
}

/** Marker positions in the index lines, or E3 findings when they do not pair up. */
export function findBlocks(lines) {
  const blocks = new Map();
  const errors = [];
  const kinds = lineKinds(lines);
  let open = null; // the block whose begin marker was seen last and not yet closed
  const problem = (i, message, fix) => errors.push(finding('error', 'E3', `index.md:${i + 1}`, message, fix));
  lines.forEach((line, i) => {
    const marker = kinds[i] === 'comment' && MARKER.exec(line);
    if (!marker) return;
    const [, kind, id] = marker;
    const block = blocks.get(id);
    if (kind === 'begin') {
      if (block) {
        problem(i, `duplicate begin marker for ${id}`, 'keep one begin/end pair per layer and delete the other');
      } else {
        if (open) problem(i, `block ${id} starts inside block ${open}`, `close ${open} with its end marker before the begin marker of ${id}`);
        blocks.set(id, { begin: i });
        open = id;
      }
    } else if (!block) {
      problem(i, `end marker for ${id} without a begin marker before it`, `put "<!-- pyramid:begin ${id} -->" above it, or delete the end marker`);
    } else if (block.end !== undefined) {
      problem(i, `duplicate end marker for ${id}`, 'keep one begin/end pair per layer and delete the other');
    } else {
      block.end = i;
      open = null;
    }
  });
  for (const [id, block] of blocks) {
    if (block.end === undefined) problem(block.begin, `begin marker for ${id} has no end marker`, `add "<!-- pyramid:end ${id} -->" after the block`);
  }
  return { blocks, errors };
}

/** What a changed block looks like, as removed and added lines. */
function describeChange(id, before, after) {
  const removed = before.filter((line) => line.trim() && !after.includes(line)).map((line) => `  - ${line}`);
  const added = after.filter((line) => line.trim() && !before.includes(line)).map((line) => `  + ${line}`);
  return [`block ${id} would change:`, ...removed, ...added];
}

/**
 * Applies the new tables to the index text. Returns the new text and the changed block ids; layers without
 * markers are appended to the end when `append` is set (after a "## Routing table" heading, added if missing), else only listed in `missing`.
 */
export function updateIndex(text, tables, append) {
  const cr = text.includes('\r\n') ? '\r' : '';
  const lines = text.split('\n');
  const { blocks, errors } = findBlocks(lines);
  const result = { text, changed: [], missing: [], errors, diff: [] };
  if (errors.length) return result;
  const present = [...tables.keys()].filter((id) => blocks.has(id)).sort((a, b) => blocks.get(b).begin - blocks.get(a).begin);
  for (const id of present) {
    const { begin, end } = blocks.get(id);
    const body = tables.get(id).map((line) => line + cr);
    const before = lines.slice(begin + 1, end);
    if (before.join('\n') === body.join('\n')) continue;
    lines.splice(begin + 1, end - begin - 1, ...body);
    result.changed.push(id);
    result.diff.push(...describeChange(id, before.map((l) => l.replace(/\r$/, '')), tables.get(id)));
  }
  result.missing = [...tables.keys()].filter((id) => !blocks.has(id));
  if (append && result.missing.length) {
    const added = [];
    if (!lines.some((line) => /^## Routing table\s*$/.test(line))) added.push('', '## Routing table');
    if (text === '') added.shift(); // no blank line before the heading in an empty file
    for (const id of result.missing) added.push('', `<!-- pyramid:begin ${id} -->`, ...tables.get(id), `<!-- pyramid:end ${id} -->`);
    if (lines.at(-1) !== '') lines.push('');
    lines.splice(-1, 0, ...added.map((line) => line + cr));
    result.changed.push(...result.missing);
  }
  result.text = lines.join('\n');
  return result;
}

/** Writes via a temp file in the same folder and a rename, so a reader never sees half a file. */
function writeAtomically(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* nothing to clean up */ }
    throw error;
  }
}

// ---------------------------------------------------------------- the command

const formatFinding = ({ severity, code, where, message, fix }) =>
  `${[severity, code, `${where}:`].filter(Boolean).join(' ')} ${message}${fix ? ` (fix: ${fix})` : ''}`;

/** Brings index.md in step with the tables and adds its findings. Returns true when the index is stale (not in write mode). */
function refreshIndex(docs, tables, mode, findings, out) {
  const indexPath = join(docs, 'index.md');
  const write = mode === 'write';
  try {
    const update = updateIndex(read(indexPath), tables, write);
    if (write && update.changed.length) {
      writeAtomically(indexPath, update.text);
      out(`wrote index.md (blocks: ${update.changed.join(', ')})`);
    }
    findings.push(...update.errors);
    for (const id of update.missing) {
      findings.push(write ? { severity: 'note', code: 'E6', where: 'index.md', message: `added the missing block for ${id} at the end of index.md` }
        : finding('error', 'E6', 'index.md', `no pyramid:begin/end markers for ${id}`, 'run this tool in write mode, or add the marker lines by hand'));
    }
    const outdated = [...update.changed, ...(write ? [] : update.missing)];
    if (mode === 'dry-run') for (const line of update.diff) out(line);
    if (write || outdated.length === 0) return false;
    findings.push(finding('status', 'S1', 'index.md', `the index is stale (blocks: ${outdated.join(', ')})`, 'run this tool in write mode'));
    return true;
  } catch (error) {
    findings.push(finding('error', 'E7', 'index.md', `could not read or write index.md (${error.code ?? error.message})`, 'make index.md and its folder readable and writable, then run this tool again'));
    return false;
  }
}

/** Runs the tool; returns the exit code. `out` receives every output line. */
export function refreshPyramid(docs, { mode, maxSectionLines, maxByline }, out) {
  const { layers, hasIndex } = discoverLayers(docs);
  const findings = [];
  const tables = new Map();
  for (const layer of layers) {
    try {
      const result = readLayer(docs, layer, { maxSectionLines, maxByline });
      tables.set(layer.id, tableLines(result.modules));
      findings.push(...result.findings);
    } catch (error) {
      const file = error.path ? relative(docs, error.path) : layer.id;
      findings.push(finding('error', 'E7', file, `could not read ${layer.id} (${error.code ?? error.message}); its block in index.md was left unchanged`, 'make the file or folder readable, then run this tool again'));
    }
  }
  let stale = false;
  if (!hasIndex) {
    findings.push(finding('error', 'E4', 'index.md', `root index.md is missing in ${docs} (or is a symbolic link)`, `create ${join(docs, 'index.md')}; this tool then adds the routing blocks`));
  } else {
    if (layers.length === 0) findings.push(finding('warning', 'W6', 'index.md', `no layers found in ${docs} (expected files like L1-vision.md)`, 'add the layer files, then run this tool'));
    stale = refreshIndex(docs, tables, mode, findings, out);
  }
  findings.forEach((f) => out(formatFinding(f)));
  return findings.some((f) => f.severity === 'error') || (mode === 'check' && stale) ? 1 : 0;
}

/** Parses the command line and runs; returns the exit code (2 for usage and unreadable-folder errors). */
export function main(argv, out = console.log, err = console.error) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { 'dry-run': { type: 'boolean' }, check: { type: 'boolean' }, 'max-section-lines': { type: 'string' }, 'max-byline': { type: 'string' }, help: { type: 'boolean' } },
    }));
    if (values['dry-run'] && values.check) throw new Error('--dry-run and --check cannot be combined');
    if (positionals.length > 1) throw new Error('only one docs folder can be given');
  } catch (error) {
    err(`refresh-pyramid: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  const limit = (name, fallback) => (values[name] === undefined ? fallback : Number(values[name]));
  const maxSectionLines = limit('max-section-lines', DEFAULT_SECTION_LINES);
  const maxByline = limit('max-byline', DEFAULT_BYLINE);
  if (![maxSectionLines, maxByline].every((n) => Number.isInteger(n) && n > 0)) {
    err('refresh-pyramid: --max-section-lines and --max-byline need a positive whole number');
    return 2;
  }
  const docs = (positionals[0] ?? 'docs').replace(/(.)\/+$/, '$1');
  const mode = values.check ? 'check' : values['dry-run'] ? 'dry-run' : 'write';
  try {
    return refreshPyramid(docs, { mode, maxSectionLines, maxByline }, out);
  } catch (error) {
    err(`refresh-pyramid: cannot process ${docs}: ${error.code ?? error.message}`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
