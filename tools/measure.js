// Performance measurement, AC 12.
// Not part of the test suite: it lives in tools/ and is not named *.test.js, so 'node --test' ignores it.
// Usage: node tools/measure.js [--files N] [--runs N]
// It generates an invented docs tree in a temporary folder, starts the server on a free port,
// and prints median and maximum request times in milliseconds for cold and warm requests.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { startServer } from '../viewer.js';

const { values } = parseArgs({ options: { files: { type: 'string', default: '160' }, runs: { type: 'string', default: '20' } } });
const FILES = Number(values.files);
const RUNS = Number(values.runs);

/** Build one invented document of roughly the requested size. */
function makeDoc(title, sections, paragraphsPerSection) {
  const out = [`# ${title}`, '', 'An invented document used only to measure speed.', ''];
  for (let s = 1; s <= sections; s++) {
    out.push(`## Section ${s} of ${title}`, '');
    for (let p = 1; p <= paragraphsPerSection; p++) {
      out.push(`Paragraph ${p} describes how the harbour lights, the tide table and the ferry timetable fit together in section ${s}. It has *emphasis*, \`inline code\` and a [link](#section-${s}-of-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}).`, '');
    }
    out.push(`### Detail ${s}.1`, '', 'A short detail paragraph.', '', `### Detail ${s}.2`, '', 'Another short detail paragraph.', '');
  }
  return out.join('\n');
}

async function generate(root, files) {
  const layers = [['L3-modules', 0.45], ['L4-operations', 0.45]];
  let count = 0;
  await writeFile(join(root, 'L1-vision.md'), makeDoc('Vision', 4, 2));
  await writeFile(join(root, 'L2-architecture.md'), makeDoc('Architecture', 8, 3));
  count += 2;
  for (const [folder, share] of layers) {
    await mkdir(join(root, folder), { recursive: true });
    const n = Math.floor(files * share);
    for (let i = 0; i < n; i++) {
      await writeFile(join(root, folder, i === 0 ? 'index.md' : `doc-${String(i).padStart(3, '0')}.md`), makeDoc(`${folder} document ${i}`, 4 + (i % 4), 2));
      count++;
    }
  }
  await mkdir(join(root, 'adr'), { recursive: true });
  while (count < files) {
    await writeFile(join(root, 'adr', `${String(count).padStart(3, '0')}-decision.md`), makeDoc(`Decision ${count}`, 1, 2));
    count++;
  }
  // One large page of about 130 KB.
  let big = 1;
  while (makeDoc('Large', big, 4).length < 130 * 1024) big++;
  await writeFile(join(root, 'L3-modules', 'large.md'), makeDoc('Large', big, 4));
  return count + 1;
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function time(url, runs) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    const res = await fetch(url);
    await res.arrayBuffer();
    if (res.status !== 200) throw new Error(`${url} answered ${res.status}`);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return times;
}

const root = await mkdtemp(join(tmpdir(), 'pv-measure-'));
try {
  const total = await generate(root, FILES);
  const running = await startServer({ root, port: 0, log: { info() {}, warn() {} } });
  const base = `http://127.0.0.1:${running.port}`;
  const targets = [['overview', '/'], ['tree view', '/_tree/'], ['large page', '/L3-modules/large.md']];
  console.log(`Node ${process.versions.node}, ${total} files, ${RUNS} requests per target`);
  console.log('Times in milliseconds. There is no cache, so "warm" only means the operating system file cache and the JIT are warm.');
  for (const [name, path] of targets) {
    const first = (await time(base + path, 1))[0];
    const warm = await time(base + path, RUNS);
    console.log(`${name.padEnd(11)} first ${first.toFixed(1).padStart(7)}   warm median ${median(warm).toFixed(1).padStart(6)}   warm max ${Math.max(...warm).toFixed(1).padStart(6)}`);
  }
  await running.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
