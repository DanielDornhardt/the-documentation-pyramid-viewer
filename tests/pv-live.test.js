// The live script of serve --watch: the parts that run without a browser.
// The script is loaded into a bare context (no document), like the dialog script in the dialog tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptFile = fileURLToPath(new URL('../assets/pv-live.js', import.meta.url));

function load() {
  const sandbox = { URL, document: undefined };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(scriptFile, 'utf8'), sandbox, { filename: 'pv-live.js' });
  assert.ok(sandbox.pvLiveLogic, 'the script exposes its logic');
  return sandbox.pvLiveLogic;
}

const L = load();
// Results come from another context: compare through JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('keyOf: a file brick and a heading brick have different, stable keys', () => {
  assert.equal(L.keyOf('L2-architecture.md', 'api'), 'L2-architecture.md#api');
  assert.equal(L.keyOf('L1-vision.md', ''), 'L1-vision.md#');
  assert.equal(L.keyOf('L1-vision.md', undefined), 'L1-vision.md#');
});

test('uniqueKeys: a repeated key gets a counter, the first keeps its key', () => {
  const out = L.uniqueKeys([{ key: 'a#' }, { key: 'b#' }, { key: 'a#' }, { key: 'a#' }]);
  assert.deepEqual(plain(out.map((e) => e.key)), ['a#', 'b#', 'a#~1', 'a#~2']);
});

test('diffBricks: added, removed, moved and unchanged bricks', () => {
  const oldList = [
    { key: 'a#', left: 10, top: 10 },
    { key: 'b#', left: 100, top: 10 },
    { key: 'c#', left: 10, top: 80 },
    { key: 'd#', left: 100, top: 80 }
  ];
  const newList = [
    { key: 'a#', left: 10, top: 10 },
    { key: 'n#', left: 100, top: 10 },
    { key: 'c#', left: 10.5, top: 80.5 }, // within one pixel: not moved
    { key: 'd#', left: 140, top: 120 } // moved
  ];
  const diff = plain(L.diffBricks(oldList, newList));
  assert.deepEqual(diff.enter, ['n#']);
  assert.deepEqual(diff.leave, ['b#']);
  assert.deepEqual(diff.stay, ['a#', 'c#', 'd#']);
  assert.deepEqual(diff.moved, [{ key: 'd#', dx: -40, dy: -40 }]);
  assert.equal(L.changedCount(diff), 3);
});

test('diffBricks: equal lists give no change at all', () => {
  const list = [{ key: 'a#', left: 1, top: 2 }, { key: 'b#', left: 3, top: 4 }];
  const diff = L.diffBricks(list, list.map((e) => ({ ...e })));
  assert.equal(L.changedCount(diff), 0);
  assert.equal(L.shouldAnimate({ reduced: false, hidden: false }, diff), false);
});

test('tooMany: more than 400 changed bricks is instant', () => {
  const many = Array.from({ length: 401 }, (_, i) => ({ key: `k${i}#`, left: 0, top: 0 }));
  const diff = L.diffBricks([], many);
  assert.equal(L.tooMany(diff), true);
  assert.equal(L.shouldAnimate({ reduced: false, hidden: false }, diff), false);
  assert.equal(L.tooMany(L.diffBricks([], many.slice(0, 400))), false);
});

test('flipDelta and staggerDelay: the glide starts at the old place; the stagger is capped at 100 ms after a 60 ms base', () => {
  assert.deepEqual(plain(L.flipDelta({ left: 100, top: 50 }, { left: 140, top: 20 })), { dx: -40, dy: 30 });
  assert.equal(L.staggerDelay(0), 60);
  assert.equal(L.staggerDelay(2), 100);
  assert.equal(L.staggerDelay(5), 160);
  assert.equal(L.staggerDelay(50), 160);
  assert.equal(L.staggerDelay(3, 10), 90);
  assert.equal(L.staggerDelay(3, 0), 60);
});

test('parseDuration reads ms and s, and falls back for anything else', () => {
  assert.equal(L.parseDuration('200ms', 1), 200);
  assert.equal(L.parseDuration(' 0.3s ', 1), 300);
  assert.equal(L.parseDuration('', 7), 7);
  assert.equal(L.parseDuration('fast', 7), 7);
  assert.equal(L.parseDuration('-5ms', 7), 7);
});

test('parseMessage: a change message is read; anything else is null', () => {
  assert.deepEqual(plain(L.parseMessage('{"n":3,"docs":true,"css":false,"paths":["a.md",5]}')), { docs: true, css: false, many: false, paths: ['a.md'], n: 3 });
  assert.deepEqual(plain(L.parseMessage('{"n":1,"docs":false,"css":true,"many":true}')), { docs: false, css: true, many: true, paths: [], n: 1 });
  for (const bad of ['', 'x', 'null', '3', '[1]']) assert.equal(L.parseMessage(bad), null, bad);
});

test('createScheduler: messages that arrive during a run give exactly one more run, merged', async () => {
  const runs = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const scheduler = L.createScheduler(async (message) => {
    runs.push(plain(message));
    if (runs.length === 1) await gate;
  });
  const first = scheduler.trigger({ docs: true, css: false, many: false, paths: ['a.md'], n: 1 });
  await scheduler.trigger({ docs: true, css: false, many: false, paths: ['b.md'], n: 2 });
  await scheduler.trigger({ docs: false, css: true, many: false, paths: ['b.md', 'c.md'], n: 3 });
  assert.equal(runs.length, 1);
  release();
  await first;
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1], { docs: true, css: true, many: false, paths: ['b.md', 'c.md'], n: 3 });
  assert.equal(scheduler.isRunning(), false);
  await scheduler.trigger({ docs: true, css: false, many: false, paths: [], n: 4 });
  assert.equal(runs.length, 3);
});

test('createScheduler: a failing run does not stop the next one', async () => {
  let calls = 0;
  const scheduler = L.createScheduler(async () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
  });
  await scheduler.trigger({ docs: true, css: false, many: false, paths: [], n: 1 });
  await scheduler.trigger({ docs: true, css: false, many: false, paths: [], n: 2 });
  assert.equal(calls, 2);
});

// A minimal fake DOM: enough for makeGhost and playAnimations.
function fakeElement(tag = 'div') {
  const el = {
    tag,
    attrs: {},
    style: {},
    children: [],
    className: '',
    removed: false,
    animations: [],
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    cloneNode() {
      return fakeElement('li');
    },
    remove() {
      this.removed = true;
    },
    animate(keyframes, options) {
      let finish;
      const finished = new Promise((r) => (finish = r));
      const animation = { keyframes, options, finished, finish };
      this.animations.push(animation);
      return animation;
    }
  };
  return el;
}

const timing = { enter: 200, leave: 160, move: 300, easeOut: 'ease-out', easeInOut: 'ease-in-out' };

test('makeGhost: aria-hidden, inert, the layer look, placed at the old position inside the container', () => {
  const container = fakeElement();
  const doc = { createElement: (t) => fakeElement(t) };
  const ghost = L.makeGhost({ node: fakeElement('li'), left: 130, top: 90, width: 80, height: 40, tint: '2', kind: 'layer' }, { doc, container, origin: { left: 30, top: 50 } });
  assert.equal(ghost.attrs['aria-hidden'], 'true');
  assert.equal(ghost.attrs.inert, '');
  assert.equal(ghost.attrs['data-tint'], '2');
  assert.match(ghost.className, /\bpv-ghost\b/);
  assert.match(ghost.className, /\blayer\b/);
  assert.deepEqual([ghost.style.left, ghost.style.top, ghost.style.width, ghost.style.height], ['100px', '40px', '80px', '40px']);
  assert.equal(container.children[0], ghost);
  const decision = L.makeGhost({ node: fakeElement('li'), left: 0, top: 0, width: 1, height: 1, tint: '4', kind: 'decisions' }, { doc, container, origin: { left: 0, top: 0 } });
  assert.match(decision.className, /\bdecisions\b/);
});

test('playAnimations: enter, leave, move and section animations use only transform and opacity; the ghost goes when its animation ends', async () => {
  const enter = [fakeElement('li'), fakeElement('li'), fakeElement('li')];
  const ghost = fakeElement();
  const moved = fakeElement('li');
  const section = fakeElement('section');
  const { finished, animations } = L.playAnimations({ enter, leave: [ghost], move: [{ el: moved, dx: 12, dy: -30 }], sections: [section] }, timing);
  assert.equal(animations.length, 6);
  for (const el of [...enter, ghost, moved, section]) {
    for (const a of el.animations) {
      for (const frame of a.keyframes) assert.deepEqual(Object.keys(frame).filter((k) => !['opacity', 'transform'].includes(k)), [], 'only opacity and transform');
    }
  }
  assert.deepEqual(enter.map((e) => e.animations[0].options.delay), [60, 80, 100]);
  assert.equal(enter[0].animations[0].options.duration, 200);
  assert.equal(ghost.animations[0].options.duration, 160);
  assert.equal(ghost.animations[0].options.fill, 'forwards');
  assert.equal(moved.animations[0].keyframes[0].transform, 'translate(12px, -30px)');
  assert.equal(moved.animations[0].keyframes[1].transform, 'translate(0px, 0px)');
  assert.equal(moved.animations[0].options.duration, 300);
  assert.equal(ghost.removed, false);
  animations.forEach((a) => a.finish());
  await finished;
  assert.equal(ghost.removed, true);
});

test('shouldAnimate: reduced motion and a hidden tab take no animation, so no animate call is made', () => {
  const diff = L.diffBricks([], [{ key: 'a#', left: 0, top: 0 }]);
  assert.equal(L.shouldAnimate({ reduced: false, hidden: false }, diff), true);
  assert.equal(L.shouldAnimate({ reduced: true, hidden: false }, diff), false);
  assert.equal(L.shouldAnimate({ reduced: false, hidden: true }, diff), false);
});

test('the script does nothing and does not fail on a page without the events address', () => {
  const sandbox = { URL, document: { currentScript: null, querySelector: () => null } };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(scriptFile, 'utf8'), sandbox);
  assert.ok(sandbox.pvLiveLogic);
});

test('pageAffected: a document page reacts to its own file, the tree and folder pages to any file', () => {
  assert.equal(L.pageAffected('/L1-vision.md', { paths: ['L5-notes/beta.md'] }), false);
  assert.equal(L.pageAffected('/L1-vision.md', { paths: ['L1-vision.md'] }), true);
  assert.equal(L.pageAffected('/L3-modules/a%20b.md', { paths: ['L3-modules/a b.md'] }), true);
  assert.equal(L.pageAffected('/L1-vision.md', { many: true, paths: [] }), true);
  assert.equal(L.pageAffected('/L1-vision.md', undefined), true);
  assert.equal(L.pageAffected('/_tree/', { paths: ['x.md'] }), true);
  assert.equal(L.pageAffected('/L3-modules/', { paths: ['x.md'] }), true);
  assert.equal(L.pageAffected('/_tree/', { paths: [] }), false);
});
