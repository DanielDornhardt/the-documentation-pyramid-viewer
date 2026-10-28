// Command line.
//
// Three commands: serve, export and markdown. Arguments are read with node:util parseArgs in strict mode.
// Problems with the arguments exit with code 2 and print the usage; problems at run time exit with code 1.
// parseArgs is loaded inside main on purpose: a static import would fail to link on old Node versions before the
// version guard (src/node-guard.js) could print its message.

import { runServe } from './server.js';
import { DENSITIES, SKIN_HELP, resolveSkin, readTokensFile, TokensError } from './skins.js';
import { exportHtml, EXPORT_VIEWS } from './export.js';
import { exportMarkdown } from './markdown-export.js';

const USAGE = `Usage:
  node viewer.js serve <docs> [--port N] [--host H] [--allow-host NAME] [--skin light|metal] [--density comfortable|compact] [--tokens file.css] [--watch] [--depth 2|3] [--layers file]
  node viewer.js export <docs> <out> [--view pyramid|tree|both] [--skin light|metal | --skins light,metal] [--density comfortable|compact] [--tokens file.css] [--depth 2|3] [--layers file]
  node viewer.js markdown <docs> <file> [--decisions] [--toc] [--anchors html|headings] [--force] [--layers file]
  node viewer.js --help

Commands:
  serve     Show the docs in a browser. Reads the folder on every request. Listens on 127.0.0.1 by default.
  export    Write the docs as static HTML pages (relative links, opens from file://) into <out>.
  markdown  Write the docs as one Markdown file.

Options:
  --view     Views to export: pyramid, tree or both (default both).
  --skin     Look: light (default) or metal. "plain" is accepted as another name for light.
  --skins    Export: several skins, one folder per skin with a skin switcher in every page, and an index.html that opens the first.
  --density  Height of the overview page: comfortable (default) or compact (less vertical space, more of the pyramid in view).
  --tokens   CSS file with your own design tokens (:root { --pv-...: value }), linked after the skin.
  --watch    Serve only: watch the docs and update open pages by themselves (opt-in).
  --depth    Deepest heading level in the tree index: 2 or 3 (default 3).
  --layers   JSON file with a custom layer list (default: pyramid.json in the docs folder, else detected by name).
  --port     Port for serve (default 4000; 0 picks a free port).
  --host     Address for serve (default 127.0.0.1; anything else prints a warning).
  --allow-host  Extra host name the server answers to, for serve; may be repeated. By default only the
             server's own address is answered (protection against DNS rebinding).
  --decisions  Append the decision records (markdown).
  --toc        Insert a table of contents (markdown).
  --anchors    Markdown links: html (default, explicit <a id> anchors) or headings (heading names, no HTML; for previews that ignore raw HTML).
  --force      Overwrite an existing output file (markdown).
`;

/** An error in the arguments: printed with the usage, exit code 2. */
class UsageError extends Error {}

const COMMANDS = {
  serve: {
    positionals: ['docs'],
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      'allow-host': { type: 'string', multiple: true },
      skin: { type: 'string' },
      density: { type: 'string' },
      tokens: { type: 'string' },
      watch: { type: 'boolean' },
      depth: { type: 'string' },
      layers: { type: 'string' }
    }
  },
  export: {
    positionals: ['docs', 'out'],
    options: {
      view: { type: 'string' },
      skins: { type: 'string' },
      skin: { type: 'string' },
      density: { type: 'string' },
      tokens: { type: 'string' },
      watch: { type: 'boolean' },
      depth: { type: 'string' },
      layers: { type: 'string' }
    }
  },
  markdown: {
    positionals: ['docs', 'file'],
    options: {
      decisions: { type: 'boolean' },
      toc: { type: 'boolean' },
      anchors: { type: 'string' },
      force: { type: 'boolean' },
      layers: { type: 'string' }
    }
  }
};

function oneOf(name, value, valid) {
  if (value === undefined) return undefined;
  if (!valid.includes(value)) throw new UsageError(`Unknown value "${value}" for --${name}. Valid values: ${valid.join(', ')}`);
  return value;
}

function readSkin(value) {
  if (value === undefined) return undefined;
  const skin = resolveSkin(value);
  if (!skin) throw new UsageError(`Unknown value "${value}" for --skin. Valid values: ${SKIN_HELP}.`);
  return skin;
}

function readSkins(value, single) {
  if (value === undefined) return undefined;
  if (single !== undefined) throw new UsageError('Use either --skin or --skins, not both.');
  const names = value.split(',').map((v) => v.trim()).filter(Boolean);
  if (names.length === 0) throw new UsageError('--skins needs at least one skin, for example --skins light,metal.');
  for (const name of names) readSkin(name);
  return names;
}

function parseCommand(parseArgs, name, argv) {
  const spec = COMMANDS[name];
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { ...spec.options, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true, tokens: true });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals, tokens } = parsed;
  if (values.help) return { help: true };
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== 'option' || spec.options[token.name]?.multiple) continue;
    if (seen.has(token.name)) throw new UsageError(`The option --${token.name} was given more than once.`);
    seen.add(token.name);
  }
  if (positionals.length !== spec.positionals.length) {
    const need = spec.positionals.map((p) => `<${p}>`).join(' ');
    throw new UsageError(`The ${name} command needs ${spec.positionals.length === 1 ? 'one argument' : `${spec.positionals.length} arguments`}: ${need}`);
  }
  const args = { ...values };
  spec.positionals.forEach((p, i) => {
    args[p] = positionals[i];
  });
  return args;
}

function readPort(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) > 65535) throw new UsageError(`Invalid value "${value}" for --port. Use a number from 0 to 65535.`);
  return Number(value);
}

function readDepth(value) {
  oneOf('depth', value, ['2', '3']);
  return value === undefined ? undefined : Number(value);
}

/**
 * Command line entry.
 * @param {string[]} argv Arguments after the script name.
 * @param {{stdout?: {write: (s: string) => unknown}, stderr?: {write: (s: string) => unknown}}} [streams]
 * @returns {Promise<number>} Exit code: 0 done, 1 run-time error or nothing written, 2 wrong arguments.
 */
export async function main(argv, streams = {}) {
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  const log = { info: (m) => stdout.write(`${m}\n`), warn: (m) => stderr.write(`${m}\n`) };

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    stdout.write(USAGE);
    return 0;
  }
  const name = argv[0];
  try {
    if (!Object.hasOwn(COMMANDS, name)) throw new UsageError(`Unknown command "${name}".`);
    const { parseArgs } = await import('node:util');
    const args = parseCommand(parseArgs, name, argv.slice(1));
    if (args.help) {
      stdout.write(USAGE);
      return 0;
    }
    const layersFile = args.layers;
    if (layersFile !== undefined) {
      try {
        const { readFile } = await import('node:fs/promises');
        await readFile(layersFile, 'utf8');
      } catch (error) {
        throw new Error(`Cannot read the layers file ${layersFile}: ${error.code || error.message}`);
      }
    }
    if (args.watch && name !== 'serve') throw new UsageError('--watch works only with serve.');
    if (args.tokens !== undefined) {
      try {
        await readTokensFile(args.tokens);
      } catch (error) {
        if (error instanceof TokensError) throw new UsageError(error.message);
        throw error;
      }
    }
    if (name === 'serve') {
      const options = {
        root: args.docs,
        port: readPort(args.port),
        host: args.host,
        allowedHosts: args['allow-host'],
        skin: readSkin(args.skin),
        density: oneOf('density', args.density, DENSITIES),
        tokensFile: args.tokens,
        watch: args.watch === true,
        depth: readDepth(args.depth),
        layersFile,
        log
      };
      await runServe(options);
      return 0;
    }
    if (name === 'export') {
      const options = {
        root: args.docs,
        out: args.out,
        view: oneOf('view', args.view, EXPORT_VIEWS),
        skin: readSkin(args.skin),
        skins: readSkins(args.skins, args.skin),
        density: oneOf('density', args.density, DENSITIES),
        tokensFile: args.tokens,
        depth: readDepth(args.depth),
        layersFile,
        log
      };
      const result = await exportHtml(options);
      return result.empty ? 1 : 0;
    }
    const written = await exportMarkdown({ root: args.docs, file: args.file, decisions: args.decisions, toc: args.toc, anchors: args.anchors, force: args.force, layersFile, log });
    return written.written ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`Error: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    stderr.write(`Error: ${error && error.message ? error.message : error}\n`);
    return 1;
  }
}
