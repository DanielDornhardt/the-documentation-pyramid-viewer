// The overview density option: comfortable (the default, no attribute) and compact (data-density on the body).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportHtml, startServer } from '../viewer.js';
import { fixture, runCli } from './helpers.js';

const quiet = { info() {}, warn() {} };
let base;
before(async () => {
  base = await mkdtemp(join(tmpdir(), 'pv-density-'));
});
after(() => rm(base, { recursive: true, force: true }));

test('export: compact density sets data-density on every page, the default sets nothing', async () => {
  await exportHtml({ root: fixture('pyramid'), out: join(base, 'compact'), density: 'compact', log: quiet });
  await exportHtml({ root: fixture('pyramid'), out: join(base, 'default'), log: quiet });
  for (const file of ['index.html', '_tree/index.html', 'L1-vision.html']) {
    assert.match(await readFile(join(base, 'compact', file), 'utf8'), /<body class="view-[a-z]+" data-skin="light" data-density="compact">/, file);
    assert.doesNotMatch(await readFile(join(base, 'default', file), 'utf8'), /data-density/, file);
  }
});

test('serve: compact density sets data-density, the default sets nothing', async () => {
  for (const density of ['compact', undefined]) {
    const running = await startServer({ root: fixture('pyramid'), port: 0, density, log: quiet });
    try {
      const html = await (await fetch(running.url)).text();
      assert.equal(/data-density="compact"/.test(html), density === 'compact');
    } finally {
      await running.close();
    }
  }
});

test('an unknown density is refused by the command line (exit 2) and by the API', async () => {
  const { code, stderr } = await runCli(['export', fixture('pyramid'), join(base, 'bad'), '--density', 'tiny']);
  assert.equal(code, 2);
  assert.match(stderr, /Unknown value "tiny" for --density/);
  await assert.rejects(exportHtml({ root: fixture('pyramid'), out: join(base, 'bad2'), density: 'tiny', log: quiet }), /Unknown density/);
});
