// The dialog script run against a very small fake document:
// the guards that are hard to see otherwise (cache, reduced motion, focus return).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptFile = fileURLToPath(new URL('../assets/pv-dialog.js', import.meta.url));

class El {
  constructor(attrs = {}) {
    this.attrs = { ...attrs };
    this.listeners = {};
    this.isConnected = true;
    this.focused = 0;
    this.hidden = false;
    this.scrollTop = 0;
    this.text = '';
    this.children = [];
  }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  hasAttribute(n) { return n in this.attrs; }
  removeAttribute(n) { delete this.attrs[n]; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener() {}
  fire(t, e = {}) { (this.listeners[t] || []).forEach((f) => f({ target: this, ...e })); }
  focus() { this.focused += 1; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  replaceChildren(...c) { this.children = c; this.text = c.map((x) => x.html || '').join(''); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 }; }
  closest() { return null; }
  scrollTo() {}
  set textContent(v) { this.text = v; }
  get textContent() { return this.text; }
  style = { setProperty() {} };
}

function setup({ reduced = false } = {}) {
  const pending = [];
  let version = 1;
  const dialog = new El({ 'data-content': '/_content', 'data-loading': 'Loading', 'data-error': 'Error' });
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.fire('close'); };
  const els = { 'pv-dialog': dialog, 'pv-dialog-body': new El(), 'pv-dialog-toc': new El(), 'pv-dialog-title': new El(), 'pv-dialog-back': new El(), 'pv-dialog-close': new El() };
  const brick = new El({ 'data-pv-doc': 'a.md', href: '/a.md' });
  const doc = new El();
  doc.baseURI = 'http://127.0.0.1:1/';
  doc.getElementById = (id) => els[id] || null;
  doc.querySelectorAll = (sel) => (sel === 'a[data-pv-doc]' ? doc.bricks : []);
  doc.bricks = [brick];
  doc.createElement = () => {
    const t = { content: null };
    Object.defineProperty(t, 'innerHTML', { set(v) { t.content = { html: v, cloneNode: () => ({ html: v }) }; } });
    return t;
  };
  const sandbox = {
    URL,
    document: undefined,
    fetch: async () => { const v = version; return { ok: true, status: 200, text: async () => `text ${v}` }; },
    matchMedia: () => ({ matches: reduced }),
    setTimeout: (f) => { pending.push(f); return pending.length; },
    clearTimeout() {},
    innerWidth: 1000,
    innerHeight: 800,
    location: { origin: 'http://127.0.0.1:1' }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(scriptFile, 'utf8'), sandbox, { filename: 'pv-dialog.js' });
  sandbox.pvDialogLogic.init(doc);
  return { doc, dialog, els, brick, bump: () => { version += 1; }, pending, sandbox };
}

const tick = () => new Promise((r) => setImmediate(r));
const click = (doc, a) => doc.fire('click', { target: { closest: () => a }, button: 0, preventDefault() {} });

test('a refresh message clears the cache also while the dialog is closed', async () => {
  const t = setup();
  click(t.doc, t.brick);
  await tick();
  assert.match(t.els['pv-dialog-body'].text, /text 1/);
  t.els['pv-dialog-close'].fire('click');
  t.bump();
  t.doc.fire('pv:refresh', { detail: { paths: ['a.md'] } });
  click(t.doc, t.brick);
  await tick();
  assert.match(t.els['pv-dialog-body'].text, /text 2/);
});

test('with reduced motion a pointer close happens at once', () => {
  const t = setup({ reduced: true });
  click(t.doc, t.brick);
  t.els['pv-dialog-close'].fire('click');
  assert.equal(t.dialog.open, false);
  assert.equal(t.dialog.hasAttribute('data-closing'), false);
});

test('without reduced motion a pointer close waits for the animation', () => {
  const t = setup({ reduced: false });
  click(t.doc, t.brick);
  t.els['pv-dialog-close'].fire('click');
  assert.equal(t.dialog.open, true);
  assert.equal(t.dialog.hasAttribute('data-closing'), true);
});

test('closing returns focus to the brick, also to its successor after a live update', () => {
  const t = setup({ reduced: true });
  click(t.doc, t.brick);
  t.els['pv-dialog-close'].fire('click');
  assert.equal(t.brick.focused, 1);

  click(t.doc, t.brick);
  const successor = new El({ 'data-pv-doc': 'a.md', href: '/a.md' });
  t.brick.isConnected = false;
  t.doc.bricks = [new El({ 'data-pv-doc': 'b.md' }), successor];
  t.els['pv-dialog-close'].fire('click');
  assert.equal(successor.focused, 1);
  assert.equal(t.brick.focused, 1);
});
