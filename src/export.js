// Static HTML export.
//
// Writes the pages of one or both views and the skin stylesheet into an output folder. The page builders are
// the same as in serve mode; only the URL mapper differs: every URL is relative to the page that contains it,
// so the output opens from file:// and from any subfolder of a web server.

import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, dirname, resolve, sep, posix } from 'node:path';
import { loadPyramid, readDocumentText, createLinkReport } from '../viewer.js';
import { renderOverviewPage, renderDocumentPage, renderDocumentFragment } from './pages.js';
import { DIALOG_SCRIPT_FILE, DIALOG_SCRIPT_URL } from './server.js';
import { SKIN_DIR, SKIN_FILES, SKIN_HELP, DEFAULT_SKIN, DENSITIES, DEFAULT_DENSITY, TOKENS_EXPORT_FILE, resolveSkin, readTokensFile } from './skins.js';
import { writeFileSafely } from './safe-write.js';

/** Values of the --view option. */
export const EXPORT_VIEWS = ['pyramid', 'tree', 'both'];

const TREE_DIR = '_tree';
const DEPTHS = [2, 3];
/** Said when a docs folder yields no layers; also used by the Markdown export and serve mode. */
export const NO_LAYERS_MESSAGE =
  'No layers found. The folder holds no pyramid files (for example L1-vision.md or L3-modules/). ' +
  'Name your files like that, or describe your layers in a pyramid.json in the docs folder or with --layers (see the README).';

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Turn a document path into an output file path: ".md" becomes ".html" and every folder or file name is made
 * safe for Windows (no < > : " | ? * backslash or control characters, no trailing dot or space, no reserved
 * device names). Forward slashes stay as separators.
 * @param {string} docPath For example "L3-modules/storage.md".
 * @returns {string} For example "L3-modules/storage.html".
 */
export function exportFileName(docPath) {
  const segments = docPath.split('/').filter(Boolean);
  const last = segments.length - 1;
  return segments
    .map((segment, i) => {
      let name = i === last ? segment.replace(/\.md$/i, '') : segment;
      name = name.replace(/[<>:"|?*\\\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
      if (name === '') name = '_';
      if (RESERVED_NAMES.test(name) || RESERVED_NAMES.test(name.split('.')[0])) name = `_${name}`;
      return i === last ? `${name}.html` : name;
    })
    .join('/');
}

/** Encode each segment of a relative path for use in an href. */
function encodePath(path) {
  return path.split('/').map((s) => (s === '..' || s === '.' ? s : encodeURIComponent(s))).join('/');
}

/**
 * Map every document to its output file. Two documents that end up with the same name (compared without
 * regard to case, as on Windows and macOS) are an error; a top-level document that would take the place of an
 * overview page gets "-doc" added to its name.
 */
function planFiles(docPaths, reservedFiles) {
  const taken = new Map(reservedFiles.map((f) => [f.toLowerCase(), '(overview page)']));
  const plan = new Map();
  for (const docPath of docPaths) {
    let file = exportFileName(docPath);
    if (taken.get(file.toLowerCase()) === '(overview page)') file = file.replace(/\.html$/, '-doc.html');
    const clash = taken.get(file.toLowerCase());
    if (clash) throw new Error(`Two documents would be exported to the same file "${file}": ${clash} and ${docPath}`);
    taken.set(file.toLowerCase(), docPath);
    plan.set(docPath, file);
  }
  return plan;
}

const WARNING_TEXT = {
  'outside-root': 'outside the docs folder, left unchanged',
  'not-exported': 'target is not an exported document, left unchanged',
  'fragment-not-found': 'the document has no heading of that name, the link goes to the document start'
};

/**
 * The one line that tells how many documents are not on the pyramid (they make no brick), or null when there are none.
 * @param {number} count
 * @param {'tree'|'pages'|'file'} where Where the documents can still be found: the tree view, the exported pages only, or the Markdown file.
 * @param {number} [unlinked] How many of them no on-pyramid document of their layer links to. Not used for the Markdown file.
 * @returns {string|null}
 */
export function notOnPyramidLine(count, where, unlinked = 0) {
  if (!count) return null;
  const one = count === 1;
  const places = {
    tree: one ? 'it is in the tree view' : 'they are in the tree view',
    pages: one ? 'it is exported as a page' : 'they are exported as pages',
    file: one ? 'it is in the Markdown file' : 'they are all in the Markdown file'
  };
  let detail = places[where];
  if (where !== 'file' && unlinked > 0) {
    if (unlinked >= count) detail += one ? '; it is not linked from an index' : '; none of them is linked from an index';
    else detail += `; ${unlinked} of them ${unlinked === 1 ? 'is' : 'are'} not linked from an index`;
  }
  return `${count} ${one ? 'document is' : 'documents are'} not on the pyramid (${detail}).`;
}

/**
 * The lines that name each folder index.md that sits next to a layer file (the new layout has none). The documents
 * stay listed as ordinary broken-out documents; the line says how to clean up.
 * @param {{folderIndexes?: string[]}} pyramid
 * @returns {string[]}
 */
export function folderIndexLines(pyramid) {
  return (pyramid.folderIndexes || []).map((path) => `${path} is a folder index next to a layer file; merge it into the layer file by hand`);
}

/**
 * Summary of a link report as text lines: one line of counts, then one line per warning.
 * @param {import('../viewer.js').LinkReport} report
 * @returns {{summary: string, warnings: string[]}}
 */
export function formatLinkReport(report) {
  const c = report.counts;
  const summary =
    `Link report: ${c.rewritten} rewritten, ${c.external} external, ${c.fragment} in-page, ` +
    `${c.outsideRoot} outside the docs folder, ${c.notExported} not exported, ${c.missingFragment} with a missing heading ` +
    `(${report.warnings.length} ${report.warnings.length === 1 ? 'warning' : 'warnings'}, not failures)`;
  const warnings = report.warnings.map(
    (w) => `Warning: ${w.source}: ${w.href} (${WARNING_TEXT[w.reason]})`
  );
  return { summary, warnings };
}

/**
 * Options for the static export.
 * @typedef {object} ExportOptions
 * @property {string} root Docs folder.
 * @property {string} out Output folder; created when missing, files of the same name are replaced, nothing is deleted.
 * @property {'pyramid'|'tree'|'both'} [view] Default "both".
 * @property {'light'|'metal'|'plain'} [skin] Default "light"; plain is another name for light.
 * @property {string[]} [skins] Several skins: one full export per skin in `<out>/<skin>/`, a skin switcher in every page that
 *   links to the same page in the other skins, and an `<out>/index.html` that opens the first skin. Replaces `skin`.
 * @property {string} [tokensFile] CSS file of user design tokens; copied to skins/custom.css and linked last.
 * @property {2|3} [depth] Deepest heading level in the tree index. Default 3.
 * @property {import('../viewer.js').LayerConfig[]} [layers]
 * @property {string} [layersFile]
 * @property {string} [siteName]
 * @property {{info: (m: string) => void, warn: (m: string) => void}} [log]
 */

/**
 * Export the docs as static HTML.
 * @param {ExportOptions} options
 * @returns {Promise<{empty: boolean, files: string[], report: import('../viewer.js').LinkReport}>}
 *   files are paths relative to the output folder.
 */
export async function exportHtml(options) {
  const log = options.log || { info: (m) => process.stdout.write(`${m}\n`), warn: (m) => process.stderr.write(`${m}\n`) };
  if (options.skins !== undefined) return exportSkins(options, log);
  const view = options.view || 'both';
  const skin = options.skin === undefined ? DEFAULT_SKIN : resolveSkin(options.skin);
  const depth = options.depth === undefined ? 3 : options.depth;
  const density = options.density === undefined ? DEFAULT_DENSITY : options.density;
  if (!DENSITIES.includes(density)) throw new Error(`Unknown density "${options.density}". Valid values: ${DENSITIES.join(', ')}`);
  if (!EXPORT_VIEWS.includes(view)) throw new Error(`Unknown view "${view}". Valid values: ${EXPORT_VIEWS.join(', ')}`);
  if (!skin) throw new Error(`Unknown skin "${options.skin}". Valid values: ${SKIN_HELP}`);
  if (!DEPTHS.includes(depth)) throw new Error(`Unknown depth "${depth}". Valid values: ${DEPTHS.join(', ')}`);

  let rootReal;
  try {
    rootReal = await realpath(options.root);
    if (!(await stat(rootReal)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Docs folder not found or not a folder: ${options.root}`);
  }
  const outAbs = resolve(options.out);
  if (outAbs === rootReal || outAbs === resolve(options.root)) throw new Error('The output folder must not be the docs folder itself.');
  try {
    const info = await stat(outAbs);
    if (!info.isDirectory()) throw new Error(`The output path exists and is not a folder: ${options.out}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  for (const name of [SKIN_FILES[0], `${skin}.css`]) {
    try {
      await readFile(join(SKIN_DIR, name), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(`The stylesheet "${name}" is missing in this copy of the viewer (skins/${name}).`);
    }
  }
  const tokensCss = options.tokensFile === undefined ? null : await readTokensFile(options.tokensFile);

  const pyramid = await loadPyramid(options.root, { layers: options.layers, layersFile: options.layersFile });
  if (pyramid.all.length === 0) {
    log.warn(`${NO_LAYERS_MESSAGE} Nothing was written.`);
    return { empty: true, files: [], report: createLinkReport() };
  }

  const views = view === 'both' ? ['pyramid', 'tree'] : [view];
  const dirOf = (v) => (view === 'both' && v === 'tree' ? `${TREE_DIR}/` : '');
  const overviewFile = (v) => `${dirOf(v)}index.html`;
  const docs = pyramid.all.flatMap((layer) => layer.docs);
  const plan = planFiles(docs.map((d) => d.path), views.map(overviewFile));
  const docFile = (v, docPath) => `${dirOf(v)}${plan.get(docPath)}`;
  // With both views the tree view lives under _tree/. Check the final paths of all views against each other.
  if (views.length > 1) {
    const finalPaths = new Map();
    for (const v of views) {
      for (const file of [overviewFile(v), ...docs.map((d) => docFile(v, d.path))]) {
        const key = file.toLowerCase();
        if (finalPaths.has(key)) throw new Error(`Two pages would be written to the same file "${file}". A docs path that starts with "${TREE_DIR}/" clashes with the tree view; rename it or export one view.`);
        finalPaths.set(key, file);
      }
    }
  }

  /** URL mapper for the page stored at pageFile (a path relative to the output folder). */
  const switchSkins = options.switchSkins || [];
  const linksFor = (pageFile) => {
    const from = posix.dirname(pageFile);
    const rel = (target) => encodePath(posix.relative(from, target));
    return {
      // With several skins each skin sits in its own folder (`<out>/<skin>/`) with the same page names, so the switcher
      // links to the same page one folder over.
      ...(switchSkins.length > 1
        ? { skinSwitch: () => switchSkins.map((name) => ({ name, current: name === skin, href: encodePath(posix.relative(posix.join('/', skin, from), posix.join('/', name, pageFile))) })) }
        : {}),
      overview: (v) => rel(overviewFile(v)),
      doc: (v, docPath, fragment) => `${rel(docFile(v, docPath))}${fragment ? `#${encodeURIComponent(fragment)}` : ''}`,
      skin,
      density,
      styles: () => [rel(`skins/${SKIN_FILES[0]}`), rel(`skins/${skin}.css`), ...(tokensCss === null ? [] : [rel(TOKENS_EXPORT_FILE)])],
      // Only the pyramid overview uses the script; the tree view never asks for it.
      script: () => rel(DIALOG_SCRIPT_URL)
    };
  };

  const pages = new Map();
  const report = createLinkReport();
  const warnedTooLarge = [];
  // Every document is read once; null stands for a file over the size limit.
  const sources = new Map();
  for (const doc of docs) {
    let source = null;
    try {
      source = await readDocumentText(join(rootReal, ...doc.path.split('/')));
    } catch (error) {
      if (error.code !== 'E_TOO_LARGE') throw error;
      warnedTooLarge.push(doc.path);
    }
    sources.set(doc.path, source);
  }
  for (const v of views) {
    const common = { pyramid, view: v, views, siteName: options.siteName, depth, openAllSections: true };
    // The pyramid overview carries every document as a fragment (a file URL cannot be fetched by the page). The
    // links of a fragment are written for the page of its own document, so they resolve like on that page.
    const embedded =
      v === 'pyramid'
        ? docs.map((doc) => {
            const file = docFile('pyramid', doc.path);
            return { page: encodePath(file), html: renderDocumentFragment({ pyramid, path: doc.path, source: sources.get(doc.path), links: linksFor(file) }) };
          })
        : [];
    // The tree view has no overview of its own: its entry page is the first document.
    const first = v === 'tree' ? docs.find((doc) => sources.get(doc.path) !== null) : null;
    pages.set(
      overviewFile(v),
      first
        ? renderDocumentPage({ ...common, path: first.path, source: sources.get(first.path), links: linksFor(overviewFile(v)), skinPage: { view: v, docPath: null } })
        : renderOverviewPage({ ...common, links: linksFor(overviewFile(v)), embedded, skinPage: { view: v, docPath: null } })
    );
    for (const doc of docs) {
      const file = docFile(v, doc.path);
      // Only the first view counts links, so that "both" does not count every link twice.
      pages.set(file, renderDocumentPage({ ...common, path: doc.path, source: sources.get(doc.path), links: linksFor(file), skinPage: { view: v, docPath: doc.path }, report: v === views[0] ? report : undefined }));
    }
  }

  const written = [];
  for (const [file, html] of pages) {
    const target = join(outAbs, ...file.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFileSafely(target, html);
    written.push(file);
  }
  // Copy every stylesheet of the skins folder (base and both themes), so that pages can be switched to another skin by hand.
  await mkdir(join(outAbs, 'skins'), { recursive: true });
  for (const name of (await readdir(SKIN_DIR)).filter((n) => /\.css$/.test(n)).sort()) {
    await writeFileSafely(join(outAbs, 'skins', name), await readFile(join(SKIN_DIR, name), 'utf8'));
    written.push(`skins/${name}`);
  }
  if (tokensCss !== null) {
    await writeFileSafely(join(outAbs, ...TOKENS_EXPORT_FILE.split('/')), tokensCss);
    written.push(TOKENS_EXPORT_FILE);
  }
  if (views.includes('pyramid')) {
    await mkdir(join(outAbs, 'assets'), { recursive: true });
    await writeFileSafely(join(outAbs, ...DIALOG_SCRIPT_URL.split('/')), await readFile(DIALOG_SCRIPT_FILE, 'utf8'));
    written.push(DIALOG_SCRIPT_URL);
  }

  for (const path of warnedTooLarge) log.warn(`Warning: ${path} is larger than 2 MB and is replaced by a notice in the export.`);
  const text = formatLinkReport(report);
  log.info(`Exported ${docs.length} ${docs.length === 1 ? 'document' : 'documents'} (view: ${view}, skin: ${skin}) to ${options.out}`);
  log.info(text.summary);
  const offLine = notOnPyramidLine(pyramid.offPyramid, views.includes('tree') ? 'tree' : 'pages', (pyramid.offPyramidUnlinked || []).length);
  if (offLine) log.info(offLine);
  for (const line of folderIndexLines(pyramid)) log.info(line);
  for (const line of text.warnings) log.warn(line);
  return { empty: false, files: written, report };
}

/**
 * Several skins in one export: a full export per skin in its own folder, linked by a skin switcher, and a plain
 * `index.html` at the top that opens the first skin (no script).
 */
async function exportSkins(options, log) {
  const names = [];
  for (const value of options.skins) {
    const skin = resolveSkin(value);
    if (!skin) throw new Error(`Unknown skin "${value}". Valid values: ${SKIN_HELP}`);
    if (!names.includes(skin)) names.push(skin);
  }
  if (names.length === 0) throw new Error('No skin given.');
  const files = [];
  let report = null;
  for (const skin of names) {
    const part = await exportHtml({ ...options, skins: undefined, skin, switchSkins: names, out: join(options.out, skin), log });
    if (part.empty) return part;
    files.push(...part.files.map((file) => `${skin}/${file}`));
    report ||= part.report;
  }
  const entry = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Documentation pyramid</title>
<meta http-equiv="refresh" content="0; url=${names[0]}/index.html">
</head>
<body>
<p><a href="${names[0]}/index.html">Open the documentation pyramid</a></p>
</body>
</html>
`;
  await writeFileSafely(join(resolve(options.out), 'index.html'), entry);
  files.push('index.html');
  return { empty: false, files, report };
}
