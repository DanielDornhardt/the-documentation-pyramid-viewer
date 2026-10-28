// Skins and user tokens.
//
// Two looks share one structural stylesheet: "light" and "metal". "plain" is an accepted alias of "light" everywhere
// a skin name is read (command line, query parameter, options). A user may add a third file of design tokens.

import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Skins the viewer knows by name. */
export const SKINS = ['light', 'metal'];
/** Other names that stand for a skin. */
export const SKIN_ALIASES = { plain: 'light' };
export const DEFAULT_SKIN = 'light';
/** Vertical density of the overview page: comfortable (default) or compact (less height, more of the pyramid in view). */
export const DENSITIES = ['comfortable', 'compact'];
export const DEFAULT_DENSITY = 'comfortable';

/** Folder of the stylesheets and the files in it, in the order a page links them (base first, then the theme). */
export const SKIN_DIR = fileURLToPath(new URL('../skins/', import.meta.url));
export const BASE_STYLE_FILE = 'pv-base.css';
export const SKIN_FILES = [BASE_STYLE_FILE, ...SKINS.map((s) => `${s}.css`)];
/** Name of the user tokens file inside an export, and the route in serve mode. */
export const TOKENS_EXPORT_FILE = 'skins/custom.css';
export const TOKENS_ROUTE = '/_pv/tokens.css';
export const TOKENS_MAX_BYTES = 262144;

/** The canonical skin name for a value, applying the alias, or null when the value names no skin. */
export function resolveSkin(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  if (SKINS.includes(name)) return name;
  return Object.hasOwn(SKIN_ALIASES, name) ? SKIN_ALIASES[name] : null;
}

/** The names that are valid on the command line, for messages. */
export const SKIN_HELP = `${SKINS.join(', ')} (plain is also accepted)`;

/** An error in the --tokens file. The command line turns it into a usage error. */
export class TokensError extends Error {}

/**
 * Read a user tokens file. It must be a regular file below 256 KB with valid text; the CSS itself is not checked.
 * @param {string} path
 * @returns {Promise<string>} The CSS text without a byte order mark.
 */
export async function readTokensFile(path) {
  let real;
  try {
    real = await realpath(path);
  } catch {
    throw new TokensError(`--tokens: the file "${path}" does not exist.`);
  }
  let info;
  try {
    info = await stat(real);
  } catch {
    throw new TokensError(`--tokens: the file "${path}" does not exist.`);
  }
  if (!info.isFile()) throw new TokensError(`--tokens: "${path}" is not a regular file.`);
  if (info.size >= TOKENS_MAX_BYTES) throw new TokensError(`--tokens: "${path}" is larger than 256 KB (${TOKENS_MAX_BYTES} bytes).`);
  let buffer;
  try {
    buffer = await readFile(real);
  } catch {
    throw new TokensError(`--tokens: the file "${path}" cannot be read.`);
  }
  if (buffer.length >= TOKENS_MAX_BYTES) throw new TokensError(`--tokens: "${path}" is larger than 256 KB (${TOKENS_MAX_BYTES} bytes).`);
  if (buffer.includes(0)) throw new TokensError(`--tokens: "${path}" is not a text file.`);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new TokensError(`--tokens: "${path}" is not valid UTF-8 text.`);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Name of the one cookie that serve mode sets: the skin chosen with the switcher in the page header. */
export const SKIN_COOKIE = 'pv-skin';

/**
 * The skin named by the cookie header, or null when there is none or it names no skin. The value is checked against
 * the skin names and is never used as written.
 * @param {string|undefined} header Value of the Cookie request header.
 * @returns {string|null}
 */
export function skinFromCookie(header) {
  if (typeof header !== 'string' || header.length > 4096) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== SKIN_COOKIE) continue;
    return resolveSkin(part.slice(at + 1).trim());
  }
  return null;
}

/** The Set-Cookie header value for a skin: one year, whole site, not readable by scripts, no Secure (plain http on this computer). */
export function skinCookieHeader(skin) {
  if (!SKINS.includes(skin)) throw new Error(`Unknown skin "${skin}".`);
  return `${SKIN_COOKIE}=${skin}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
}
