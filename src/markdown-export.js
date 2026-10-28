// Markdown export.
//
// Writes the documents of the pyramid into one UTF-8 file with LF line endings. Heading levels are not changed.
// Every heading gets an explicit anchor with a prefix made from the document path, so that headings with the
// same text in different documents stay apart, and relative links between documents become links to those
// anchors. Code blocks are never touched. Headings and slugs come from the shared functions of viewer.js, so the
// anchors agree with the ids of the HTML export.
//
// Two anchor modes. "html" (the default) writes an explicit <a id> before every heading. "headings" writes no HTML at
// all: links point at the automatic heading anchors that GitHub-style renderers make from the heading text, with -1,
// -2 ... for repeated texts across the whole file. It works in previews that ignore raw HTML anchors.

import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadPyramid, readDocumentText, analyzeForExport, slugify, findDocument, rewriteLink, createLinkReport, resolveCodePath } from '../viewer.js';
import { formatLinkReport, notOnPyramidLine, folderIndexLines, NO_LAYERS_MESSAGE } from './export.js';
import { writeFileSafely } from './safe-write.js';

/**
 * Options for the Markdown export.
 * @typedef {object} MarkdownExportOptions
 * @property {string} root Docs folder.
 * @property {string} file Output file.
 * @property {boolean} [decisions] Append the decision records after the last layer.
 * @property {boolean} [toc] Insert a table of contents before the first document.
 * @property {boolean} [force] Overwrite an existing output file.
 * @property {'html'|'headings'} [anchors] How links find their heading: explicit HTML anchors (default) or heading names.
 * @property {import('../viewer.js').LayerConfig[]} [layers]
 * @property {string} [layersFile]
 * @property {{info: (m: string) => void, warn: (m: string) => void}} [log] info goes to stdout, warn to stderr.
 */

const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const REFERENCE_DEFINITION = /^( {0,3}\[(?:[^\]\\]|\\.)+\]:[ \t]*)(<[^>\n]*>|\S+)/;
// Longest link destination or title the scanner looks at. Longer ones are left alone (keeps the scan linear).
const MAX_PART = 2000;

/** Anchor prefix of a document: its path without ".md", made with the shared slug rule, "/" as "-". */
function prefixOf(docPath, used) {
  const base = slugify(docPath.replace(/\.md$/i, '').split('/').join(' ')).replace(/-+/g, '-') || 'document';
  let prefix = base;
  for (let n = 1; used.has(prefix); n++) prefix = `${base}-${n}`;
  used.add(prefix);
  return prefix;
}

/** Give every heading of the merged file its automatic anchor: the slug of its text, repeats numbered from -1. */
function assignHeadingAnchors(docs) {
  const used = new Set();
  const counters = new Map();
  for (const doc of docs) {
    doc.ghByLine = new Map();
    doc.ghBySlug = new Map();
    doc.ghFirst = null;
    for (const h of doc.analysis.headings) {
      const base = slugify(h.text, { decoded: true });
      let slug = base;
      if (used.has(slug)) {
        let n = counters.get(base) || 0;
        do slug = `${base}-${++n}`;
        while (used.has(slug));
        counters.set(base, n);
      }
      used.add(slug);
      doc.ghByLine.set(h.line, slug);
      doc.ghBySlug.set(h.slug, slug);
      if (doc.ghFirst === null) doc.ghFirst = slug;
    }
  }
}

const escapeLinkText = (text) => text.replace(/([\\[\]<>&*_`~|])/g, '\\$1');

/** Number of backslashes right before an index. */
function backslashesBefore(text, index) {
  let n = 0;
  while (index - n - 1 >= 0 && text[index - n - 1] === '\\') n++;
  return n;
}

/**
 * Find the code spans of a text, over several lines. A code span opens with a run of backticks and closes at the
 * next run of exactly the same length. One pass over the runs, no repeated string building.
 * @returns {{start: number, end: number, run: number}[]} end is exclusive; run is the length of the backtick run.
 */
function findCodeSpans(text) {
  const runs = [];
  for (const m of text.matchAll(/`+/g)) {
    let start = m.index;
    let length = m[0].length;
    if (backslashesBefore(text, start) % 2 === 1) {
      // The first backtick is escaped and is not part of a run.
      start++;
      length--;
      if (length === 0) continue;
    }
    runs.push({ start, length });
  }
  const byLength = new Map();
  runs.forEach((run, i) => {
    if (!byLength.has(run.length)) byLength.set(run.length, []);
    byLength.get(run.length).push(i);
  });
  const pointer = new Map();
  const spans = [];
  let skipUntil = -1;
  runs.forEach((run, i) => {
    if (run.start < skipUntil) return;
    const list = byLength.get(run.length);
    let at = pointer.get(run.length) || 0;
    while (at < list.length && list[at] <= i) at++;
    pointer.set(run.length, at);
    if (at >= list.length) return;
    const close = runs[list[at]];
    const end = close.start + close.length;
    spans.push({ start: run.start, end, run: run.length });
    skipUntil = end;
  });
  return spans;
}

/** Replace code spans by same-length filler so that links inside them are not found. */
function maskInlineCode(text, spans = findCodeSpans(text)) {
  let out = '';
  let last = 0;
  for (const span of spans) {
    out += text.slice(last, span.start) + '\u0000'.repeat(span.end - span.start);
    last = span.end;
  }
  return out + text.slice(last);
}

/**
 * Parse an inline link destination (and optional title) after "](" at index. Returns where the destination
 * text starts and ends and where the closing parenthesis is, or null when this is not a link.
 */
function parseDestination(text, index) {
  let i = index;
  const limit = Math.min(text.length, index + 2 * MAX_PART);
  while (i < limit && /\s/.test(text[i])) i++;
  let start = i;
  let end;
  if (text[i] === '<') {
    start = i;
    for (i++; i < limit && text[i] !== '>' && text[i] !== '\n' && text[i] !== '<'; i++) if (text[i] === '\\') i++;
    if (text[i] !== '>') return null;
    end = ++i;
  } else {
    let depth = 0;
    for (; i < limit && !/[\s\u0000]/.test(text[i]); i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    if (depth !== 0 || i >= limit && i < text.length) return null;
    end = i;
  }
  let j = end;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (j > end && /["'(]/.test(text[j] || '')) {
    const closer = text[j] === '(' ? ')' : text[j];
    let k = j + 1;
    const titleLimit = Math.min(text.length, k + MAX_PART);
    for (; k < titleLimit && text[k] !== closer; k++) if (text[k] === '\\') k++;
    if (text[k] !== closer) return null;
    j = k + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
  }
  if (text[j] !== ')' || end === start) return null;
  return { start, end, close: j };
}

/** Rewrite the inline links and reference definitions of a block of text (outside code) with mapHref. */
function rewriteBlock(block, mapHref) {
  let text = block
    .split('\n')
    .map((line) => {
      const reference = REFERENCE_DEFINITION.exec(line);
      if (!reference) return line;
      const raw = reference[2];
      const inner = raw.startsWith('<') ? raw.slice(1, -1) : raw;
      const next = mapHref(inner);
      return next === inner ? line : line.slice(0, reference[1].length) + (raw.startsWith('<') ? `<${next}>` : next) + line.slice(reference[1].length + raw.length);
    })
    .join('\n');
  if (!text.includes('](')) return text;
  const masked = maskInlineCode(text);
  const firstBracket = masked.indexOf('[');
  const edits = [];
  let from = 0;
  for (let at = masked.indexOf('](', from); at !== -1; at = masked.indexOf('](', from)) {
    from = at + 2;
    if (firstBracket === -1 || firstBracket > at || backslashesBefore(masked, at) % 2 === 1) continue;
    const found = parseDestination(masked, at + 2);
    if (!found) continue;
    const raw = text.slice(found.start, found.end);
    const inner = raw.startsWith('<') ? raw.slice(1, -1) : raw;
    const next = mapHref(inner);
    if (next === inner) continue;
    edits.push({ start: found.start, end: found.end, value: raw.startsWith('<') ? `<${next}>` : next });
    from = found.end;
  }
  let out = '';
  let last = 0;
  for (const edit of edits) {
    out += text.slice(last, edit.start) + edit.value;
    last = edit.end;
  }
  return out + text.slice(last);
}

/**
 * Places where a code span must not become a link, as sorted disjoint half-open intervals over the text with
 * masked code: every balanced pair of square brackets (link texts, reference links, shortcut references, image
 * text), the parenthesised part of inline links (destination and title), HTML comments, tags and autolinks, and
 * the content of <a> elements. One pass for each kind, so long hostile lines stay cheap.
 */
function protectedIntervals(masked) {
  const ranges = [];
  const stack = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c !== '[' && c !== ']') continue;
    if (backslashesBefore(masked, i) % 2 === 1) continue;
    if (c === '[') stack.push(i);
    else if (stack.length > 0) ranges.push([stack.pop(), i + 1]);
  }
  for (let at = masked.indexOf(']('); at !== -1; at = masked.indexOf('](', at + 2)) {
    if (backslashesBefore(masked, at) % 2 === 1) continue;
    const found = parseDestination(masked, at + 2);
    if (found) ranges.push([at, found.close + 1]);
  }
  for (let i = masked.indexOf('<!--'); i !== -1; ) {
    const end = masked.indexOf('-->', i + 4);
    if (end === -1) {
      ranges.push([i, masked.length]);
      break;
    }
    ranges.push([i, end + 3]);
    i = masked.indexOf('<!--', end + 3);
  }
  for (const m of masked.matchAll(/<[A-Za-z/][^>\n]{0,500}>/g)) ranges.push([m.index, m.index + m[0].length]);
  let closerGone = false;
  const lower = masked.toLowerCase();
  for (const m of masked.matchAll(/<a[\s>]/gi)) {
    if (closerGone) break;
    const close = lower.indexOf('</a>', m.index);
    if (close === -1) closerGone = true;
    else ranges.push([m.index, close + 4]);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * Turn code spans that name an exported document into links, the way the HTML renderer does: outside link texts,
 * titles, HTML, headings and reference definitions. mapCodePath gets the content of the span and returns the link
 * target or null. skipLine says whether a line of the block (0-based) must be left alone.
 */
function wrapCodePaths(block, mapCodePath, skipLine) {
  if (!block.includes('`')) return block;
  const spans = findCodeSpans(block);
  if (spans.length === 0) return block;
  const masked = maskInlineCode(block, spans);
  const intervals = protectedIntervals(masked);
  const lineStarts = [0];
  for (let i = block.indexOf('\n'); i !== -1; i = block.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const edits = [];
  let interval = 0;
  let line = 0;
  for (const span of spans) {
    while (interval < intervals.length && intervals[interval][1] <= span.start) interval++;
    if (interval < intervals.length && intervals[interval][0] < span.end) continue;
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= span.start) line++;
    if (skipLine(line)) continue;
    const raw = block.slice(span.start, span.end);
    let inner = raw.slice(span.run, raw.length - span.run);
    // Like markdown-it: one space at both ends is dropped when the span is not only spaces.
    if (inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') inner = inner.slice(1, -1);
    const target = mapCodePath(inner);
    if (target) edits.push({ start: span.start, end: span.end, value: `[${raw}](${target})` });
  }
  let out = '';
  let last = 0;
  for (const edit of edits) {
    out += block.slice(last, edit.start) + edit.value;
    last = edit.end;
  }
  return out + block.slice(last);
}

/** True when an anchor can be written on its own line before this heading line. */
function canPrefixAnchor(line) {
  return /^ {0,3}\S/.test(line) && !/^ {0,3}(>|[-*+]\s|\d+[.)]\s)/.test(line);
}

/**
 * Build the text of one document: anchors inserted, links rewritten, code left alone.
 * @returns {string} Without trailing newline.
 */
function renderDocument(doc, ctx) {
  const lines = doc.analysis.text.split('\n');
  const anchorByLine = new Map(doc.analysis.headings.map((h) => [h.line, `${doc.prefix}--${h.slug}`]));
  const slugs = new Set(doc.analysis.headings.map((h) => h.slug));
  const headingLines = new Set(doc.analysis.headings.map((h) => h.line));

  const resolveLink = (target, fragment) => {
    const found = findDocument(target, ctx.byPath.keys());
    if (!found) return null;
    const targetDoc = ctx.byPath.get(found);
    const docHref = ctx.headings ? (targetDoc.ghFirst === null ? null : `#${targetDoc.ghFirst}`) : `#${targetDoc.prefix}`;
    const headingHref = (slug) => (ctx.headings ? `#${targetDoc.ghBySlug.get(slug)}` : `#${targetDoc.prefix}--${slug}`);
    if (docHref === null) return null;
    let slug = null;
    if (fragment) {
      let wanted = fragment;
      try {
        wanted = decodeURIComponent(fragment);
      } catch {
        wanted = fragment;
      }
      if (targetDoc.analysis.headings.some((h) => h.slug === wanted)) slug = wanted;
      else return { href: docHref, missingFragment: true };
    }
    return slug ? headingHref(slug) : docHref;
  };

  // A code span such as `combat.md` or `adr/` that names an exported document becomes a link to its anchor.
  // Spans that name nothing exported stay plain code and are not reported.
  const mapCodePath = (content) => resolveCodePath(content, doc.path, resolveLink, ctx.report);

  const mapHref = (href) => {
    const next = rewriteLink(href, { sourcePath: doc.path, resolveLink, report: ctx.report });
    if (href.startsWith('#')) {
      let wanted = href.slice(1);
      try {
        wanted = decodeURIComponent(wanted);
      } catch {
        wanted = href.slice(1);
      }
      if (!slugs.has(wanted)) return href;
      return ctx.headings ? `#${doc.ghBySlug.get(wanted)}` : `#${doc.prefix}--${wanted}`;
    }
    return next;
  };

  // Links are rewritten per block of lines (a block ends at a blank line or at code), so that link text and
  // code spans over several lines are seen whole.
  const rewritten = [...lines];
  for (let i = 0; i < lines.length; ) {
    if (doc.analysis.codeLines.has(i) || lines[i].trim() === '') {
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && !doc.analysis.codeLines.has(end) && lines[end].trim() !== '') end++;
    const first = i;
    const skipLine = (n) => headingLines.has(first + n) || ATX_HEADING.test(lines[first + n]) || REFERENCE_DEFINITION.test(lines[first + n]);
    const block = wrapCodePaths(rewriteBlock(lines.slice(i, end).join('\n'), mapHref), mapCodePath, skipLine).split('\n');
    block.forEach((text, k) => {
      rewritten[i + k] = text;
    });
    i = end;
  }

  const out = ctx.headings ? [] : [`<a id="${doc.prefix}"></a>`, ''];
  lines.forEach((line, i) => {
    const text = rewritten[i];
    const anchor = ctx.headings ? null : anchorByLine.get(i);
    if (anchor && canPrefixAnchor(line)) {
      // A blank line before the anchor keeps it from joining the paragraph above.
      if (out[out.length - 1] !== '') out.push('');
      out.push(`<a id="${anchor}"></a>`, '', text);
    } else if (anchor) {
      out.push(`${text} <a id="${anchor}"></a>`);
    } else {
      out.push(text);
    }
  });
  const body = out.join('\n').replace(/\s+$/, '');
  return doc.analysis.closing ? `${body}\n${doc.analysis.closing}` : body;
}

function tableOfContents(docs, byHeading) {
  const lines = ['**Table of contents**', ''];
  for (const doc of docs) {
    const docTarget = byHeading ? doc.ghFirst : doc.prefix;
    lines.push(docTarget === null ? `- ${escapeLinkText(doc.title)}` : `- [${escapeLinkText(doc.title)}](#${docTarget})`);
    // A file that starts with its "##" title (a broken-out module) is listed by that title once, as its own entry,
    // and its "###" sections sit one level below it, like the "##" sections of a layer file.
    const titled = doc.titleAtTop;
    const headings = titled ? doc.analysis.headings.slice(1) : doc.analysis.headings;
    for (const h of headings) {
      if (h.level !== 2 && h.level !== 3) continue;
      const depth = titled ? 1 : h.level - 1;
      const target = byHeading ? doc.ghBySlug.get(h.slug) : `${doc.prefix}--${h.slug}`;
      lines.push(`${'  '.repeat(depth)}- [${escapeLinkText(h.text)}](#${target})`);
    }
  }
  return lines.join('\n');
}

/**
 * Export the docs as one Markdown file.
 * @param {MarkdownExportOptions} options
 * @returns {Promise<{written: boolean, documents: number, report: import('../viewer.js').LinkReport}>}
 *   written is false (and no file exists) when there is nothing to export.
 */
export async function exportMarkdown(options) {
  if (options.anchors !== undefined && options.anchors !== 'html' && options.anchors !== 'headings') throw new Error(`Unknown anchors mode "${options.anchors}". Valid modes: html, headings`);
  const log = options.log || { info: (m) => process.stdout.write(`${m}\n`), warn: (m) => process.stderr.write(`${m}\n`) };
  let rootReal;
  try {
    rootReal = await realpath(options.root);
    if (!(await stat(rootReal)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Docs folder not found or not a folder: ${options.root}`);
  }
  const target = resolve(options.file);
  const pyramid = await loadPyramid(options.root, { layers: options.layers, layersFile: options.layersFile });
  const chosen = [...pyramid.layers, ...(options.decisions ? pyramid.decisions : [])].flatMap((layer) => layer.docs);
  const report = createLinkReport();
  if (chosen.length === 0) {
    log.warn(pyramid.all.length === 0 ? `${NO_LAYERS_MESSAGE} No file was written.` : 'The docs hold only decision records. Add --decisions to export them. No file was written.');
    return { written: false, documents: 0, report };
  }

  // The output file must not be one of the source documents, not even with --force.
  const sourceFiles = new Set();
  for (const layer of pyramid.all) for (const doc of layer.docs) sourceFiles.add(join(rootReal, ...doc.path.split('/')));
  let targetReal = target;
  try {
    targetReal = await realpath(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (sourceFiles.has(targetReal) || sourceFiles.has(target)) throw new Error(`The output file is a source document and is never overwritten: ${options.file}`);
  if (!options.force) {
    try {
      await stat(target);
      throw Object.assign(new Error(`${options.file} already exists. Use --force to overwrite it.`), { code: 'E_EXISTS' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const usedPrefixes = new Set();
  const docs = [];
  for (const doc of chosen) {
    let source;
    try {
      source = await readDocumentText(join(rootReal, ...doc.path.split('/')));
    } catch (error) {
      if (error.code !== 'E_TOO_LARGE') throw error;
      log.warn(`Warning: ${doc.path} is larger than 2 MB and is left out of the export.`);
      continue;
    }
    const analysis = analyzeForExport(source);
    docs.push({ path: doc.path, title: doc.title, prefix: prefixOf(doc.path, usedPrefixes), analysis, titleAtTop: analysis.titleAtTop && analysis.headings[0].text === doc.title });
  }
  if (docs.length === 0) {
    log.warn('No document could be exported, so no file was written.');
    return { written: false, documents: 0, report };
  }

  const headings = options.anchors === 'headings';
  if (headings) assignHeadingAnchors(docs);
  const ctx = { byPath: new Map(docs.map((d) => [d.path, d])), report, headings };
  const parts = [];
  if (options.toc) parts.push(tableOfContents(docs, headings));
  docs.forEach((doc, i) => {
    // A comment cannot contain "--", so runs of hyphens in a path are shortened in the comment only.
    const comment = `<!-- source: ${doc.path.replace(/-{2,}/g, '-')} -->`;
    const body = `${comment}\n${renderDocument(doc, ctx)}`;
    parts.push(body);
  });
  const text = `${parts.join('\n\n---\n\n')}\n`;

  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFileSafely(target, text, { exclusive: !options.force });
  } catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error(`${options.file} already exists. Use --force to overwrite it.`), { code: 'E_EXISTS' });
    if (error.code === 'EISDIR') throw new Error(`The output path is a folder, not a file: ${options.file}`);
    throw error;
  }

  const summary = formatLinkReport(report);
  log.info(`Wrote ${docs.length} ${docs.length === 1 ? 'document' : 'documents'} to ${options.file}`);
  log.warn(summary.summary);
  // Count only the documents that are in the file: decision records are written only with --decisions.
  const written = new Set(docs.map((d) => d.path));
  const offLine = notOnPyramidLine(pyramid.all.flatMap((l) => l.offPyramid).filter((p) => written.has(p)).length, 'file');
  if (offLine) log.info(offLine);
  for (const line of folderIndexLines(pyramid)) log.info(line);
  for (const line of summary.warnings) log.warn(line);
  return { written: true, documents: docs.length, report };
}
