// Fonts of the skins. The metal skin names IBM Plex first; the official, unmodified files are in vendor/fonts/ (see its
// NOTICE.md). The HTML export embeds them as base64 in one stylesheet per skin (file:// pages cannot always load font
// files from another folder); serve mode links the same rules to /assets/fonts/ instead.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const FONT_DIR = fileURLToPath(new URL('../vendor/fonts/', import.meta.url));
/** The URL folder of the font files in serve mode. */
export const FONT_URL_DIR = 'assets/fonts';

/** Only the weights and styles that the skin uses (the 650 weight of a few headings falls to the bold file). */
const PLEX = [
  { family: 'IBM Plex Sans', weight: 400, style: 'normal', file: 'IBMPlexSans-Regular.woff2' },
  { family: 'IBM Plex Sans', weight: 500, style: 'normal', file: 'IBMPlexSans-Medium.woff2' },
  { family: 'IBM Plex Sans', weight: 600, style: 'normal', file: 'IBMPlexSans-SemiBold.woff2' },
  { family: 'IBM Plex Sans', weight: 700, style: 'normal', file: 'IBMPlexSans-Bold.woff2' },
  { family: 'IBM Plex Sans', weight: 400, style: 'italic', file: 'IBMPlexSans-Italic.woff2' },
  { family: 'IBM Plex Mono', weight: 400, style: 'normal', file: 'IBMPlexMono-Regular.woff2' }
];

/** The fonts of each skin. The light skin names Geist first and falls back to the system fonts; it bundles none. */
export const SKIN_FONTS = { light: [], metal: PLEX };

export const FONT_FILES = new Set(PLEX.map((face) => face.file));

/** The name of the generated stylesheet of a skin, or null when the skin bundles no fonts. */
export const fontsStylesheet = (skin) => (SKIN_FONTS[skin] && SKIN_FONTS[skin].length > 0 ? `${skin}-fonts.css` : null);

/**
 * The @font-face rules of a skin. With inline true the files are embedded as data URIs; otherwise the rules point at
 * `../assets/fonts/<file>` (relative to the stylesheet in the skins folder).
 */
export async function fontCss(skin, { inline }) {
  const rules = [];
  for (const face of SKIN_FONTS[skin] || []) {
    const src = inline
      ? `data:font/woff2;base64,${(await readFile(join(FONT_DIR, face.file))).toString('base64')}`
      : `../${FONT_URL_DIR}/${face.file}`;
    rules.push(`@font-face {\n  font-family: "${face.family}";\n  font-style: ${face.style};\n  font-weight: ${face.weight};\n  font-display: swap;\n  src: url("${src}") format("woff2");\n}`);
  }
  return rules.join('\n') + (rules.length ? '\n' : '');
}

export const readFontFile = (file) => readFile(join(FONT_DIR, file));
