// Safe file writing.
//
// The exporters write into a folder the user names. If somebody put a symbolic link there, a plain write would
// follow it and replace another file. These helpers refuse that: the target is checked with lstat, and the file
// is opened with O_NOFOLLOW where the platform has it. Symbolic links in the folders above the target are not
// checked; the output folder itself is chosen by the user.

import { constants } from 'node:fs';
import { lstat, writeFile } from 'node:fs/promises';

/**
 * Write a UTF-8 text file without following a symbolic link at the target.
 * @param {string} path
 * @param {string} text
 * @param {{exclusive?: boolean}} [options] exclusive: fail with EEXIST when the file exists (no overwrite).
 */
export async function writeFileSafely(path, text, { exclusive = false } = {}) {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw refusal(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const flag = constants.O_WRONLY | constants.O_CREAT | (exclusive ? constants.O_EXCL : constants.O_TRUNC) | (constants.O_NOFOLLOW || 0);
  try {
    await writeFile(path, text, { encoding: 'utf8', flag });
  } catch (error) {
    if (error.code === 'ELOOP') throw refusal(path);
    throw error;
  }
}

function refusal(path) {
  return Object.assign(new Error(`Refusing to write through a symbolic link: ${path}. Remove the link or choose another output folder.`), { code: 'E_SYMLINK' });
}
