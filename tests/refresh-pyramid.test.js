// Tests for tools/refresh-pyramid.js, part.
// The CLI is spawned on temporary copies of tests/fixtures/refresh/clean; variants are built inside the tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, copyTree, assertLinearGrowth, secondsSince } from './helpers.js';
import { slugify as viewerSlugify, extractHeadings, analyzeForExport, stripFrontMatter, normalizeSource } from '../viewer.js';
import { slugify, plainText, scanDocument, bylineAfter } from '../tools/refresh-pyramid.js';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'refresh-pyramid.js');
const sections = (count) => Array.from({ length: count }, (_, i) => `line ${i}`).join('\n');

/** A temporary copy of the clean fixture; `changes` maps a relative path to new text, or to null to delete it. */
async function docsCopy(t, changes = {}) {
  const base = await mkdtemp(join(tmpdir(), 'refresh-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const docs = join(base, 'docs');
  await copyTree(fixture('refresh', 'clean'), docs);
  for (const [path, text] of Object.entries(changes)) {
    if (text === null) await rm(join(docs, path), { recursive: true, force: true });
    else {
      await mkdir(dirname(join(docs, path)), { recursive: true });
      await writeFile(join(docs, path), text);
    }
  }
  return docs;
}

const runIn = (cwd, ...args) => {
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', cwd });
  return { code: result.status, out: result.stdout, err: result.stderr };
};
const run = (...args) => runIn(undefined, ...args);
const isRoot = () => process.getuid?.() === 0;
const indexOf = (docs) => readFile(join(docs, 'index.md'), 'utf8');
/** Asserts the output has a line for this code that contains every given part, and ends with a fix hint. */
function assertFinding(out, code, ...parts) {
  const line = out.split('\n').find((l) => l.includes(` ${code} `) && parts.every((part) => l.includes(part)));
  assert.ok(line, `no ${code} line with ${JSON.stringify(parts)} in:\n${out}`);
  assert.match(line, /\(fix: .+\)$/, `${code} has no fix hint: ${line}`);
}
/** Makes the index current after a document change, so only the findings under test remain. */
const refreshed = (docs) => assert.equal(run(docs).code === 2, false);

test('the tool passes node --check', () => {
  const result = spawnSync(process.execPath, ['--check', TOOL], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('write mode regenerates stale blocks, is idempotent and leaves no temp files', async (t) => {
  const docs = await docsCopy(t, { 'L4-operations.md': '# Ops\n\n## Backups\n\nBackups run nightly.\n\n## Monitoring\n\nWe watch the disk.\n' });
  const first = run(docs);
  assert.equal(first.code, 0, first.out);
  const written = await indexOf(docs);
  assert.match(written, /\| Monitoring \| `L4-operations.md#monitoring` \(line 7\) \| We watch the disk\. \|/);
  assert.match(written, /The glossary lives in `L1-vision.md#vocabulary`/); // text outside the markers is untouched
  const second = run(docs);
  assert.equal(second.code, 0);
  assert.equal(await indexOf(docs), written);
  assert.doesNotMatch(second.out, /wrote index.md/);
  assert.deepEqual((await readdir(docs)).filter((name) => name.includes('.tmp')), []);
});

test('dry run writes nothing, shows the changed blocks and still prints the warnings', async (t) => {
  const docs = await docsCopy(t, { 'L4-operations.md': '# Ops\n\n## Backups\n\n## Monitoring\n\nWe watch the disk.\n' });
  const before = await readFile(join(docs, 'index.md'));
  const result = run(docs, '--dry-run');
  assert.deepEqual(await readFile(join(docs, 'index.md')), before);
  assert.match(result.out, /block L4-operations would change:/);
  assert.match(result.out, /\+ \| Monitoring \|/);
  assert.doesNotMatch(result.out, /^\s*\[|\] *$/m); // each diff line is printed once, with no array dump
  assertFinding(result.out, 'W2', 'L4-operations.md:3', 'Backups');
  assertFinding(result.out, 'S1');
  assert.equal(result.code, 0); // warnings and a stale index do not fail a dry run
});

test('check exit codes: clean 0, stale 1, errors 1, warnings only 0, usage 2', async (t) => {
  const clean = await docsCopy(t);
  assert.equal(run(clean, '--check').code, 0);

  const stale = await docsCopy(t, { 'L4-operations.md': '# Ops\n\n## Backups\n\nBackups run nightly.\n' });
  const staleResult = run(stale, '--check');
  assert.equal(staleResult.code, 1);
  assertFinding(staleResult.out, 'S1', 'L4-operations');
  assert.match(await indexOf(stale), /Releases/); // check wrote nothing

  const errors = await docsCopy(t, { 'L3-modules/index.md': '# Folder index\n' });
  assert.equal(run(errors, '--check').code, 1);

  const warnings = await docsCopy(t, { 'L4-operations.md': '# Ops\n\n## Backups\n\n## Releases\n\nA release is a tag.\n' });
  refreshed(warnings);
  const warned = run(warnings, '--check');
  assert.equal(warned.code, 0);
  assertFinding(warned.out, 'W2');

  assert.equal(run(clean, '--bogus').code, 2);
});

test('E1 a folder index inside a layer folder', async (t) => {
  const docs = await docsCopy(t, { 'L3-modules/index.md': '# Folder index\n' });
  const { out } = run(docs, '--check');
  assertFinding(out, 'E1', 'L3-modules/index.md', 'L3-modules.md', 'delete');
  assert.doesNotMatch(out, /Folder index/); // it is not listed as a module
});

test('E2 the same module title twice in one layer, whatever the places', async (t) => {
  const docs = await docsCopy(t, {
    'L3-modules.md': '# L3\n\n## Loan desk\n\nOne.\n\n## Loan  Desk!\n\nTwo.\n',
    'L3-modules/loan-desk.md': '## Loan desk\n\nThree.\n',
    'L3-modules/loan-desk-copy.md': '## Loan desk\n\nFour.\n',
  });
  const { out } = run(docs, '--check');
  assert.equal(out.split('\n').filter((line) => line.includes(' E2 ')).length, 3);
  assertFinding(out, 'E2', 'appears twice', 'also at L3-modules.md:3', 'merge');
});

test('E3 broken markers: begin without end, end without begin, duplicate id, end before begin', async (t) => {
  const marker = (kind, id) => `<!-- pyramid:${kind} ${id} -->`;
  const cases = {
    'begin without end': [marker('begin', 'L1-vision')],
    'end without begin': [marker('end', 'L1-vision')],
    'duplicate id': [marker('begin', 'L1-vision'), marker('end', 'L1-vision'), marker('begin', 'L1-vision'), marker('end', 'L1-vision')],
    'end before begin': [marker('end', 'L1-vision'), marker('begin', 'L1-vision')],
    'duplicate end': [marker('begin', 'L1-vision'), marker('end', 'L1-vision'), marker('end', 'L1-vision')],
  };
  for (const [name, lines] of Object.entries(cases)) {
    const docs = await docsCopy(t, { 'index.md': `# Index\n\n${lines.join('\n\n')}\n` });
    const before = await indexOf(docs);
    const result = run(docs);
    assertFinding(result.out, 'E3', 'index.md:');
    assert.equal(result.code, 1, name);
    assert.equal(await indexOf(docs), before, `${name}: nothing is written`);
  }
});

test('E3 a block inside another block of a different id is reported and nothing is written', async (t) => {
  const marker = (kind, id) => `<!-- pyramid:${kind} ${id} -->`;
  const nested = ['# I', '', marker('begin', 'L1-vision'), marker('begin', 'L2-architecture'), 'old', marker('end', 'L2-architecture'), marker('end', 'L1-vision'), ''].join('\n');
  const overlapping = ['# I', '', marker('begin', 'L1-vision'), marker('begin', 'L2-architecture'), marker('end', 'L1-vision'), marker('end', 'L2-architecture'), ''].join('\n');
  for (const index of [nested, overlapping]) {
    const docs = await docsCopy(t, { 'index.md': index });
    const result = run(docs);
    assertFinding(result.out, 'E3', 'index.md:4', 'block L2-architecture starts inside block L1-vision');
    assert.equal(result.code, 1);
    assert.equal(await indexOf(docs), index);
  }
});

test('E4 a missing root index.md', async (t) => {
  const docs = await docsCopy(t, { 'index.md': null });
  const result = run(docs);
  assertFinding(result.out, 'E4', 'index.md', join(docs, 'index.md'));
  assert.equal(result.code, 1);
});

test('E5 a byline over twice the limit, W3 over the limit, W2 none', async (t) => {
  const docs = await docsCopy(t, {
    'L4-operations.md': `# Ops\n\n## Short\n\n${'a'.repeat(30)}.\n\n## Long\n\n${'b'.repeat(90)}.\n\n## Empty\n\n## Other\n\nx.\n`,
  });
  const { out } = run(docs, '--check', '--max-byline', '40');
  assertFinding(out, 'E5', 'L4-operations.md:7', 'Long', '40');
  const second = await docsCopy(t, { 'L4-operations.md': `# Ops\n\n## Medium\n\n${'c'.repeat(50)}.\n\n## Empty\n\n## Other\n\nx.\n` });
  const result = run(second, '--check', '--max-byline', '40');
  assertFinding(result.out, 'W3', 'L4-operations.md:3', 'Medium');
  assertFinding(result.out, 'W2', 'L4-operations.md:7', 'Empty');
});

test('E6 missing markers: reported in check and dry run, appended with a note in write mode', async (t) => {
  const index = '# Index\n\nHand-written text.\n';
  const docs = await docsCopy(t, { 'index.md': index, 'adr': null });
  for (const flag of ['--check', '--dry-run']) {
    const result = run(docs, flag);
    assertFinding(result.out, 'E6', 'L1-vision');
    assert.match(result.out, /^error E6 /m);
    assertFinding(result.out, 'S1', 'L1-vision'); // the missing block makes the index stale
    assert.equal(result.code, 1, flag); // E6 is an error in both modes
    assert.equal(await indexOf(docs), index);
  }
  const written = run(docs);
  assert.match(written.out, /^note E6 index.md: added the missing block for L1-vision at the end of index.md$/m);
  assert.equal(written.code, 0);
  const text = await indexOf(docs);
  assert.ok(text.startsWith(index));
  assert.equal(text.match(/^## Routing table$/gm).length, 1);
  assert.match(text, /<!-- pyramid:begin L4-operations -->[\s\S]*<!-- pyramid:end L4-operations -->/);
  assert.equal(run(docs, '--check').code, 0);
  // an existing heading is reused
  const withHeading = await docsCopy(t, { 'index.md': '# Index\n\n## Routing table\n\nSee below.\n' });
  run(withHeading);
  assert.equal((await indexOf(withHeading)).match(/^## Routing table$/gm).length, 1);
});

test('E7 an unreadable layer file keeps its block and is reported', async (t) => {
  if (isRoot()) return t.skip('root can read any file');
  const docs = await docsCopy(t);
  const before = await indexOf(docs);
  await writeFile(join(docs, 'L2-architecture.md'), '# Changed\n\n## Brand new\n\nText.\n');
  await chmod(join(docs, 'L2-architecture.md'), 0o000);
  await writeFile(join(docs, 'L4-operations.md'), '# Ops\n\n## Only one\n\nText.\n');
  const result = run(docs);
  assertFinding(result.out, 'E7', 'L2-architecture.md', 'left unchanged');
  assert.equal(result.code, 1);
  const after = await indexOf(docs);
  const block = (text, id) => text.match(new RegExp(`<!-- pyramid:begin ${id} -->[\\s\\S]*?<!-- pyramid:end ${id} -->`))[0];
  assert.equal(block(after, 'L2-architecture'), block(before, 'L2-architecture'));
  assert.match(block(after, 'L4-operations'), /Only one/); // the other layers are still refreshed
});

test('W1 a section over the limit', async (t) => {
  const docs = await docsCopy(t, { 'L4-operations.md': `# Ops\n\n## Big\n\nBig things happen here.\n${sections(110)}\n` });
  const { out } = run(docs, '--check');
  assertFinding(out, 'W1', 'L4-operations.md:3', 'Big', 'L4-operations/', 'never cut detail');
  assert.doesNotMatch(run(docs, '--check', '--max-section-lines', '200').out, / W1 /);
});

test('W4 a sub-folder inside a layer folder', async (t) => {
  const docs = await docsCopy(t, { 'L3-modules/deep/inner.md': '## Inner\n\nText.\n' });
  assertFinding(run(docs, '--check').out, 'W4', 'L3-modules/deep');
});

test('W5 broken-out file shapes: H1 first, text first, no heading, a second module', async (t) => {
  const docs = await docsCopy(t, {
    'L3-modules/h1.md': '# Title\n\nText.\n',
    'L3-modules/text.md': 'Some text first.\n\n## Titled\n\nText.\n',
    'L3-modules/none.md': 'Only text.\n',
    'L3-modules/two.md': '## First\n\nText.\n\n## Second\n\nText.\n',
  });
  const out = run(docs, '--check').out;
  const w5 = out.split('\n').filter((line) => line.includes(' W5 '));
  assert.equal(w5.length, 4);
  assert.ok(w5.some((l) => l.includes('L3-modules/h1.md:1') && l.includes('starts with an H1')));
  assert.ok(w5.some((l) => l.includes('L3-modules/text.md:1') && l.includes('before its ## title')));
  assert.ok(w5.some((l) => l.includes('L3-modules/none.md') && l.includes('no heading')));
  assert.ok(w5.some((l) => l.includes('L3-modules/two.md:5') && l.includes('"Second"')));
  assert.ok(w5.every((l) => /\(fix: .+\)$/.test(l)));
  assert.doesNotMatch(out, /W5 .*overdue-notices/);
});

test('S1 the index is stale, and the info line counts a layer', async (t) => {
  const docs = await docsCopy(t, { 'L3-modules/extra.md': '## Extra\n\nAn extra module.\n' });
  const { out, code } = run(docs, '--check');
  assertFinding(out, 'S1', 'L3-modules');
  assert.equal(code, 1);
  assert.match(out, /^info L3-modules: 3 sections, 2 broken out$/m);
});

test('the adr folder gets a block with file pointers', async (t) => {
  const docs = await docsCopy(t, { 'adr/0003-plain-text.md': '# 3. Keep plain text\n\nDecisions are plain markdown.\n' });
  run(docs);
  const text = await indexOf(docs);
  assert.match(text, /\| 3\. Keep plain text \| `adr\/0003-plain-text.md` \| Decisions are plain markdown\. \|/);
  assert.doesNotMatch(run(docs, '--check').out, / W5 /); // decision records keep their H1
});

test('a layer with nothing to list says so; pipes in a cell are escaped', async (t) => {
  const docs = await docsCopy(t, { 'L1-vision.md': '# Vision\n', 'L4-operations.md': '# Ops\n\n## Pipes | here\n\nA | B is the pair.\n' });
  run(docs);
  const text = await indexOf(docs);
  assert.match(text, /<!-- pyramid:begin L1-vision -->\n\n_No modules yet\._\n\n<!-- pyramid:end L1-vision -->/);
  assert.match(text, /\| Pipes \\\| here \| .* \| A \\\| B is the pair\. \|/);
});

test('fenced code with a ## line is ignored, front matter is skipped', async (t) => {
  const source = '---\ntitle: x\n## not a heading\n---\n# Ops\n\n## Real\n\nReal text.\n\n```md\n## fake\n```\n\n~~~\n## fake two\n~~~\n';
  const doc = scanDocument(source);
  assert.deepEqual(doc.headings.map((h) => [h.line, h.level, h.title]), [[5, 1, 'Ops'], [7, 2, 'Real']]);
  const docs = await docsCopy(t, { 'L4-operations.md': source });
  run(docs);
  const text = await indexOf(docs);
  assert.match(text, /`L4-operations.md#real` \(line 7\)/);
  assert.doesNotMatch(text, /fake/);
});

test('a CRLF index.md and its BOM are preserved', async (t) => {
  const docs = await docsCopy(t);
  const crlf = '﻿' + (await indexOf(docs)).replace(/\n/g, '\r\n').replace('Backups', 'Old name');
  await writeFile(join(docs, 'index.md'), crlf);
  run(docs);
  const text = await indexOf(docs);
  assert.ok(text.startsWith('﻿# Lanternfield'));
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF');
  assert.match(text, /\| Backups \| `L4-operations.md#backups` \(line 3\)/);
  const again = run(docs);
  assert.equal(await indexOf(docs), text);
  assert.equal(again.code, 0);
});

test('byline rules', () => {
  const byline = (text) => bylineAfter(scanDocument(text), 0);
  assert.equal(byline('## M\n\nFirst sentence. Second sentence.\n'), 'First sentence.');
  assert.equal(byline('## M\n\nIs it so? Yes.\n'), 'Is it so?');
  assert.equal(byline('## M\n\nNo end of sentence\nacross two lines\n\nNext paragraph.\n'), 'No end of sentence across two lines');
  assert.equal(byline('## M\n\n- a list first\n\nText.\n'), '');
  assert.equal(byline('## M\n\n| a | b |\n'), '');
  assert.equal(byline('## M\n\n> a quote\n'), '');
  assert.equal(byline('## M\n\n```\ncode\n```\n'), '');
  assert.equal(byline('## M\n\n<!-- a note -->\n\nAfter the comment. More.\n'), 'After the comment.');
  assert.equal(byline('## M\n\nSee [the **guide**](x.md) and `code` for *more*. Next.\n'), 'See the guide and code for more.');
  assert.equal(byline('## M\n\n**Purpose.** Explains the thing. More.\n'), 'Explains the thing.');
  assert.equal(byline('## M\n\nIntro text\n- item\n'), 'Intro text');
  assert.equal(byline('## M\n### Sub\n\nBelongs to Sub.\n'), '');
  assert.equal(plainText('A `b_c` and snake_case'), 'A b_c and snake_case');
});

test('slugs and anchors equal the viewer\'s', async () => {
  const cases = ['Hello World', '  Spaced   out  ', 'Rock & Roll!', 'snake_case and kebab-case', 'Version 2.0 (beta)',
    'Überblick für Größe', '日本語 の 見出し', '--edge--', 'Fish &amp; Chips', 'caf&#233; &#xe9;', '!!! ???'];
  for (const text of cases) assert.equal(slugify(text), viewerSlugify(text), text);
  // The tool decodes numeric entities and six common named ones, not the full HTML table, so &copy; is written numerically.
  const source = (await readFile(fixture('pyramid', 'L2-architecture.md'), 'utf8')).replace('&copy;', '&#169;');
  const viewer = extractHeadings(source).map((h) => [h.level, h.slug]);
  const mine = scanDocument(source).headings.filter((h) => h.level <= 4).map((h) => [h.level, h.anchor]);
  assert.deepEqual(mine, viewer);
});

test('symbolic links are ignored, and say nothing', async (t) => {
  const docs = await docsCopy(t);
  const outside = join(dirname(docs), 'outside.md');
  await writeFile(outside, '# Outside\n\n## Secret\n\nNot part of the docs.\n');
  await symlink(outside, join(docs, 'L5-secret.md'));
  await symlink(dirname(docs), join(docs, 'L3-modules', 'loop'));
  const result = run(docs);
  assert.doesNotMatch(result.out, /symbolic|skipped|L5-secret|loop/);
  assert.doesNotMatch(await indexOf(docs), /Secret|L5-secret/);
});

test('usage errors and an unreadable folder give a message, exit code 2 and no stack trace', async (t) => {
  const docs = await docsCopy(t);
  const attempts = [[docs, '--check', '--dry-run'], [docs, '--max-byline', 'abc'], [docs, '--max-byline'], [docs, '--bogus'], [docs, docs], [join(docs, 'missing')]];
  for (const args of attempts) {
    const result = run(...args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.err, /^refresh-pyramid: /);
    assert.doesNotMatch(result.err, /\n\s+at /);
  }
  const help = run('--help');
  assert.equal(help.code, 0);
  assert.match(help.out, /usage: node refresh-pyramid.js/);
});

// ---------------------------------------------------------------- review fixes: scanning, failures, boundaries

test('F3 the file name of an unreadable layer is right for relative docs arguments', async (t) => {
  if (isRoot()) return t.skip('root can read any file');
  const docs = await docsCopy(t);
  await chmod(join(docs, 'L2-architecture.md'), 0o000);
  for (const [cwd, arg] of [[dirname(docs), './docs'], [dirname(docs), 'docs/'], [docs, '.']]) {
    const result = runIn(cwd, arg);
    assert.match(result.out, /^error E7 L2-architecture\.md: could not read L2-architecture/m, `${cwd} ${arg}\n${result.out}`);
  }
});

test('F4 an index.md that cannot be read or written is reported with exit 1 and leaves no temp file', async (t) => {
  if (isRoot()) return t.skip('root can write anywhere');
  const docs = await docsCopy(t, { 'L4-operations.md': '# Ops\n\n## Backups\n\nBackups run nightly.\n' });
  await chmod(docs, 0o555);
  let result;
  try { result = run(docs); } finally { await chmod(docs, 0o755); }
  assertFinding(result.out, 'E7', 'index.md', 'could not read or write index.md');
  assert.match(result.out, /^info L4-operations: /m); // the other findings are still printed
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.err, /\n\s+at /);
  assert.deepEqual((await readdir(docs)).filter((name) => name.includes('.tmp')), []);
  await chmod(join(docs, 'index.md'), 0o000);
  const unreadable = run(docs, '--check');
  assertFinding(unreadable.out, 'E7', 'index.md');
  assert.equal(unreadable.code, 1);
});

/** Headings both the viewer (levels 1 to 4) and the tool find in a source, as [line in the file, slug]. */
function viewerHeadings(source) {
  const hidden = normalizeSource(source).split('\n').length - stripFrontMatter(normalizeSource(source)).split('\n').length;
  return analyzeForExport(source).headings.map((h) => [h.line + 1 + hidden, h.slug]);
}
const toolHeadings = (source) => scanDocument(source).headings.filter((h) => h.level <= 4).map((h) => [h.line, h.anchor]);

test('headings: the tool finds the same slugs and lines as the viewer (fences, comments, indentation, front matter)', () => {
  const cases = {
    'longer closing fence': '````\n## a\n```\n## b\n````\n## c\n',
    'a tilde fence is not closed by backticks': '~~~\n## a\n```\n## b\n~~~\n## c\n',
    'a closing fence has no info string': '```\n## a\n``` js\n## b\n```\n## c\n',
    'fence indented three spaces': '   ```\n## a\n   ```\n## b\n',
    'four spaces is no fence': '    ```\n## a\n',
    'an unclosed fence runs to the end': '## a\n```\n## b\n## c\n',
    'backtick in the info string is no fence': '``` a`b\n## a\n',
    'indented headings': ' ## a\n   ## b\n    ## c\n## d\n',
    'empty headings': '##\n## \n#\n## ##\n## x\n',
    'closing sequence': '## a ##\n## b#\n## c \\#\n',
    'comment over several lines': '<!--\n## a\n-->\n## b\n',
    'comment after text': 'text\n<!-- x\n## a\n-->\n## b\n',
    'heading on the line of a comment': '<!-- x --> ## a\n## b\n',
    'unclosed comment': '## a\n<!--\n## b\n',
    'comment between fences': '```\n<!--\n```\n## a\n-->\n',
    'front matter': '---\ntitle: x\n## no\n---\n## a\n',
    'front matter closed by dots': '---\ntitle: x\n## no\n...\n## a\n',
    'a rule followed by a blank line is no front matter': '---\n\n## a\n---\n## b\n',
    'unclosed front matter': '---\n## a\n## b\n',
    'quotes and lists hold no headings': '> ## a\n- ## b\n## c\n',
    'levels 5 and 6 are not counted': '##### a\n###### b\n## c\n## c\n',
    'image alt text is part of the title': '## ![logo](x.png) Title\n',
    'decomposed accent': '## Cafe\u0301\n## Caf\u00e9\n',
    'CRLF and BOM': '\ufeff## a\r\n\r\n```\r\n## b\r\n```\r\n## c\r\n',
  };
  for (const [name, source] of Object.entries(cases)) assert.deepEqual(toolHeadings(source), viewerHeadings(source), name);
});

test('markers inside fenced code or comments are not markers', async (t) => {
  const marker = (kind, id) => `<!-- pyramid:${kind} ${id} -->`;
  const index = ['# I', '', '```', marker('begin', 'L1-vision'), '```', '', '<!--', marker('begin', 'L2-architecture'), '-->', '', marker('begin', 'L3-modules'), marker('end', 'L3-modules'), ''].join('\n');
  const docs = await docsCopy(t, { 'index.md': index });
  const result = run(docs, '--check');
  assert.doesNotMatch(result.out, / E3 /);
  assertFinding(result.out, 'E6', 'L1-vision'); // those two have no real markers
  assertFinding(result.out, 'E6', 'L2-architecture');
});

test('byline rules for comments, thematic breaks and images', () => {
  const byline = (text) => bylineAfter(scanDocument(text), 0);
  assert.equal(byline('## M\n\n<!--\nnote\n-->\n\nAfter. More.\n'), 'After.');
  assert.equal(byline('## M\n<!-- one -->\n<!-- two -->\nText. More.\n'), 'Text.');
  assert.equal(byline('## M\n\n---\n\nText.\n'), '');
  assert.equal(byline('## M\n\n***\n'), '');
  assert.equal(byline('## M\n\nText line\n___\n'), 'Text line');
  assert.equal(byline('## M\n\n![diagram](d.png) Shows the flow. More.\n'), 'Shows the flow.');
  assert.equal(byline('## M\n\n![diagram](d.png)\n'), '');
  assert.equal(byline('## M\n\nSee [the guide][g] and [g]. More.\n'), 'See [the guide][g] and [g].'); // reference links stay as written
  assert.equal(byline('## M\n\n~~~\ncode\n~~~\nText.\n'), '');
  assert.equal(byline('## M\n\nText\n```\ncode\n```\n'), 'Text');
});

test('a paragraph of 200,000 characters gives its byline in linear time', async () => {
  const byline = (n) => bylineAfter(scanDocument(`## M\n\n${'*a _b '.repeat(n)}\n`), 0);
  assert.ok(byline(40000).length <= 2000);
  await assertLinearGrowth((n) => {
    const start = process.hrtime.bigint();
    byline(n);
    return secondsSince(start);
  }, 1000, 40000, { label: 'long paragraph', maxLarge: 160000 });
});

test('a docs folder with an index but no layer warns in every mode; an empty index gets no leading blank line', async (t) => {
  const docs = await docsCopy(t, { 'L1-vision.md': null, 'L2-architecture.md': null, 'L3-modules': null, 'L3-modules.md': null, 'L4-operations.md': null, 'adr': null });
  for (const flag of ['--check', '--dry-run', '']) {
    const result = run(...[docs, flag].filter(Boolean));
    assertFinding(result.out, 'W6', 'no layers found in', docs, '(expected files like L1-vision.md)');
    assert.match(result.out, /^warning W6 /m);
    assert.equal(result.code, 0, flag);
  }
  const empty = await docsCopy(t, { 'index.md': '' });
  run(empty);
  const text = await indexOf(empty);
  assert.ok(text.startsWith('## Routing table\n\n<!-- pyramid:begin L1-vision -->'), JSON.stringify(text.slice(0, 60)));
});

test('write mode prints the warnings too', async (t) => {
  const docs = await docsCopy(t, { 'L4-operations.md': '# Ops\n\n## Backups\n\n## Monitoring\n\nWe watch the disk.\n' });
  const result = run(docs);
  assertFinding(result.out, 'W2', 'L4-operations.md:3', 'Backups');
  assert.match(result.out, /^wrote index.md/m);
  assert.equal(result.code, 0);
});

/** A copy whose L4 file has one module with a byline of `count` characters, and the finding lines about it with the exit code. */
async function bylineOf(t, count) {
  const docs = await docsCopy(t, { 'L4-operations.md': `# Ops\n\n## M\n\n${'a'.repeat(count - 1)}.\n` });
  refreshed(docs);
  const { out, code } = run(docs, '--check');
  return { code, lines: out.split('\n').filter((line) => line.includes('L4-operations.md:3')) };
}

test('E5 is an error with exit 1, W3 only a warning with exit 0', async (t) => {
  const e5 = await bylineOf(t, 201);
  assert.match(e5.lines[0], /^error E5 /);
  assert.equal(e5.code, 1);
  const w3 = await bylineOf(t, 101);
  assert.match(w3.lines[0], /^warning W3 /);
  assert.equal(w3.code, 0);
});

test('limits are inclusive: a byline of exactly the limit and twice the limit, a section of exactly the line limit', async (t) => {
  assert.deepEqual((await bylineOf(t, 100)).lines, []);
  assert.match((await bylineOf(t, 101)).lines[0], / W3 /);
  assert.match((await bylineOf(t, 200)).lines[0], / W3 /);
  assert.match((await bylineOf(t, 201)).lines[0], / E5 /);
  const section = async (lines) => {
    // the heading, the blank line and the byline come first, `sections` adds the rest
    const docs = await docsCopy(t, { 'L4-operations.md': `# Ops\n\n## Big\n\nBig things.\n${sections(lines - 3)}\n` });
    return run(docs, '--check', '--max-section-lines', '10').out.split('\n').filter((line) => line.includes(' W1 L4-operations'));
  };
  assert.deepEqual(await section(10), []);
  assert.equal((await section(11)).length, 1);
});

test('layers are ordered by number (L2 before L10, adr last); hidden files, symbolic names and adr/README.md are not listed', async (t) => {
  const docs = await docsCopy(t, {
    'index.md': '# I\n',
    'L10-extra.md': '# X\n\n## Ten\n\nTen is here.\n',
    'L3-modules/.draft.md': '## Draft\n\nA hidden file.\n',
    '.L5-hidden.md': '# H\n\n## Hidden layer\n\nHidden.\n',
    'adr/README.md': '# Readme\n\nHow the records work.\n',
  });
  run(docs);
  const text = await indexOf(docs);
  assert.deepEqual([...text.matchAll(/pyramid:begin (\S+)/g)].map((m) => m[1]), ['L1-vision', 'L2-architecture', 'L3-modules', 'L4-operations', 'L10-extra', 'adr']);
  assert.doesNotMatch(text, /Draft|Hidden|Readme|README/);
});

test('with no argument the folder is ./docs of the working directory', async (t) => {
  const docs = await docsCopy(t, { 'L4-operations.md': '# Ops\n\n## Backups\n\nBackups run nightly.\n' });
  const result = runIn(dirname(docs));
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(await indexOf(docs), /\| Backups \|/);
});

test('a BOM at the start of a layer file is ignored, and a decomposed accent gets the viewer\'s slug', async (t) => {
  const docs = await docsCopy(t, { 'L4-operations.md': '\ufeff# Ops\n\n## Cafe\u0301 menu\n\nCoffee is served.\n' });
  run(docs);
  const text = await indexOf(docs);
  assert.ok(text.includes(`\`L4-operations.md#${viewerSlugify('Cafe\u0301 menu')}\` (line 3)`), text);
  assert.ok(text.includes('#café-menu'));
});
