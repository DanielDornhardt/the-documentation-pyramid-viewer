/* Live updates for serve --watch.
   Plain browser JavaScript, a classic deferred script, no dependencies. The server sends a small change message
   (two flags, a counter, relative file names) over server-sent events. This script then
     - reloads the stylesheets of the viewer in place when a style file changed,
     - tells an open dialog to fetch its document again (event pv:refresh),
     - updates the pyramid overview in place: it fetches the page again, swaps the content, and animates the bricks
       that came (grow in), went (fade out in a ghost) or moved (glide to the new place),
     - reloads any other page.
   Animation uses the Web Animations API with transform and opacity only. With reduced motion, a hidden tab or a very
   large change the page is updated at once. No document content travels over the event stream. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;

  const MAX_ANIMATED = 400;
  const MOVE_THRESHOLD = 1;
  const ENTER_DELAY_MS = 60;
  const STAGGER_MS = 20;
  const STAGGER_CAP_MS = 100;

  /** The stable identity of a brick: its document, then "#", then its heading (empty for a file brick). */
  function keyOf(docPath, heading) {
    return String(docPath || '') + '#' + String(heading || '');
  }

  /** Brick entries in document order with keys that are unique: a second brick with the same key gets a counter. */
  function uniqueKeys(entries) {
    const seen = new Map();
    return entries.map((e) => {
      const n = seen.get(e.key) || 0;
      seen.set(e.key, n + 1);
      return n === 0 ? e : Object.assign({}, e, { key: e.key + '~' + n });
    });
  }

  /**
   * Compare two lists of {key, left, top} (document coordinates).
   * enter: keys only in the new list, in new order. leave: keys only in the old list. stay: keys in both.
   * moved: stay entries whose position changed by more than one pixel, with dx and dy = old position minus new position.
   */
  function diffBricks(oldList, newList) {
    const before = new Map(oldList.map((e) => [e.key, e]));
    const after = new Map(newList.map((e) => [e.key, e]));
    const enter = newList.filter((e) => !before.has(e.key)).map((e) => e.key);
    const leave = oldList.filter((e) => !after.has(e.key)).map((e) => e.key);
    const stay = [];
    const moved = [];
    newList.forEach((e) => {
      const was = before.get(e.key);
      if (!was) return;
      stay.push(e.key);
      const dx = was.left - e.left;
      const dy = was.top - e.top;
      if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) moved.push({ key: e.key, dx: dx, dy: dy });
    });
    return { enter: enter, leave: leave, stay: stay, moved: moved };
  }

  /** Number of bricks that would animate. */
  function changedCount(diff) {
    return diff.enter.length + diff.leave.length + diff.moved.length;
  }

  /** True when a change is too large to animate (the page is then updated at once). */
  function tooMany(diff, limit) {
    return changedCount(diff) > (limit === undefined ? MAX_ANIMATED : limit);
  }

  /** Delay of the n-th new brick (counting from 0): a short base delay plus a stagger (step 20 ms unless given) that is capped. */
  function staggerDelay(index, stepMs) {
    return ENTER_DELAY_MS + Math.min(index * (stepMs === undefined ? STAGGER_MS : stepMs), STAGGER_CAP_MS);
  }

  /** The vector that places an element at its old position: it is the start of the glide to (0, 0). */
  function flipDelta(first, last) {
    return { dx: first.left - last.left, dy: first.top - last.top };
  }

  /** Milliseconds from a CSS time such as "200ms" or "0.2s"; the fallback for anything else. */
  function parseDuration(text, fallback) {
    const m = /^\s*(-?\d*\.?\d+)\s*(ms|s)\s*$/.exec(String(text || ''));
    if (!m) return fallback;
    const value = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
    return value >= 0 ? value : fallback;
  }

  /** Read a change message. Returns {docs, css, paths, many, n} or null for anything that is not one. */
  function parseMessage(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return {
      docs: data.docs === true,
      css: data.css === true,
      many: data.many === true,
      paths: Array.isArray(data.paths) ? data.paths.filter((p) => typeof p === 'string') : [],
      n: typeof data.n === 'number' ? data.n : 0
    };
  }

  /** Combine two messages into one that stands for both. */
  /** Whether a change message concerns a document page or tree page at this URL path; other pages are left alone. */
  function pageAffected(pathname, message) {
    if (!message || message.many || !Array.isArray(message.paths)) return true;
    let name = String(pathname || '').replace(/^\/+/, '');
    try {
      name = decodeURIComponent(name);
    } catch (error) {
      /* keep the raw path */
    }
    // The tree view and folder pages list many documents: any change may matter to them.
    if (name === '' || name.slice(-1) === '/' || name.indexOf('_tree') === 0) return message.paths.length > 0;
    return message.paths.indexOf(name) !== -1;
  }

  function mergeMessages(a, b) {
    const paths = a.paths.slice();
    b.paths.forEach((p) => {
      if (paths.indexOf(p) === -1) paths.push(p);
    });
    return { docs: a.docs || b.docs, css: a.css || b.css, many: a.many || b.many, paths: paths, n: Math.max(a.n, b.n) };
  }

  /**
   * Run updates one at a time. A message that arrives while one runs is kept (merged with others that arrive meanwhile)
   * and causes exactly one more run when the first has finished.
   */
  function createScheduler(run) {
    let running = false;
    let pending = null;
    return {
      isRunning: () => running,
      trigger: async function (message) {
        if (running) {
          pending = pending ? mergeMessages(pending, message) : message;
          return;
        }
        running = true;
        let current = message;
        try {
          while (current) {
            pending = null;
            try {
              await run(current);
            } catch (error) {
              /* one failed update must not stop the next */
            }
            current = pending;
          }
        } finally {
          running = false;
        }
      }
    };
  }

  /**
   * A ghost of a brick that left: a wrapper that carries the layer look (class and tint), holding a copy of the old brick,
   * placed absolutely at the old position inside the container. It is hidden from assistive technology and cannot be focused.
   */
  function makeGhost(spec, ctx) {
    const wrap = ctx.doc.createElement('div');
    wrap.className = 'pv-ghost ' + (spec.kind === 'decisions' ? 'decisions' : 'layer');
    if (spec.tint !== null && spec.tint !== undefined) wrap.setAttribute('data-tint', spec.tint);
    wrap.setAttribute('aria-hidden', 'true');
    wrap.setAttribute('inert', '');
    wrap.appendChild(spec.node.cloneNode(true));
    wrap.style.left = Math.round(spec.left - ctx.origin.left) + 'px';
    wrap.style.top = Math.round(spec.top - ctx.origin.top) + 'px';
    wrap.style.width = Math.round(spec.width) + 'px';
    wrap.style.height = Math.round(spec.height) + 'px';
    ctx.container.appendChild(wrap);
    return wrap;
  }

  /**
   * Start the animations of a plan and resolve when all have finished. Only transform and opacity are animated.
   * plan: {enter: element[], leave: ghost[], move: {el, dx, dy}[], sections: element[]}
   * timing: {enter, leave, move, easeOut, easeInOut}
   * Returns {finished: Promise, animations: Animation[]}.
   */
  function playAnimations(plan, timing) {
    const animations = [];
    const done = [];
    const start = (el, keyframes, options, after) => {
      const a = el.animate(keyframes, options);
      animations.push(a);
      done.push(
        a.finished.then(
          () => {
            if (after) after();
          },
          () => {
            if (after) after();
          }
        )
      );
    };
    plan.leave.forEach((ghost) => {
      start(
        ghost,
        [
          { opacity: 1, transform: 'scale(1)' },
          { opacity: 0, transform: 'scale(0.92)' }
        ],
        { duration: timing.leave, easing: timing.easeOut, fill: 'forwards' },
        () => ghost.remove()
      );
    });
    plan.move.forEach((m) => {
      start(
        m.el,
        [{ transform: 'translate(' + m.dx + 'px, ' + m.dy + 'px)' }, { transform: 'translate(0px, 0px)' }],
        { duration: timing.move, easing: timing.easeInOut, fill: 'backwards' }
      );
    });
    plan.enter.forEach((el, index) => {
      start(
        el,
        [
          { opacity: 0, transform: 'scale(0.92)' },
          { opacity: 1, transform: 'scale(1)' }
        ],
        { duration: timing.enter, easing: timing.easeOut, delay: staggerDelay(index, timing.stagger), fill: 'backwards' }
      );
    });
    plan.sections.forEach((el) => {
      start(el, [{ opacity: 0 }, { opacity: 1 }], { duration: timing.enter, easing: timing.easeOut, fill: 'backwards' });
    });
    return { finished: Promise.all(done), animations: animations };
  }

  /** Whether a change is animated at all: not with reduced motion, not in a hidden tab, not when it is very large. */
  function shouldAnimate(env, diff) {
    return !env.reduced && !env.hidden && changedCount(diff) > 0 && !tooMany(diff);
  }

  // -------------------------------------------------------------------------------------------
  // Browser part

  function init(doc) {
    const script = doc.currentScript || doc.querySelector('script[data-events]');
    const eventsUrl = script && script.getAttribute('data-events');
    if (!eventsUrl || typeof root.EventSource !== 'function') return;

    let styleCounter = 0;
    let active = [];

    const reduced = () => Boolean(root.matchMedia) && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function readTiming() {
      const cs = root.getComputedStyle(doc.documentElement);
      const get = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
      return {
        enter: parseDuration(get('--pv-dur-enter', ''), 200),
        leave: parseDuration(get('--pv-dur-leave', ''), 160),
        move: parseDuration(get('--pv-dur-move', ''), 300),
        stagger: parseDuration(get('--pv-stagger', ''), STAGGER_MS),
        easeOut: get('--pv-ease-out', 'cubic-bezier(0.23, 1, 0.32, 1)'),
        easeInOut: get('--pv-ease-in-out', 'cubic-bezier(0.77, 0, 0.175, 1)')
      };
    }

    /** Replace every stylesheet of the viewer by a copy with a new query string; the old one goes when the copy has loaded. */
    function reloadStyles() {
      styleCounter += 1;
      doc.querySelectorAll('link[rel~="stylesheet"]').forEach((link) => {
        const href = link.getAttribute('href') || '';
        if (href.indexOf('/skins/') === -1 && href.indexOf('/_pv/tokens.css') === -1) return;
        const clone = link.cloneNode(true);
        clone.setAttribute('href', href.replace(/\?pv=\d+$/, '') + '?pv=' + styleCounter);
        clone.addEventListener('load', () => link.remove());
        clone.addEventListener('error', () => clone.remove());
        link.after(clone);
      });
    }

    function settleAnimations() {
      active.forEach((a) => {
        try {
          a.finish();
        } catch (error) {
          /* already finished or cancelled */
        }
      });
      active = [];
      doc.querySelectorAll('.pv-ghost').forEach((g) => g.remove());
    }

    function measure(scope) {
      const entries = [];
      scope.querySelectorAll('.brick, .decision').forEach((li) => {
        const a = li.querySelector('a[data-pv-doc]');
        if (!a) return;
        const r = li.getBoundingClientRect();
        const layer = li.closest('[data-tint]');
        entries.push({
          key: keyOf(a.getAttribute('data-pv-doc'), a.getAttribute('data-pv-heading')),
          node: li,
          left: r.left + root.scrollX,
          top: r.top + root.scrollY,
          width: r.width,
          height: r.height,
          tint: layer ? layer.getAttribute('data-tint') : null,
          kind: li.classList.contains('decision') ? 'decisions' : 'layer',
          layer: layer ? layer.getAttribute('data-layer') : null
        });
      });
      return uniqueKeys(entries);
    }

    function layerKeys(scope) {
      return Array.prototype.map.call(scope.querySelectorAll('section[data-layer]'), (s) => s.getAttribute('data-layer'));
    }

    async function updateOverview() {
      const response = await root.fetch(root.location.pathname + root.location.search, { credentials: 'same-origin', cache: 'no-store' });
      // Never reload into an error page: it has no live script, so the page would stay dead. Keep what is shown and
      // wait for the next message, which arrives when the files are fixed.
      if (!response.ok) return;
      const next = new root.DOMParser().parseFromString(await response.text(), 'text/html');
      const article = doc.querySelector('main#pv-main > article.doc');
      const nextArticle = next.querySelector('main#pv-main > article.doc');
      // The dialog and its script exist only when there are layers: a page that gains or loses them is loaded anew.
      if (!article || !nextArticle) return;
      if (Boolean(doc.getElementById('pv-dialog')) !== Boolean(next.getElementById('pv-dialog'))) return root.location.reload();

      settleAnimations();
      const oldPyramid = doc.querySelector('.pyramid');
      const first = measure(article);
      const oldLayers = layerKeys(article);
      const x = root.scrollX;
      const y = root.scrollY;
      const focused = doc.activeElement && article.contains(doc.activeElement) && doc.activeElement.getAttribute ? doc.activeElement : null;
      const focusKey = focused && focused.hasAttribute('data-pv-doc') ? keyOf(focused.getAttribute('data-pv-doc'), focused.getAttribute('data-pv-heading')) : null;

      article.replaceChildren.apply(article, Array.prototype.map.call(nextArticle.childNodes, (n) => doc.importNode(n, true)));
      if (next.title) doc.title = next.title;
      root.scrollTo(x, y);

      const last = measure(article);
      if (focusKey) {
        const again = last.find((e) => e.key === focusKey);
        const link = again && again.node.querySelector('a');
        if (link) link.focus({ preventScroll: true });
      }
      const pyramid = doc.querySelector('.pyramid');
      if (!oldPyramid || !pyramid) return;

      const diff = diffBricks(first, last);
      const env = { reduced: reduced(), hidden: doc.visibilityState === 'hidden' };
      if (!shouldAnimate(env, diff)) return;

      const byKeyFirst = new Map(first.map((e) => [e.key, e]));
      const byKeyLast = new Map(last.map((e) => [e.key, e]));
      const box = pyramid.getBoundingClientRect();
      const ctx = { doc: doc, container: pyramid, origin: { left: box.left + root.scrollX, top: box.top + root.scrollY } };
      const newLayers = layerKeys(article).filter((k) => oldLayers.indexOf(k) === -1);
      const plan = {
        leave: diff.leave.map((k) => makeGhost(byKeyFirst.get(k), ctx)),
        move: diff.moved.map((m) => ({ el: byKeyLast.get(m.key).node, dx: m.dx, dy: m.dy })),
        enter: diff.enter.map((k) => byKeyLast.get(k).node),
        sections: Array.prototype.filter.call(article.querySelectorAll('section[data-layer]'), (s) => newLayers.indexOf(s.getAttribute('data-layer')) !== -1)
      };
      const played = playAnimations(plan, readTiming());
      active = played.animations;
      await played.finished;
    }

    /** Reload a document or tree page only when the same address still answers with a page (which carries this script). */
    async function reloadIfAvailable() {
      let response;
      try {
        response = await root.fetch(root.location.pathname + root.location.search, { credentials: 'same-origin', cache: 'no-store' });
      } catch (error) {
        return;
      }
      if (response.ok) root.location.reload();
    }

    function isOverview() {
      const main = doc.getElementById('pv-main');
      return Boolean(main) && doc.body.classList.contains('view-pyramid') && !main.classList.contains('content-paper');
    }

    async function handle(message) {
      if (message.css) reloadStyles();
      if (!message.docs) return;
      doc.dispatchEvent(new root.CustomEvent('pv:refresh', { detail: { paths: message.paths, many: message.many } }));
      if (isOverview()) await updateOverview();
      else if (pageAffected(root.location.pathname, message)) await reloadIfAvailable();
    }

    const scheduler = createScheduler(handle);
    const source = new root.EventSource(eventsUrl);
    let failed = false;
    source.addEventListener('change', (event) => {
      const message = parseMessage(event.data);
      if (message) scheduler.trigger(message);
    });
    source.addEventListener('error', () => {
      failed = true;
    });
    source.addEventListener('open', () => {
      // Changes may have been missed while the connection was down (also after a server restart).
      if (!failed) return;
      failed = false;
      scheduler.trigger({ docs: true, css: true, many: true, paths: [], n: 0 });
    });
  }

  // Exposed so that the tests can run the logic without a browser. Nothing else reads it.
  root.pvLiveLogic = {
    keyOf: keyOf,
    uniqueKeys: uniqueKeys,
    diffBricks: diffBricks,
    changedCount: changedCount,
    tooMany: tooMany,
    staggerDelay: staggerDelay,
    flipDelta: flipDelta,
    parseDuration: parseDuration,
    parseMessage: parseMessage,
    mergeMessages: mergeMessages,
    pageAffected: pageAffected,
    createScheduler: createScheduler,
    makeGhost: makeGhost,
    playAnimations: playAnimations,
    shouldAnimate: shouldAnimate
  };
  if (root.document) init(root.document);
})();
