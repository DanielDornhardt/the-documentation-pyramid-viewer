// Node version guard.
//
// viewer.js imports this file first, so the check runs before any other module of the viewer is evaluated.
// The file uses only old, plain syntax on purpose and does nothing but compare version numbers.

/** Oldest Node version the viewer supports, as "major.minor". Change it here; keep package.json engines in step. */
export const MIN_NODE_VERSION = '20.11';

/**
 * Compare a Node version with the floor.
 * @param {string} version For example "18.19.0" (process.versions.node).
 * @param {string} floor For example "20.11".
 * @returns {string|null} A message that explains the problem, or null when the version is new enough.
 */
export function checkNodeVersion(version, floor) {
  const have = String(version).split('.').map(Number);
  const need = String(floor).split('.').map(Number);
  const haveMajor = have[0] || 0;
  const haveMinor = have[1] || 0;
  const needMajor = need[0] || 0;
  const needMinor = need[1] || 0;
  if (haveMajor > needMajor || (haveMajor === needMajor && haveMinor >= needMinor)) return null;
  return (
    'The pyramid viewer needs Node ' + floor + ' or newer, but this is Node ' + version + '.\n' +
    'Install a newer Node (see https://nodejs.org/) and run the command again.\n'
  );
}

const problem = checkNodeVersion(process.versions.node, MIN_NODE_VERSION);
if (problem) {
  process.stderr.write(problem);
  process.exit(1);
}
