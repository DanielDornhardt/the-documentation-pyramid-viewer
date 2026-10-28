// AC 14 (command line and Node version) and AC 8/9 argument handling.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:http';
import { checkNodeVersion, MIN_NODE_VERSION } from '../src/node-guard.js';
import { fixture, runCli, listFiles, walkExport } from './helpers.js';

const viewerFile = fileURLToPath(new URL('../viewer.js', import.meta.url));
let base;
before(async () => {
  base = await mkdtemp(join(tmpdir(), 'pv-cli-'));
});
after(() => rm(base, { recursive: true, force: true }));

test('no arguments and --help print the usage and exit 0', async () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const { code, stdout } = await runCli(args);
    assert.equal(code, 0, args.join(' '));
    assert.match(stdout, /Usage:/);
    for (const command of ['serve', 'export', 'markdown']) assert.match(stdout, new RegExp(`node viewer\\.js ${command} `));
    assert.match(stdout, /--view pyramid\|tree\|both/);
  }
});

test('an unknown command prints the usage on stderr and exits non-zero', async () => {
  const { code, stderr } = await runCli(['frobnicate']);
  assert.equal(code, 2);
  assert.match(stderr, /Unknown command "frobnicate"/);
  assert.match(stderr, /Usage:/);
});

test('export on the fixture writes the pages, prints a link report and exits 0', async () => {
  const out = join(base, 'cli-export');
  const { code, stdout, stderr } = await runCli(['export', fixture('pyramid'), out, '--view', 'both', '--skin', 'plain']);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Link report/);
  assert.match(stdout, /6 rewritten/);
  assert.ok((await listFiles(out)).includes('_tree/L3-modules/storage.html'));
  assert.deepEqual((await walkExport(out, { allowUnresolved: [/outside\.md$/, /missing\.md$/] })).problems, []);
});

test('export with --depth 2 and --layers works', async () => {
  const out = join(base, 'cli-export-custom');
  const { code, stderr } = await runCli(['export', fixture('custom'), out, '--view', 'tree', '--depth', '2', '--layers', fixture('custom', 'pyramid.json')]);
  assert.equal(code, 0, stderr);
  assert.ok((await listFiles(out)).includes('start.html'));
});

test('export of a folder without pyramid files says "no layers found" on stderr and exits 1', async () => {
  const root = join(base, 'empty-docs');
  await mkdir(root);
  const out = join(base, 'empty-out');
  const { code, stderr } = await runCli(['export', root, out]);
  assert.equal(code, 1);
  assert.match(stderr, /no layers found/i);
  assert.match(stderr, /pyramid\.json/);
  await assert.rejects(stat(out), { code: 'ENOENT' });
});

test('export of a missing docs folder exits 1 with a message and no stack trace', async () => {
  const { code, stderr } = await runCli(['export', join(base, 'nope'), join(base, 'o')]);
  assert.equal(code, 1);
  assert.match(stderr, /Docs folder not found/);
  assert.ok(!/\n\s+at /.test(stderr), 'no stack trace');
});

test('unknown --view, --skin and --depth values exit non-zero and list the valid values', async () => {
  const out = join(base, 'bad');
  let r = await runCli(['export', fixture('pyramid'), out, '--view', 'grid']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown value "grid" for --view\. Valid values: pyramid, tree, both/);
  r = await runCli(['export', fixture('pyramid'), out, '--skin', 'gold']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown value "gold" for --skin\. Valid values: light, metal \(plain is also accepted\)\./);
  r = await runCli(['serve', fixture('pyramid'), '--skin', 'gold']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Valid values: light, metal/);
  r = await runCli(['export', fixture('pyramid'), out, '--depth', '4']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Valid values: 2, 3/);
  r = await runCli(['serve', fixture('pyramid'), '--port', 'abc']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--port/);
  await assert.rejects(stat(out), { code: 'ENOENT' });
});

test('unknown options, missing option values and wrong argument counts exit 2', async () => {
  for (const args of [
    ['export', fixture('pyramid'), join(base, 'o'), '--bogus'],
    ['export', fixture('pyramid'), join(base, 'o'), '--view'],
    ['export', fixture('pyramid')],
    ['serve'],
    ['markdown', fixture('pyramid')],
    ['markdown', fixture('pyramid'), join(base, 'o.md'), 'extra'],
    ['export', fixture('pyramid'), join(base, 'o'), '--decisions']
  ]) {
    const { code, stderr } = await runCli(args);
    assert.equal(code, 2, args.join(' '));
    assert.match(stderr, /Usage:/, args.join(' '));
  }
});

test('a layers file that cannot be read exits 1 with a clear message', async () => {
  const { code, stderr } = await runCli(['export', fixture('pyramid'), join(base, 'o2'), '--layers', join(base, 'missing.json')]);
  assert.equal(code, 1);
  assert.match(stderr, /Cannot read the layers file/);
});

test('markdown on the fixture writes the file; a second run refuses; --force overwrites', async () => {
  const file = join(base, 'cli.md');
  let r = await runCli(['markdown', fixture('pyramid'), file, '--decisions', '--toc']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Link report/, 'the link report goes to stderr');
  const first = await readFile(file, 'utf8');
  assert.match(first, /Table of contents/);
  assert.match(first, /adr\/003-use-ids\.md/);
  r = await runCli(['markdown', fixture('pyramid'), file]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already exists.*--force/);
  assert.equal(await readFile(file, 'utf8'), first);
  r = await runCli(['markdown', fixture('pyramid'), file, '--force']);
  assert.equal(r.code, 0);
  assert.ok(!(await readFile(file, 'utf8')).includes('Table of contents'));
});

test('markdown on an empty folder says "no layers found" on stderr, writes no file and exits 1', async () => {
  const root = join(base, 'empty-md');
  await mkdir(root);
  const file = join(base, 'nothing.md');
  const { code, stderr } = await runCli(['markdown', root, file]);
  assert.equal(code, 1);
  assert.match(stderr, /no layers found/i);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('serve starts on the fixture, answers a request, and closes cleanly on SIGINT', async () => {
  const child = spawn(process.execPath, [viewerFile, 'serve', fixture('pyramid'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const m = /at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout);
      if (m) resolve(m[1]);
    });
    child.on('error', reject);
    child.on('exit', () => reject(new Error(`serve exited early: ${stdout}`)));
    setTimeout(() => reject(new Error('serve did not start')), 10000);
  });
  const status = await new Promise((resolve, reject) => get(url, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(status, 200);
  child.removeAllListeners('exit');
  const exited = once(child, 'exit');
  child.kill('SIGINT');
  const [code] = await exited;
  assert.equal(code, 0);
});

test('serve on a busy port exits non-zero with a clear message', async () => {
  const first = spawn(process.execPath, [viewerFile, 'serve', fixture('pyramid'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  const port = await new Promise((resolve, reject) => {
    first.stdout.on('data', (c) => {
      stdout += c;
      const m = /127\.0\.0\.1:(\d+)/.exec(stdout);
      if (m) resolve(Number(m[1]));
    });
    first.on('error', reject);
  });
  try {
    const { code, stderr } = await runCli(['serve', fixture('pyramid'), '--port', String(port)]);
    assert.notEqual(code, 0);
    assert.match(stderr, /already in use/);
  } finally {
    first.kill('SIGINT');
    await once(first, 'exit');
  }
});

test('the Node version check passes at and above the floor and explains itself below it', () => {
  assert.equal(checkNodeVersion('20.11.0', '20.11'), null);
  assert.equal(checkNodeVersion('20.11.1', '20.11'), null);
  assert.equal(checkNodeVersion('24.12.0', '20.11'), null);
  assert.equal(checkNodeVersion('21.0.0', '20.11'), null);
  for (const old of ['20.10.9', '18.19.0', '16.19.1', '14.21.3', '8.0.0']) {
    const message = checkNodeVersion(old, '20.11');
    assert.match(message, new RegExp(`Node ${old.replace(/\./g, '\\.')}`));
    assert.match(message, /Node 20\.11 or newer/);
  }
  assert.match(MIN_NODE_VERSION, /^\d+\.\d+$/);
  assert.equal(checkNodeVersion(process.versions.node, MIN_NODE_VERSION), null, 'the running Node meets the floor');
});

test('package.json states the Node floor in engines, matching the guard constant', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, `>=${MIN_NODE_VERSION}`);
});

test('the guard is the first import of viewer.js', async () => {
  const text = await readFile(viewerFile, 'utf8');
  const firstImport = /^import .*$/m.exec(text)[0];
  assert.match(firstImport, /node-guard\.js/);
});

// Review fixes: E5 (argument handling).

test('E5: --help as the value of another option is not taken as a help request', async () => {
  const r = await runCli(['serve', fixture('pyramid'), '--layers', '--help']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Error:/);
});

test('E5: --help after a command prints the usage and exits 0', async () => {
  const r = await runCli(['export', '--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage:/);
});

test('E5: a repeated option is refused', async () => {
  const r = await runCli(['export', fixture('pyramid'), join(base, 'rep'), '--view', 'tree', '--view', 'pyramid']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--view.*more than once/);
});

test('S2: --allow-host may be repeated and is listed in the usage', async () => {
  const usage = await runCli(['--help']);
  assert.match(usage.stdout, /--allow-host/);
  const r = await runCli(['serve', fixture('pyramid'), '--port', '99999', '--allow-host', 'a.test', '--allow-host', 'b.test']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Invalid value "99999" for --port/);
});

test('--skin plain is accepted as another name for light and writes the same export', async () => {
  const a = join(base, 'skin-plain');
  const b = join(base, 'skin-light');
  assert.equal((await runCli(['export', fixture('pyramid'), a, '--skin', 'plain'])).code, 0);
  assert.equal((await runCli(['export', fixture('pyramid'), b, '--skin', 'light'])).code, 0);
  const files = await listFiles(a);
  assert.deepEqual(files, await listFiles(b));
  for (const file of files) assert.equal(await readFile(join(a, file), 'utf8'), await readFile(join(b, file), 'utf8'), file);
});

test('--tokens: a missing file, a folder and a file of 256 KB are usage errors (exit 2); a good file is accepted by export', async () => {
  const out = join(base, 'tokens-out');
  let r = await runCli(['export', fixture('pyramid'), out, '--tokens', join(base, 'missing.css')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--tokens: the file ".*missing\.css" does not exist\./);
  r = await runCli(['serve', fixture('pyramid'), '--tokens', base]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /is not a regular file/);
  const big = join(base, 'big.css');
  await writeFile(big, 'a'.repeat(262144));
  r = await runCli(['export', fixture('pyramid'), out, '--tokens', big]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /larger than 256 KB/);
  await assert.rejects(stat(out), { code: 'ENOENT' });
  const good = join(base, 'good.css');
  await writeFile(good, ':root { --pv-bg: #fdf6e3; }\n');
  r = await runCli(['export', fixture('pyramid'), out, '--tokens', good]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok((await listFiles(out)).includes('skins/custom.css'));
});

test('--tokens given twice is an error, and the help names light, plain and --tokens', async () => {
  const r = await runCli(['export', fixture('pyramid'), join(base, 'twice-tokens'), '--tokens', 'a.css', '--tokens', 'b.css']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--tokens was given more than once/);
  const h = await runCli(['--help']);
  assert.match(h.stdout, /--skin light\|metal/);
  assert.match(h.stdout, /"plain" is accepted as another name for light/);
  assert.match(h.stdout, /--tokens file\.css/);
});

test('--watch: accepted by serve (listed in the help), an error for export', async () => {
  const h = await runCli(['--help']);
  assert.match(h.stdout, /serve <docs>.*--watch/);
  const r = await runCli(['export', fixture('pyramid'), join(base, 'watch-out'), '--watch']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--watch works only with serve\./);
  const m = await runCli(['markdown', fixture('pyramid'), join(base, 'w.md'), '--watch']);
  assert.equal(m.code, 2);
});
