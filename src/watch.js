// Watch mode: the file watcher and the server-sent events hub.
//
// Only serve --watch creates these. The watcher turns file system events into one small change message per burst
// of writes. The hub keeps the open event streams (a limited number) and sends them that message. No document
// content ever travels over a stream: the message holds two flags, a counter and the relative paths of changed files.

import { realpathSync, watch as fsWatch } from 'node:fs';
import { basename, dirname } from 'node:path';

export const EVENTS_ROUTE = '/_pv/events';
export const LIVE_SCRIPT_URL = 'assets/pv-live.js';
export const MAX_CONNECTIONS = 20;
export const MAX_LISTED_PATHS = 50;
const DEFAULT_DEBOUNCE_MS = 150;
const MAX_WAIT_MS = 1000;
const DEFAULT_PING_MS = 25000;

/**
 * What a change at a relative path inside the docs folder means. Dot folders and node_modules are ignored at any depth.
 * A path without a dot in its last segment may be a folder that came or went, so it counts as a docs change without a name.
 * @param {string} relative Path relative to the watched folder, with any separator.
 * @returns {{docs: boolean, path?: string}|null} null when the change is ignored.
 */
export function classifyDocsChange(relative) {
  const segments = String(relative).split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((s) => s.startsWith('.') || s === 'node_modules')) return null;
  const last = segments[segments.length - 1];
  const path = segments.join('/');
  if (/\.md$/i.test(last) || last === 'pyramid.json') return { docs: true, path };
  if (!last.includes('.')) return { docs: true };
  return null;
}

/**
 * Watch the docs folder, the skins folder and the tokens file, and report merged changes.
 * @param {object} options
 * @param {string} options.root Docs folder (recursive).
 * @param {string} [options.skinDir] Folder of the stylesheets; a change to a .css file there counts as a css change.
 * @param {string} [options.tokensFile] The user tokens file; its folder is watched, filtered by the file name.
 * @param {string} [options.layersFile] The layers file when it lies outside the docs folder.
 * @param {number} [options.debounceMs] Quiet time before a message goes out. Default 150.
 * @param {(change: {docs: boolean, css: boolean, paths: string[], many: boolean}) => void} options.onChange
 * @param {(message: string) => void} [options.onWarning]
 * @returns {{close: () => void, started: number}} started is the number of watchers that run.
 */
export function createWatcher({ root, skinDir, tokensFile, layersFile, debounceMs = DEFAULT_DEBOUNCE_MS, onChange, onWarning = () => {} }) {
  const watchers = [];
  let pending = null;
  let timer = null;
  let firstAt = 0;
  let closed = false;

  const fire = () => {
    timer = null;
    const change = pending;
    pending = null;
    if (!change || closed) return;
    const paths = [...change.paths].sort();
    const many = paths.length > MAX_LISTED_PATHS;
    onChange({ docs: change.docs, css: change.css, paths: many ? [] : paths, many });
  };

  const note = (kind, path) => {
    if (closed) return;
    const now = Date.now();
    if (!pending) {
      pending = { docs: false, css: false, paths: new Set() };
      firstAt = now;
    }
    pending[kind] = true;
    if (path) pending.paths.add(path);
    if (timer) clearTimeout(timer);
    // A steady stream of writes must not hold the message back for ever.
    timer = setTimeout(fire, Math.max(0, Math.min(debounceMs, firstAt + MAX_WAIT_MS - now)));
  };

  const start = (dir, options, handler, label) => {
    try {
      const w = fsWatch(dir, options, (event, name) => handler(name === null || name === undefined ? '' : String(name)));
      w.on('error', (error) => {
        onWarning(`Warning: the watcher for ${label} stopped (${error.code || error.message}). Live updates for it are off.`);
        try {
          w.close();
        } catch {
          /* already closed */
        }
      });
      watchers.push(w);
    } catch (error) {
      onWarning(`Warning: cannot watch ${label} (${error.code || error.message}). Live updates for it are off.`);
    }
  };

  start(root, { recursive: true }, (name) => {
    // An event without a file name still means that something changed.
    if (name === '') return note('docs');
    const hit = classifyDocsChange(name);
    if (hit) note('docs', hit.path);
  }, 'the docs folder');
  if (skinDir) {
    start(skinDir, {}, (name) => {
      if (name === '' || /\.css$/i.test(name)) note('css');
    }, 'the skins folder');
  }
  if (tokensFile) {
    const file = basename(tokensFile);
    start(dirname(tokensFile), {}, (name) => {
      if (name === '' || name === file) note('css');
    }, 'the tokens file');
    // A symbolic link is edited at its target, which may sit in another folder: watch that file as well.
    let target = null;
    try {
      target = realpathSync(tokensFile);
    } catch (error) {
      /* the file may not exist yet; the link itself is watched above */
    }
    if (target && target !== tokensFile) {
      const targetName = basename(target);
      start(dirname(target), {}, (name) => {
        if (name === '' || name === targetName) note('css');
      }, 'the target of the tokens file');
    }
  }
  if (layersFile) {
    const file = basename(layersFile);
    start(dirname(layersFile), {}, (name) => {
      if (name === '' || name === file) note('docs', file);
    }, 'the layers file');
  }

  return {
    started: watchers.length,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      for (const w of watchers.splice(0)) {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      }
    }
  };
}

/**
 * The open event streams. At most maxConnections at a time; one timer sends a comment ping to all of them.
 * @param {object} [options]
 * @param {number} [options.maxConnections]
 * @param {number} [options.pingMs]
 */
export function createLiveHub({ maxConnections = MAX_CONNECTIONS, pingMs = DEFAULT_PING_MS } = {}) {
  const clients = new Set();
  let counter = 0;
  let pinger = null;

  const ensurePinger = () => {
    if (pinger) return;
    pinger = setInterval(() => {
      for (const res of clients) res.write(': ping\n\n');
    }, pingMs);
    pinger.unref();
  };

  return {
    get size() {
      return clients.size;
    },
    /**
     * Take over a GET request as an event stream. Answers 503 when the limit is reached.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {Record<string, string>} headers Security headers of the server.
     */
    attach(req, res, headers) {
      if (clients.size >= maxConnections) {
        const body = Buffer.from('Too many live connections.\n', 'utf8');
        res.writeHead(503, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Retry-After': '5' });
        res.end(body);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n: connected\n\n');
      clients.add(res);
      ensurePinger();
      const drop = () => clients.delete(res);
      req.on('close', drop);
      res.on('close', drop);
    },
    /** Send a change message to every stream. The counter grows with each message. */
    broadcast(change) {
      counter += 1;
      const data = JSON.stringify({ n: counter, docs: change.docs, css: change.css, ...(change.many ? { many: true } : { paths: change.paths }) });
      for (const res of clients) res.write(`event: change\ndata: ${data}\n\n`);
      return counter;
    },
    /** End every stream and stop the ping timer. */
    close() {
      if (pinger) clearInterval(pinger);
      pinger = null;
      for (const res of clients) res.end();
      clients.clear();
    }
  };
}
