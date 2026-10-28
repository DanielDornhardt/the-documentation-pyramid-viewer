// Serve mode.
//
// A small node:http server. Every request reads the docs folder again (no cache). Only GET and HEAD are
// answered. Paths are checked by resolveRequestPath and must name a document that the pyramid model lists.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { loadPyramid, readDocumentText, resolveRequestPath, LayerConfigError } from '../viewer.js';
import { renderOverviewPage, renderDocumentPage, renderDocumentFragment } from './pages.js';
import { NO_LAYERS_MESSAGE, notOnPyramidLine, folderIndexLines } from './export.js';
import { FONT_FILES, FONT_URL_DIR, fontCss, fontsStylesheet, readFontFile } from './fonts.js';
import { SKINS, SKIN_FILES, SKIN_HELP, DEFAULT_SKIN, DENSITIES, DEFAULT_DENSITY, SKIN_DIR, TOKENS_ROUTE, resolveSkin, readTokensFile, skinFromCookie, skinCookieHeader } from './skins.js';
import { createWatcher, createLiveHub, EVENTS_ROUTE, LIVE_SCRIPT_URL } from './watch.js';

export { SKINS };

/** The dialog script. Its file name is also its URL below /assets/ in serve mode and in the export. */
export const DIALOG_SCRIPT_FILE = fileURLToPath(new URL('../assets/pv-dialog.js', import.meta.url));
export const DIALOG_SCRIPT_URL = 'assets/pv-dialog.js';
/** The live script of serve --watch. */
export const LIVE_SCRIPT_FILE = fileURLToPath(new URL('../assets/pv-live.js', import.meta.url));
const TREE_PREFIX = '/_tree';
const CONTENT_PREFIX = '/_content';

const SECURITY_HEADERS = {
  // No inline script. The only script is the dialog script from this server (script-src 'self'), which loads
  // document fragments from this server (connect-src 'self'). It is linked only from the pyramid overview.
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
};

/**
 * Options for the server.
 * @typedef {object} ServeOptions
 * @property {string} root Docs folder.
 * @property {number} [port] Port; 0 picks a free one. Default 4000.
 * @property {string} [host] Bind address. Default 127.0.0.1.
 * @property {'light'|'metal'|'plain'} [skin] Default skin. Default light; plain is another name for light.
 * @property {string} [tokensFile] CSS file of user design tokens, linked after the skin and read on every request.
 * @property {boolean} [watch] Watch the files and push change messages to the pages (server-sent events). Default off.
 * @property {number} [watchDebounceMs] Quiet time before a change message goes out. Default 150. For tests.
 * @property {number} [pingMs] Interval of the comment ping on an event stream. Default 25000. For tests.
 * @property {string} [skinDir] Folder of the stylesheets. Default: the skins folder of the viewer. For tests.
 * @property {2|3} [depth] Deepest heading level in the tree index. Default 3.
 * @property {import('../viewer.js').LayerConfig[]} [layers]
 * @property {string} [layersFile]
 * @property {string[]} [allowedHosts] Extra host names the Host header may carry (for a server reached by name).
 * @property {string} [siteName]
 * @property {{info: (m: string) => void, warn: (m: string) => void}} [log]
 */

/** Whether the file lies inside the folder (so a watcher on the folder already sees it). */
export function isInside(folder, file) {
  const rel = relative(resolve(folder), resolve(file));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const WILDCARD = new Set(['0.0.0.0', '::']);

/** Split a Host header into a lower-case host name (IPv6 in brackets) and a port text ('' when absent). */
function parseHostHeader(value) {
  const text = String(value || '').trim().toLowerCase();
  const match = /^(\[[^\]]*\]|[^:\[\]]*)(?::(\d*))?$/.exec(text);
  return match ? { name: match[1], port: match[2] || '' } : { name: '', port: '' };
}

const bracketed = (host) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host.toLowerCase());

/**
 * Answer 403 unless the Host header names this server. This blocks DNS rebinding: a page on another site
 * cannot read the docs through a name that it has pointed at 127.0.0.1.
 */
function hostAllowed(req, config) {
  if (config.anyHost) return true;
  const { name, port } = parseHostHeader(req.headers.host);
  if (!name || !config.allowedHostNames.has(name)) return false;
  return port === '' || Number(port) === config.port;
}

function send(res, status, type, body, extra = {}) {
  const buffer = Buffer.from(body, 'utf8');
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': buffer.length, ...extra });
  res.end(buffer);
}

const sendText = (res, status, text, extra) => send(res, status, 'text/plain; charset=utf-8', `${text}\n`, extra);
const notFound = (res) => sendText(res, 404, 'Not found');

/**
 * URL mapper for server routes. explicitSkin is carried along so a chosen skin sticks while browsing.
 * Options: withTokens links the user tokens file, live adds the live script and the event stream address.
 */
function serverLinks(skinName, explicitSkin, { withTokens = false, live = false, density = DEFAULT_DENSITY } = {}) {
  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const query = (at, skin = explicitSkin) => {
    const params = new URLSearchParams();
    if (at) params.set('at', at);
    if (skin) params.set('skin', skin);
    const text = params.toString();
    return text ? `?${text}` : '';
  };
  const docUrl = (view, docPath, fragment, extra = {}, skin = explicitSkin) =>
    `${view === 'tree' ? TREE_PREFIX : ''}/${encodePath(docPath)}${query(extra.at, skin)}${fragment ? `#${encodeURIComponent(fragment)}` : ''}`;
  const links = {
    overview: (view) => `${view === 'tree' ? `${TREE_PREFIX}/` : '/'}${query()}`,
    doc: (view, docPath, fragment, extra = {}) => docUrl(view, docPath, fragment, extra),
    skin: skinName,
    density,
    styles: () => [`/skins/${SKIN_FILES[0]}`, `/skins/${skinName}.css`, ...(fontsStylesheet(skinName) ? [`/skins/${fontsStylesheet(skinName)}`] : []), ...(withTokens ? [TOKENS_ROUTE] : [])],
    script: () => `/${DIALOG_SCRIPT_URL}`,
    contentBase: () => CONTENT_PREFIX,
    /** Switcher entries for the page being built: the same page in every skin (the tree view keeps its open section). */
    skinSwitch: (page) =>
      SKINS.map((name) => ({
        name,
        current: name === skinName,
        href: page.docPath ? docUrl(page.view, page.docPath, null, { at: page.at }, name) : `${page.view === 'tree' ? `${TREE_PREFIX}/` : '/'}${query(null, name)}`
      }))
  };
  if (live) links.live = () => ({ script: `/${LIVE_SCRIPT_URL}`, events: EVENTS_ROUTE });
  return links;
}

async function handleScriptFile(res) {
  try {
    send(res, 200, 'text/javascript; charset=utf-8', await readFile(DIALOG_SCRIPT_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    sendText(res, 404, 'The dialog script is missing in this copy of the viewer (assets/pv-dialog.js).');
  }
}

async function handleLiveScript(res) {
  try {
    send(res, 200, 'text/javascript; charset=utf-8', await readFile(LIVE_SCRIPT_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    sendText(res, 404, 'The live script is missing in this copy of the viewer (assets/pv-live.js).');
  }
}

/** The font files of the metal skin, only those that the viewer ships (a fixed list of names). */
async function handleFontFile(res, rawPath) {
  const name = rawPath.slice(`/${FONT_URL_DIR}/`.length);
  if (!FONT_FILES.has(name)) return notFound(res);
  try {
    send(res, 200, 'font/woff2', await readFontFile(name), { 'Cache-Control': 'public, max-age=3600' });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    sendText(res, 404, `The font file "${name}" is missing in this copy of the viewer (vendor/fonts/).`);
  }
}

async function handleSkinFile(res, rawPath, config) {
  const generated = SKINS.find((skin) => rawPath === `/skins/${fontsStylesheet(skin)}`);
  if (generated) return send(res, 200, 'text/css; charset=utf-8', await fontCss(generated, { inline: false }));
  const match = /^\/skins\/([a-z0-9-]+\.css)$/.exec(rawPath);
  if (!match || !SKIN_FILES.includes(match[1])) return notFound(res);
  try {
    send(res, 200, 'text/css; charset=utf-8', await readFile(join(config.skinDir, match[1]), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    sendText(res, 404, `The stylesheet "${match[1]}" is missing in this copy of the viewer (skins/${match[1]}).`);
  }
}

/** The user tokens file is read on every request, so an edit shows on reload. A file that went missing gives a 404 and the page still renders. */
async function handleTokensFile(res, config) {
  try {
    send(res, 200, 'text/css; charset=utf-8', await readTokensFile(config.tokensFile));
  } catch (error) {
    // The detail names a local path: it goes to the console of the operator, not to the browser.
    config.log.warn(`Warning: tokens file not served: ${error.message}`);
    sendText(res, 404, 'The tokens file is not available.');
  }
}

async function handleRequest(req, res, config) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method not allowed. Use GET or HEAD.', { Allow: 'GET, HEAD' });
  }
  if (!hostAllowed(req, config)) return sendText(res, 403, 'Forbidden. This server answers only to its own address. Open it with the address printed at start.');
  const target = req.url || '';
  if (!target.startsWith('/')) return notFound(res);
  const queryAt = target.indexOf('?');
  const hashAt = target.indexOf('#');
  const pathEnd = [queryAt, hashAt].filter((i) => i !== -1).reduce((a, b) => Math.min(a, b), target.length);
  const rawPath = target.slice(0, pathEnd);
  const params = new URLSearchParams(queryAt === -1 ? '' : target.slice(queryAt + 1, hashAt > queryAt ? hashAt : undefined));

  if (rawPath.startsWith('/skins/')) return handleSkinFile(res, rawPath, config);
  if (rawPath.startsWith(`/${FONT_URL_DIR}/`)) return handleFontFile(res, rawPath);
  if (rawPath === TOKENS_ROUTE && config.tokensFile) return handleTokensFile(res, config);
  if (rawPath === `/${DIALOG_SCRIPT_URL}`) return handleScriptFile(res);
  if (rawPath === EVENTS_ROUTE || rawPath === `/${LIVE_SCRIPT_URL}`) {
    if (!config.hub) return notFound(res);
    if (rawPath === EVENTS_ROUTE) {
      // A stream is for GET only: a HEAD request must not open one.
      if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed. Use GET.', { Allow: 'GET' });
      // A page of another origin must not hold the limited connection slots: a present Origin has to match the Host.
      const origin = req.headers.origin;
      if (origin) {
        let originHost = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          /* an unparsable Origin is refused below */
        }
        if (originHost !== req.headers.host) return sendText(res, 403, 'Forbidden. The event stream is for pages of this server only.');
      }
      return config.hub.attach(req, res, SECURITY_HEADERS);
    }
    return handleLiveScript(res);
  }

  const requested = params.get('skin');
  // A value that names no skin is ignored as a whole (nothing is carried in links, the cookie stays as it is); the typed
  // text is never echoed. "plain" is carried as "light". Order: query, cookie, --skin option, light.
  const queryValid = requested === null ? null : resolveSkin(requested);
  const explicitSkin = queryValid || null;
  const cookieSkin = explicitSkin ? null : skinFromCookie(req.headers.cookie);
  const skinName = explicitSkin || cookieSkin || config.skin;
  // Pages answer differently per cookie. A valid query that differs from the cookie sets the cookie.
  const pageHeaders = { Vary: 'Cookie' };
  if (queryValid && queryValid !== skinFromCookie(req.headers.cookie)) pageHeaders['Set-Cookie'] = skinCookieHeader(queryValid);
  const links = serverLinks(skinName, explicitSkin, { withTokens: Boolean(config.tokensFile), live: Boolean(config.hub), density: config.density });
  const common = { links, siteName: config.siteName, depth: config.depth, views: ['pyramid', 'tree'] };

  const isTree = rawPath === TREE_PREFIX || rawPath.startsWith(`${TREE_PREFIX}/`);
  const isContent = rawPath.startsWith(`${CONTENT_PREFIX}/`);
  const view = isTree ? 'tree' : 'pyramid';
  const docRequest = isTree ? rawPath.slice(TREE_PREFIX.length) : isContent ? rawPath.slice(CONTENT_PREFIX.length) : rawPath;
  // A fragment is a document, so the overview has none: /_content/ alone is a 404.
  if (isContent && (docRequest === '' || docRequest === '/')) return notFound(res);

  if (docRequest === '' || docRequest === '/') {
    const pyramid = await loadPyramid(config.root, config.layerOptions);
    // The tree view has no overview of its own: it opens on the first document (the vision, in a pyramid).
    const first = view === 'tree' ? pyramid.all.flatMap((layer) => layer.docs)[0] : null;
    if (first) {
      try {
        const source = await readDocumentText(join(config.root, ...first.path.split('/')));
        return send(res, 200, 'text/html; charset=utf-8', renderDocumentPage({ pyramid, path: first.path, source, view, ...common, skinPage: { view, docPath: null } }), pageHeaders);
      } catch (error) {
        if (error.code !== 'E_TOO_LARGE' && error.code !== 'ENOENT') throw error;
      }
    }
    return send(res, 200, 'text/html; charset=utf-8', renderOverviewPage({ pyramid, view, ...common, skinPage: { view, docPath: null } }), pageHeaders);
  }

  const hit = await resolveRequestPath(config.root, docRequest);
  if (!hit) return notFound(res);
  const pyramid = await loadPyramid(config.root, config.layerOptions);
  const known = pyramid.all.some((layer) => layer.docs.some((d) => d.path === hit.relativePath));
  if (!known) return notFound(res);

  let source = null;
  let status = 200;
  try {
    source = await readDocumentText(hit.absolutePath);
  } catch (error) {
    if (error.code === 'E_TOO_LARGE') status = 413;
    else if (error.code === 'ENOENT') return notFound(res);
    else throw error;
  }
  if (isContent) return send(res, status, 'text/html; charset=utf-8', renderDocumentFragment({ pyramid, path: hit.relativePath, source, links }), { Vary: 'Cookie' });
  const at = params.get('at');
  send(res, status, 'text/html; charset=utf-8', renderDocumentPage({ pyramid, path: hit.relativePath, source, view, at, ...common, skinPage: { view, docPath: hit.relativePath, at } }), pageHeaders);
}

/**
 * Start the server and wait until it listens.
 * @param {ServeOptions} options
 * @returns {Promise<{server: import('node:http').Server, port: number, host: string, url: string, close: () => Promise<void>}>}
 */
export async function startServer(options) {
  const log = options.log || { info: (m) => process.stdout.write(`${m}\n`), warn: (m) => process.stderr.write(`${m}\n`) };
  const host = options.host || '127.0.0.1';
  const port = options.port === undefined ? 4000 : options.port;
  const skin = options.skin === undefined ? DEFAULT_SKIN : resolveSkin(options.skin);
  const depth = options.depth === 2 ? 2 : 3;
  const density = options.density === undefined ? DEFAULT_DENSITY : options.density;
  if (!DENSITIES.includes(density)) throw new Error(`Unknown density "${options.density}". Valid values: ${DENSITIES.join(', ')}`);
  if (!skin) throw new Error(`Unknown skin "${options.skin}". Valid skins: ${SKIN_HELP}`);
  let tokensFile;
  if (options.tokensFile !== undefined) {
    await readTokensFile(options.tokensFile);
    tokensFile = options.tokensFile;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port "${options.port}". Use a number from 0 to 65535.`);
  try {
    if (!(await stat(options.root)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Docs folder not found or not a folder: ${options.root}`);
  }
  const allowedHosts = (options.allowedHosts || []).map((h) => bracketed(String(h).trim())).filter(Boolean);
  const allowedHostNames = new Set(['127.0.0.1', 'localhost', '[::1]', ...allowedHosts]);
  if (!WILDCARD.has(host)) allowedHostNames.add(bracketed(host));

  const config = {
    // A wildcard address (0.0.0.0) is reached by many names; without an allow-list nothing can be checked.
    anyHost: WILDCARD.has(host) && allowedHosts.length === 0,
    allowedHostNames,
    port: 0,
    root: options.root,
    skin,
    density,
    skinDir: options.skinDir || SKIN_DIR,
    tokensFile,
    log,
    hub: options.watch ? createLiveHub({ pingMs: options.pingMs }) : null,
    depth,
    siteName: options.siteName,
    layerOptions: { layers: options.layers, layersFile: options.layersFile }
  };
  const server = createServer((req, res) => {
    handleRequest(req, res, config).catch((error) => {
      if (res.headersSent) return res.destroy();
      // A layer-config mistake made while serving (pyramid.json is read on every request) is the user's to fix: say what it is.
      if (error instanceof LayerConfigError) {
        log.warn(`Warning: ${error.message}`);
        return sendText(res, 500, `${error.message}\nFix pyramid.json and reload the page.`);
      }
      const message = /Docs folder not found/.test(error.message) ? 'The docs folder is not available.' : 'Internal error.';
      sendText(res, 500, message);
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(Object.assign(new Error(`Port ${port} is already in use on ${host}. Choose another port with --port, or use --port 0 for a free one.`), { code: 'EADDRINUSE' }));
      } else if (error.code === 'EACCES') {
        reject(Object.assign(new Error(`No permission to listen on port ${port}. Choose a port above 1023.`), { code: 'EACCES' }));
      } else {
        reject(error);
      }
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const actualPort = server.address().port;
  config.port = actualPort;
  let watcher = null;
  if (config.hub) {
    watcher = createWatcher({
      root: config.root,
      skinDir: config.skinDir,
      tokensFile: config.tokensFile,
      layersFile: options.layersFile && !isInside(config.root, options.layersFile) ? options.layersFile : undefined,
      debounceMs: options.watchDebounceMs,
      onChange: (change) => config.hub.broadcast(change),
      onWarning: (m) => log.warn(m)
    });
    if (watcher.started === 0) log.warn('Warning: no file watcher could start. The pages will not update by themselves.');
  }
  const closeAll = () =>
    new Promise((resolve) => {
      if (watcher) watcher.close();
      if (config.hub) config.hub.close();
      server.close(() => resolve());
      server.closeAllConnections();
    });
  if (!LOOPBACK.has(host)) {
    log.warn(`Warning: listening on ${host}, not only on this computer. Anyone who can reach this address can read the docs folder.`);
  }
  try {
    const pyramid = await loadPyramid(config.root, config.layerOptions);
    if (pyramid.all.length === 0) log.warn(`Warning: ${NO_LAYERS_MESSAGE}`);
    const offLine = notOnPyramidLine(pyramid.offPyramid, 'tree', (pyramid.offPyramidUnlinked || []).length);
    if (offLine) log.info(offLine);
    for (const line of folderIndexLines(pyramid)) log.info(line);
  } catch (error) {
    // A mistake in the layer configuration is the user's to fix: do not serve pages that would all fail.
    if (error instanceof LayerConfigError) {
      await closeAll();
      throw error;
    }
    log.warn(`Warning: the layers could not be read: ${error.message}`);
  }
  const shownHost = host.includes(':') ? `[${host}]` : host;
  return {
    server,
    port: actualPort,
    host,
    url: `http://${shownHost}:${actualPort}/`,
    close: closeAll
  };
}

/**
 * Start the server, print the address, and close cleanly on SIGINT or SIGTERM. Resolves after the close.
 * A start failure (for example a busy port) rejects with a clear message.
 * @param {ServeOptions} options
 * @returns {Promise<void>}
 */
export async function runServe(options) {
  const log = options.log || { info: (m) => process.stdout.write(`${m}\n`), warn: (m) => process.stderr.write(`${m}\n`) };
  const running = await startServer({ ...options, log });
  log.info(`Serving ${options.root} at ${running.url}`);
  if (options.watch) log.info('Watching the docs for changes. Open pages update by themselves.');
  log.info('Press Ctrl+C to stop.');
  await new Promise((resolve) => {
    const stop = async () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      await running.close();
      log.info('Stopped.');
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
