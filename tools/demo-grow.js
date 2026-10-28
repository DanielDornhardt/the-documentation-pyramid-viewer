#!/usr/bin/env node
// Grows a documentation pyramid in a folder, for recording a demo of `serve --watch`.
// It starts with a few sections already in place, then adds the missing sections one at a time in random order
// across all layers, so bricks arrive in different layers and the others glide to make room.
//
// Usage: node tools/demo-grow.js <source-docs> <target-folder> [--start "Title,Title,..."] [--seed N] [--lead SECONDS] [--gap SECONDS]
//   --start  titles of the `##` sections that are there from the beginning (default: the first section of each layer)
//   --seed   number for the random order, so a run can be repeated (default 1)
//   --lead   seconds to wait after the start state is written, before the first addition (default 3)
//   --gap    seconds between two additions (default 0.7)
// Start the viewer on the target folder first, or just after this script has written the start state:
//   node viewer.js serve <target-folder> --watch --skin metal --density compact
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { start: { type: 'string' }, seed: { type: 'string', default: '1' }, lead: { type: 'string', default: '3' }, gap: { type: 'string', default: '0.7' } }
});
const [source, target] = positionals;
if (!source || !target) {
  process.stderr.write('Usage: node tools/demo-grow.js <source-docs> <target-folder> [--start "Title,Title,..."] [--seed N] [--lead SECONDS] [--gap SECONDS]\n');
  process.exit(2);
}
const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const titleOf = (section) => /^## (.+)$/m.exec(section)?.[1].trim();

// A small seeded random number generator (mulberry32), so that a recording can be repeated.
let state = Number(values.seed) >>> 0;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const layers = ['L2-architecture.md', 'L3-modules.md', 'L4-operations.md'].map((file) => {
  const parts = readFileSync(join(source, file), 'utf8').split(/^(?=## )/m);
  return { file, head: parts[0], sections: parts.slice(1), shown: new Set() };
});
const wanted = values.start ? values.start.split(',').map((t) => t.trim()) : null;
for (const layer of layers) {
  layer.sections.forEach((section, i) => {
    if (wanted ? wanted.includes(titleOf(section)) : i === 0) layer.shown.add(i);
  });
}
const render = (layer) => layer.head + layer.sections.filter((_, i) => layer.shown.has(i)).join('');

mkdirSync(target, { recursive: true });
for (const name of readdirSync(target)) rmSync(join(target, name), { recursive: true, force: true });
writeFileSync(join(target, 'L1-vision.md'), readFileSync(join(source, 'L1-vision.md'), 'utf8'));
for (const layer of layers) writeFileSync(join(target, layer.file), render(layer));
console.log(`start state written ${Date.now()}`);

const pending = layers.flatMap((layer) => layer.sections.map((_, i) => ({ layer, i }))).filter(({ layer, i }) => !layer.shown.has(i));
await wait(Number(values.lead));
while (pending.length > 0) {
  const { layer, i } = pending.splice(Math.floor(random() * pending.length), 1)[0];
  layer.shown.add(i);
  writeFileSync(join(target, layer.file), render(layer));
  console.log(`added ${Date.now()} ${layer.file} ${titleOf(layer.sections[i])}`);
  await wait(Number(values.gap));
}
await wait(3);
console.log(`done ${Date.now()}`);
