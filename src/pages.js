// Page builders.
//
// These functions turn the pyramid model (see loadPyramid in viewer.js) into HTML strings. Serve mode and the
// static export both use them, so both render identically. They know nothing about servers or files: every URL
// comes from a "links" object that the caller supplies for the page being built.
//
// All text that is not markdown output is HTML-escaped here. The interface strings live in STRINGS so that
// they can be translated later.

import { escapeHtml, renderMarkdown, findDocument, titleFromPath } from '../viewer.js';

/**
 * URL mapper for one page. The caller builds one per page, so relative URLs can be computed from the page's
 * own location. Fragments are passed raw (not encoded); the mapper encodes them.
 * @typedef {object} PageLinks
 * @property {(view: 'pyramid'|'tree') => string} overview URL of the overview page of a view.
 * @property {(view: 'pyramid'|'tree', docPath: string, fragment?: string|null, extra?: {at?: string}) => string} doc
 *   URL of a document page. extra.at names the heading that is open in the tree index; a static export may ignore it.
 * @property {() => string[]} styles URLs of the stylesheets in link order: base, theme, then the user tokens when given.
 * @property {string} [skin] Canonical name of the skin, written to the body as data-skin.
 * @property {() => string} [script] URL of the dialog script. Without it the overview page has no dialog.
 * @property {(page: {view: 'pyramid'|'tree', docPath: string|null, at?: string|null}) => {name: string, current: boolean, href: string}[]} [skinSwitch]
 *   Serve mode: the same page in every skin. Without it the header has no skin switcher.
 * @property {() => {script: string, events: string}} [live] Serve --watch: the live script and the address of the event stream.
 * @property {() => string} [contentBase] Serve mode: URL prefix of the document fragment route. The export
 *   leaves it out and embeds the fragments in the page instead.
 */

/**
 * A document fragment embedded in the overview page of a static export.
 * @typedef {object} EmbeddedDocument
 * @property {string} page URL of the document page, relative to the overview page.
 * @property {string} html Fragment from renderDocumentFragment, built with the links of that page.
 */

/** Interface strings. English only in v0.1. */
export const STRINGS = {
  siteName: 'Documentation pyramid',
  skipLink: 'Skip to content',
  viewsNav: 'Site',
  switchToTree: 'Tree view',
  switchToPyramid: 'Pyramid view',
  overviewTitle: 'Documentation pyramid',
  noLayers: 'No layers found. The folder holds no pyramid files (for example L1-vision.md or L3-modules/).',
  pyramidLabel: 'Pyramid',
  decisionsLabel: 'ADRs',
  tocLabel: 'On this page',
  overviewIntro: 'Blurry but complete at the top, sharper with every layer down. Click a brick to read.',
  dialogBack: 'Back',
  dialogClose: 'Close',
  dialogLoading: 'Loading...',
  dialogError: 'Could not load the document.',
  indexLabel: 'Document index',
  indexToggle: 'Document index',
  treeIntro: 'Choose a document from the index.',
  tooLarge: 'This file is larger than 2 MB and is not shown.',
  notOnPyramid: (n) => `${n} ${n === 1 ? 'document is' : 'documents are'} not on the pyramid.`,
  notOnPyramidUnlinked: (n) => `${n === 1 ? 'This one is' : `${n} of them are`} not linked from an index:`,
  folderIndexNote: (path) => `${path} is a folder index next to a layer file; merge it into the layer file by hand.`,
  notOnPyramidTree: (n) => `${n === 1 ? 'It is' : 'They are'} in the tree view.`,
  skinNav: 'Skin',
  skinNames: { light: 'Light', metal: 'Metal' },
  documentsCount: (n) => `${n} ${n === 1 ? 'document' : 'documents'}`
};

const OTHER_VIEW = { pyramid: 'tree', tree: 'pyramid' };

/**
 * Wrap page content in the shared layout: lang, charset, viewport, skip link, header with the view switch,
 * landmarks, stylesheet link.
 * @param {object} options
 * @param {string} options.title Text for the title element (plain text, escaped here).
 * @param {'pyramid'|'tree'} options.view
 * @param {('pyramid'|'tree')[]} options.views Views present in the output; the switch shows only if both are.
 * @param {PageLinks} options.links
 * @param {string} options.siteName
 * @param {string} options.switchHref URL of the matching page in the other view.
 * @param {string} options.main HTML inside the article element.
 * @param {string} [options.mainClass] Class of the main element. Default: a paper card for reading; the pyramid overview passes plain content.
 * @param {string} [options.aside] HTML of the tree index (placed before main).
 * @param {string} [options.head] Extra HTML for the head element (already escaped).
 * @param {{view: 'pyramid'|'tree', docPath: string|null, at?: string|null}} [options.skinPage] Serve mode: which page this is, for the skin switcher.
 * @param {string} [options.after] HTML placed after the layout, at the end of the body (already escaped).
 * @returns {string}
 */
function layout({ title, view, views, links, siteName, homeLink = true, switchHref, main, mainClass = 'content content-paper', aside = '', head = '', after = '', skinPage = null }) {
  const other = OTHER_VIEW[view];
  const switchLink = views.includes(other)
    ? `<a class="view-switch" href="${escapeHtml(switchHref)}">${escapeHtml(other === 'tree' ? STRINGS.switchToTree : STRINGS.switchToPyramid)}</a>`
    : '';
  const skinNav =
    skinPage && links.skinSwitch
      ? `<nav class="skin-switch" aria-label="${escapeHtml(STRINGS.skinNav)}">\n${links
          .skinSwitch(skinPage)
          .map((e) => `<a href="${escapeHtml(e.href)}"${e.current ? ' aria-current="true"' : ''}>${escapeHtml(STRINGS.skinNames[e.name] || e.name)}</a>`)
          .join('\n')}\n</nav>\n`
      : '';
  const live = links.live ? links.live() : null;
  const liveScript = live ? `<script defer src="${escapeHtml(live.script)}" data-events="${escapeHtml(live.events)}"></script>\n` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${links.styles().map((url) => `<link rel="stylesheet" href="${escapeHtml(url)}">\n`).join('')}${head}${liveScript}</head>
<body class="view-${view}"${links.skin ? ` data-skin="${escapeHtml(links.skin)}"` : ''}${links.density === 'compact' ? ' data-density="compact"' : ''}>
<a class="skip-link" href="#pv-main">${escapeHtml(STRINGS.skipLink)}</a>
<header class="site-header">
<nav aria-label="${escapeHtml(STRINGS.viewsNav)}" class="site-nav">
${homeLink ? `<a class="site-name" href="${escapeHtml(links.overview(view))}">${escapeHtml(siteName)}</a>\n` : ''}${switchLink}
</nav>
${skinNav}</header>
<div class="layout">
${aside}<main id="pv-main" class="${mainClass}">
<article class="doc">
${main}
</article>
</main>
</div>
${after}</body>
</html>
`;
}

/** Every layer of the pyramid model in reading order: growing layers, then decision blocks. */
function allLayers(pyramid) {
  return pyramid.all || [...pyramid.layers, ...pyramid.decisions];
}

function listDocs(pyramid) {
  return allLayers(pyramid).flatMap((layer) => layer.docs);
}

function layerLabelId(prefix, layer) {
  return `${prefix}-${String(layer.id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

// ---------------------------------------------------------------------------------------------
// Pyramid view

/** Data attributes that mark a brick for the dialog script: the document and, when there is one, the heading. */
function brickData(brick) {
  return ` data-pv-doc="${escapeHtml(brick.path)}"${brick.slug ? ` data-pv-heading="${escapeHtml(brick.slug)}"` : ''}`;
}

function layerDescription(layer) {
  return layer.description ? `\n<p class="layer-description">${escapeHtml(layer.description)}</p>` : '';
}

/** Number of tints that the skins define; layers use them in turn. */
export const TINT_COUNT = 6;
/** The tint of the decision records. */
const DECISION_TINT = 4;

function brickList(layer, links) {
  const rows = layer.rows
    .map((row) => {
      const bricks = row
        .map((b) => `<li class="brick${layer.brickMode === 'modules' && b.path !== layer.layerFile ? ' brick-doc' : ''}"><a href="${escapeHtml(links.doc('pyramid', b.path, b.slug))}"${brickData(b)}>${escapeHtml(b.label)}</a></li>`)
        .join('\n');
      return `<li class="row"><ul class="row-bricks">\n${bricks}\n</ul></li>`;
    })
    .join('\n');
  return rows;
}

function pyramidPicture(pyramid, links, views) {
  if (pyramid.layers.length === 0 && pyramid.decisions.length === 0) {
    return `<p class="empty">${escapeHtml(STRINGS.noLayers)}</p>`;
  }
  const layers = pyramid.layers
    .map((layer, index) => {
      const labelId = layerLabelId('pv-layer', layer);
      return `<section class="layer" aria-labelledby="${labelId}" data-layer="${escapeHtml(layer.id)}" data-tint="${index % TINT_COUNT}">
<h3 class="layer-label" id="${labelId}">${escapeHtml(layer.label)}</h3>${layerDescription(layer)}
<ul class="rows">
${brickList(layer, links)}
</ul>
</section>`;
    })
    .join('\n');
  const decisions = pyramid.decisions
    .map((layer) => {
      const labelId = layerLabelId('pv-layer', layer);
      const items = layer.bricks
        .map((b) => `<li class="decision"><a href="${escapeHtml(links.doc('pyramid', b.path, b.slug))}"${brickData(b)}>${escapeHtml(b.label)}</a></li>`)
        .join('\n');
      return `<section class="decisions" aria-labelledby="${labelId}" data-layer="${escapeHtml(layer.id)}" data-tint="${DECISION_TINT}">
<h3 class="layer-label" id="${labelId}">${escapeHtml(layer.label)}</h3>${layerDescription(layer)}
<ul class="decision-list">
${items}
</ul>
</section>`;
    })
    .join('\n');
  const picture = layers ? `<div class="pyramid" role="group" aria-labelledby="pv-pyramid-heading">\n${layers}\n</div>` : '';
  const folderIndexes = (pyramid.folderIndexes || []).map((path) => `\n<p class="pyramid-note">${escapeHtml(STRINGS.folderIndexNote(path))}</p>`).join('');
  return `${picture}${decisions ? `\n${decisions}` : ''}${offPyramidNote(pyramid, links, views)}${folderIndexes}`;
}

/**
 * A calm note under the picture: how many documents make no brick, and a link to the tree view when that view is
 * part of the output. It says nothing else, and nothing at all when every document is on the pyramid.
 */
function offPyramidNote(pyramid, links, views) {
  const n = pyramid.offPyramid || 0;
  if (n === 0) return '';
  const link = views.includes('tree') ? ` <a href="${escapeHtml(links.overview('tree'))}">${escapeHtml(STRINGS.notOnPyramidTree(n))}</a>` : '';
  const note = `\n<p class="pyramid-note">${escapeHtml(STRINGS.notOnPyramid(n))}${link}</p>`;
  // Without the tree view nothing else reaches a document that no index links to, so the note lists them.
  const unlinked = views.includes('tree') ? [] : pyramid.offPyramidUnlinked || [];
  if (unlinked.length === 0) return note;
  const titles = new Map(allLayers(pyramid).flatMap((l) => l.docs.map((d) => [d.path, d.title])));
  const items = unlinked.map((path) => `<li><a href="${escapeHtml(links.doc('pyramid', path, null))}">${escapeHtml(titles.get(path) || path)}</a></li>`).join('\n');
  return `${note}\n<p class="pyramid-note">${escapeHtml(STRINGS.notOnPyramidUnlinked(unlinked.length))}</p>\n<ul class="pyramid-note-list">\n${items}\n</ul>`;
}

// ---------------------------------------------------------------------------------------------
// Tree view

/**
 * Find the open second-level heading for an "at" slug: the heading itself if it is level 2, or the nearest
 * level 2 heading before a level 3 one. Returns null for an unknown slug.
 */
function openSection(headings, at) {
  if (!at) return null;
  let lastH2 = null;
  for (const h of headings) {
    if (h.level === 2) lastH2 = h;
    if (h.slug === at && (h.level === 2 || h.level === 3)) return { open: h.level === 2 ? h : lastH2, current: h };
  }
  return null;
}

function treeIndex(pyramid, links, { current, depth, openAllSections = false }) {
  const layers = allLayers(pyramid)
    .map((layer) => {
      const parts = layer.docs
        .map((doc) => {
          const isCurrent = doc.path === current?.path;
          const sections = openSection(doc.headings, isCurrent ? current.at : null);
          // A document that starts with its "##" title (a broken-out module file) is listed by that title as the file
          // entry, so the heading is not listed a second time; its ### sections are the entries below the file.
          const entries = doc.titleAtTop ? doc.headings.slice(1).filter((h) => h.level === 2 || h.level === 3) : doc.headings.filter((h) => h.level === 2);
          const items = entries
            .map((h) => {
              const isHere = sections && sections.current === h;
              // A static page cannot remember which section is open, so it opens the ### list of every ## heading of its own document.
              const showThird = !doc.titleAtTop && depth >= 3 && ((sections && sections.open === h) || (openAllSections && isCurrent));
              const children = showThird ? subHeadings(doc, h, links, sections || { current: null }) : '';
              const mark = isHere ? ' aria-current="location"' : '';
              return `<li><a href="${escapeHtml(links.doc('tree', doc.path, h.slug, { at: h.slug }))}"${mark}>${escapeHtml(h.text)}</a>${children}</li>`;
            })
            .join('\n');
          const mark = isCurrent ? ' aria-current="page"' : '';
          const link = `<a href="${escapeHtml(links.doc('tree', doc.path))}"${mark}>${escapeHtml(doc.title)}</a>`;
          const list = items ? `<ul class="tree-headings">\n${items}\n</ul>` : '';
          return { doc, link, list };
        });
      // The document that carries the layer's own title (L1 Vision under "L1 Vision") is the layer heading itself, so the
      // title is shown once: as a link, with the document's sections below it. The other documents follow as files.
      const own = parts.find((part) => part.doc.title === layer.label);
      const label = own ? `<p class="layer-label">${own.link}</p>${own.list ? `\n${own.list}` : ''}` : `<p class="layer-label">${escapeHtml(layer.label)}</p>`;
      const files = parts
        .filter((part) => part !== own)
        .map((part) => `<li class="tree-file">${part.link}${part.list ? `\n${part.list}` : ''}</li>`)
        .join('\n');
      return `<li class="tree-layer">${label}${files ? `\n<ul class="tree-files">\n${files}\n</ul>` : ''}</li>`;
    })
    .join('\n');
  return `<nav class="tree" aria-label="${escapeHtml(STRINGS.indexLabel)}">
<details class="tree-toggle">
<summary>${escapeHtml(STRINGS.indexToggle)}</summary>
<ul class="tree-layers">
${layers}
</ul>
</details>
</nav>
`;
}

/** The level 3 headings that follow one level 2 heading, up to the next level 2 heading. */
function subHeadings(doc, parent, links, sections) {
  const out = [];
  let inside = false;
  for (const h of doc.headings) {
    if (h === parent) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (h.level <= 2) break;
    if (h.level === 3) {
      const mark = sections.current === h ? ' aria-current="location"' : '';
      out.push(`<li><a href="${escapeHtml(links.doc('tree', doc.path, h.slug, { at: h.slug }))}"${mark}>${escapeHtml(h.text)}</a></li>`);
    }
  }
  return out.length ? `\n<ul class="tree-subheadings">\n${out.join('\n')}\n</ul>` : '';
}

// ---------------------------------------------------------------------------------------------
// Pages

/**
 * The overview page of a view. In the pyramid view it holds the picture; in the tree view it holds the index
 * and a short prompt.
 * @param {object} options
 * @param {object} options.pyramid Model from loadPyramid.
 * @param {'pyramid'|'tree'} [options.view]
 * @param {('pyramid'|'tree')[]} [options.views] Views present in the output.
 * @param {PageLinks} options.links
 * @param {string} [options.siteName]
 * @param {2|3} [options.depth] Deepest heading level shown in the tree index.
 * @param {EmbeddedDocument[]} [options.embedded] Static export: fragments of every document, embedded as templates.
 * @param {{view: 'pyramid'|'tree', docPath: string|null, at?: string|null}} [options.skinPage] Serve mode: this page, for the skin switcher.
 * @returns {string}
 */
export function renderOverviewPage({ pyramid, view = 'pyramid', views = ['pyramid', 'tree'], links, siteName = STRINGS.siteName, depth = 3, embedded = [], skinPage = null }) {
  const switchHref = links.overview(OTHER_VIEW[view]);
  if (view === 'tree') {
    const count = listDocs(pyramid).length;
    const main = `<h1 id="pv-title">${escapeHtml(siteName)}</h1>
<p>${escapeHtml(count === 0 ? STRINGS.noLayers : `${STRINGS.documentsCount(count)}. ${STRINGS.treeIntro}`)}</p>`;
    return layout({ title: siteName, view, views, links, siteName, homeLink: false, switchHref, main, aside: count === 0 ? '' : treeIndex(pyramid, links, { current: null, depth }), skinPage });
  }
  const main = `<h1 id="pv-title" class="pyramid-title">${escapeHtml(STRINGS.overviewTitle)}</h1>
<p class="intro">${escapeHtml(STRINGS.overviewIntro)}</p>
<h2 id="pv-pyramid-heading" class="pyramid-heading">${escapeHtml(STRINGS.pyramidLabel)}</h2>
${pyramidPicture(pyramid, links, views)}`;
  // The dialog is an enhancement of the pyramid overview: it needs the script, and bricks to click.
  const withDialog = Boolean(links.script) && allLayers(pyramid).length > 0;
  const head = withDialog ? `<script defer src="${escapeHtml(links.script())}"></script>\n` : '';
  const after = withDialog ? `${dialogMarkup(links)}${embeddedTemplates(embedded)}` : '';
  return layout({ title: siteName, view, views, links, siteName, homeLink: false, switchHref, main, mainClass: 'content', head, after, skinPage });
}

/** The dialog element. It is empty and closed; the script fills it. Ids are prefixed so they cannot meet heading ids. */
function dialogMarkup(links) {
  const content = links.contentBase ? ` data-content="${escapeHtml(links.contentBase())}"` : '';
  return `<dialog id="pv-dialog" class="pv-dialog" aria-labelledby="pv-dialog-title" data-loading="${escapeHtml(STRINGS.dialogLoading)}" data-error="${escapeHtml(STRINGS.dialogError)}"${content}>
<div class="pv-dialog-header">
<p id="pv-dialog-title" class="pv-dialog-title"></p>
<button type="button" id="pv-dialog-back" class="pv-dialog-button" hidden>${escapeHtml(STRINGS.dialogBack)}</button>
<button type="button" id="pv-dialog-close" class="pv-dialog-button">${escapeHtml(STRINGS.dialogClose)}</button>
</div>
<div class="pv-dialog-main">
<nav id="pv-dialog-toc" class="pv-dialog-toc" aria-label="${escapeHtml(STRINGS.tocLabel)}" hidden></nav>
<div id="pv-dialog-body" class="pv-dialog-body" tabindex="-1"></div>
</div>
</dialog>
`;
}

/**
 * One template element per document. A template is inert (no script, no images, no ids in the page). The
 * fragment is escaped HTML; the closing-tag replacement below is a second guard so that no text can end the
 * template early.
 */
function embeddedTemplates(embedded) {
  return embedded
    .map((e) => `<template data-pv-page="${escapeHtml(e.page)}">${e.html.replace(/<\/(template)/gi, '&lt;/$1')}</template>\n`)
    .join('');
}

function tocList(headings) {
  const items = headings.filter((h) => h.level === 2 || h.level === 3);
  if (items.length === 0) return '';
  const li = items.map((h) => `<li class="toc-level-${h.level}"><a href="#${escapeHtml(encodeURIComponent(h.slug))}">${escapeHtml(h.text)}</a></li>`).join('\n');
  return `<nav class="page-toc" aria-label="${escapeHtml(STRINGS.tocLabel)}">
<p class="toc-label">${escapeHtml(STRINGS.tocLabel)}</p>
<ul>
${li}
</ul>
</nav>
`;
}

/** Render a document to its heading list, table of contents and body HTML. Shared by the page and the fragment. */
function buildDocument({ pyramid, path, source, view, links, report, titleId }) {
  const docs = listDocs(pyramid);
  const docPaths = new Set(docs.map((d) => d.path));
  const doc = docs.find((d) => d.path === path);
  const title = doc ? doc.title : titleFromPath(path);
  const resolveLink = (target, fragment) => {
    const found = findDocument(target, docPaths);
    if (!found) return null;
    const wanted = fragment ? decodeFragment(fragment) : null;
    const targetDoc = docs.find((d) => d.path === found);
    // A fragment that names no heading goes to the document start and is reported. Too-large files have no headings.
    const missing = wanted !== null && targetDoc && !targetDoc.tooLarge && !targetDoc.headings.some((h) => h.slug === wanted);
    if (missing) return { href: links.doc(view, found, null), missingFragment: true };
    return links.doc(view, found, wanted);
  };
  const idAttr = titleId ? ` id="${titleId}"` : '';
  let body;
  let headings = [];
  if (source === null) {
    body = `<h1${idAttr}>${escapeHtml(title)}</h1>\n<p class="notice">${escapeHtml(STRINGS.tooLarge)}</p>`;
  } else {
    const rendered = renderMarkdown(source, { sourcePath: path, resolveLink, report, promoteTitle: true });
    headings = rendered.headings;
    // A promoted "##" title is the page's h1 already (see the pyramid_title rule in viewer.js): no second one is made.
    const hasTitle = rendered.titlePromoted || (headings.length > 0 && headings[0].level === 1);
    body = `${hasTitle ? '' : `<h1${idAttr}>${escapeHtml(title)}</h1>\n`}${rendered.html}`;
  }
  const toc = view === 'pyramid' && source !== null ? tocList(headings) : '';
  return { title, toc, body };
}

/**
 * One document page.
 * @param {object} options
 * @param {object} options.pyramid Model from loadPyramid.
 * @param {string} options.path Document path relative to the docs root.
 * @param {string|null} options.source Markdown text, or null when the file is too large to show.
 * @param {'pyramid'|'tree'} [options.view]
 * @param {('pyramid'|'tree')[]} [options.views]
 * @param {PageLinks} options.links
 * @param {string} [options.siteName]
 * @param {2|3} [options.depth]
 * @param {string|null} [options.at] Heading slug that is open in the tree index.
 * @param {boolean} [options.openAllSections] Show the ### list under every ## heading of this document (static export, where no section can be remembered).
 * @param {import('../viewer.js').LinkReport} [options.report] Collects link counts and warnings.
 * @returns {string}
 */
export function renderDocumentPage({ pyramid, path, source, view = 'pyramid', views = ['pyramid', 'tree'], links, siteName = STRINGS.siteName, depth = 3, at = null, openAllSections = false, report, skinPage = null }) {
  const { title, toc, body } = buildDocument({ pyramid, path, source, view, links, report, titleId: 'pv-title' });
  // From the tree view the switch goes to the pyramid picture (the overview), not to the same document in a page
  // that has no index. From the pyramid view it opens the same document in the tree view, with the index.
  const switchHref = view === 'tree' ? links.overview('pyramid') : links.doc('tree', path);
  const aside = view === 'tree' ? treeIndex(pyramid, links, { current: { path, at }, depth, openAllSections }) : '';
  return layout({ title: `${title} - ${siteName}`, view, views, links, siteName, switchHref, main: `${toc}${body}`, aside, skinPage });
}

/**
 * One document as a fragment for the dialog: the page table of contents and the article, without the page
 * layout, header or skip link. It always uses the pyramid view's link policy. A document without a title
 * heading gets a generated one without an id, so the id cannot meet the id of the page that shows the dialog.
 * @param {object} options
 * @param {object} options.pyramid Model from loadPyramid.
 * @param {string} options.path
 * @param {string|null} options.source
 * @param {PageLinks} options.links Links as seen from the page that the fragment stands for.
 * @param {import('../viewer.js').LinkReport} [options.report]
 * @returns {string}
 */
export function renderDocumentFragment({ pyramid, path, source, links, report }) {
  const { toc, body } = buildDocument({ pyramid, path, source, view: 'pyramid', links, report, titleId: null });
  return `<article class="doc">\n${toc}${body}\n</article>\n`;
}

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}
