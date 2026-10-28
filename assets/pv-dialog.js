/* Dialog for the pyramid overview.
   Plain browser JavaScript, a classic deferred script, no dependencies. Without it the bricks are ordinary links
   to the document pages. With it, a click on a brick opens the whole document in a modal dialog and scrolls to
   the heading. Links to other documents inside the dialog load them there; a small history stack feeds Back.
   Where the documents come from: in serve mode the dialog carries data-content (the fragment route) and the
   script fetches; in a static export every document sits in a template element with data-pv-page and nothing
   is fetched, because browsers block fetch on file URLs.
   The dialog also has a left navigation: the page index of the shown document, with the current section marked by
   scroll position. It opens and closes with a short animation that reduced motion switches off. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;

  /** Resolve href against base. Returns the URL without its fragment, the decoded fragment and URL parts, or null. */
  function splitUrl(href, base) {
    let u;
    try {
      u = new URL(href, base);
    } catch (error) {
      return null;
    }
    let hash = u.hash.slice(1);
    try {
      hash = decodeURIComponent(hash);
    } catch (error) {
      /* keep the raw fragment */
    }
    u.hash = '';
    return { url: u.href, hash: hash, origin: u.origin, protocol: u.protocol, pathname: u.pathname, search: u.search };
  }

  /** True for a plain left click: no modifier key, not a middle or right click, not already handled. */
  function isPlainClick(e) {
    return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && !e.defaultPrevented;
  }

  /** The first element of the list whose id equals id. A plain comparison: no selector is built from the id. */
  function findById(list, id) {
    if (!id) return null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /** Whether a click on the dialog element (the backdrop) closes it: the press also started on the backdrop, and the
      dialog has been open longer than the guard time, so the second click of a double click on a brick does not
      close it again. */
  function backdropCloses(o) {
    return o.target === o.dialog && o.downTarget === o.dialog && o.now - o.openedAt >= 300;
  }

  /** The trimmed text of a link, used as the title while its document loads. */
  function linkLabel(a) {
    return a && a.textContent ? a.textContent.trim() : '';
  }

  /** A stack of {url, top} entries: the documents that Back returns to. */
  function createHistory() {
    const items = [];
    return {
      push: (entry) => items.push(entry),
      pop: () => items.pop() || null,
      size: () => items.length,
      clear: () => {
        items.length = 0;
      }
    };
  }

  /** Fragment route URL for a page URL, in serve mode: the base plus path and query of the page. */
  function contentUrl(base, s) {
    return base.replace(/\/+$/, '') + s.pathname + s.search;
  }

  /** Index of the heading that is current for a scroll container: the last heading whose top is at or above the top of the
      container plus offset; the first when scrolled to the top; the last when scrolled to the bottom. -1 without headings. */
  function currentHeadingIndex(headings, container, offset) {
    if (headings.length === 0) return -1;
    const top = container.scrollTop;
    if (top <= 0) return 0;
    if (top + container.clientHeight >= container.scrollHeight - 1) return headings.length - 1;
    const limit = container.getBoundingClientRect().top + offset;
    let found = 0;
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top <= limit) found = i;
      else break;
    }
    return found;
  }

  /** Scroll position that puts an element at the top of a scroll container. Layout distances are measured on screen and
      divided by the container's scale, so the result is right while the opening animation still scales the dialog. */
  function scrollTopFor(el, container) {
    const box = container.getBoundingClientRect();
    const scale = container.offsetHeight > 0 && box.height > 0 ? box.height / container.offsetHeight : 1;
    return (el.getBoundingClientRect().top - box.top) / scale + container.scrollTop;
  }

  /** The start offset of the opening animation: the dialog arrives slightly from the side of the brick that was clicked.
      Eight percent of the distance from the centre of the window, at most 24 pixels each way. */
  function fromOffset(rect, width, height) {
    const clamp = (v) => Math.max(-24, Math.min(24, v));
    const dx = rect.left + rect.width / 2 - width / 2;
    const dy = rect.top + rect.height / 2 - height / 2;
    return { x: Math.round(clamp(dx * 0.08)), y: Math.round(clamp(dy * 0.08)) };
  }

  /** Whether a change message from the live script (event pv:refresh) concerns the document at this URL path. */
  function refreshApplies(pathname, detail) {
    if (!detail || detail.many || !Array.isArray(detail.paths)) return true;
    let name = String(pathname || '').replace(/^\/+/, '');
    try {
      name = decodeURIComponent(name);
    } catch (error) {
      /* keep the raw path */
    }
    return detail.paths.indexOf(name) !== -1;
  }

  function init(doc) {
    const dialog = doc.getElementById('pv-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') return;
    const body = doc.getElementById('pv-dialog-body');
    const toc = doc.getElementById('pv-dialog-toc');
    const title = doc.getElementById('pv-dialog-title');
    const back = doc.getElementById('pv-dialog-back');
    const close = doc.getElementById('pv-dialog-close');
    const contentBase = dialog.getAttribute('data-content');
    const templates = new Map();
    doc.querySelectorAll('template[data-pv-page]').forEach((t) => {
      const s = splitUrl(t.getAttribute('data-pv-page'), doc.baseURI);
      if (s) templates.set(s.url, t);
    });
    if (templates.size === 0 && !contentBase) return;

    const cache = new Map();
    const history = createHistory();
    let current = null;
    let opener = null;
    let openerKey = null;
    let ticket = 0;
    let openedAt = 0;
    let downTarget = null;
    let headings = [];
    let tocLinks = [];
    let activeIndex = -1;
    let frame = 0;
    let closeTimer = 0;

    const reduced = () => Boolean(root.matchMedia) && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isDocument = (s) => Boolean(s) && (templates.size > 0 ? templates.has(s.url) : s.origin === root.location.origin && /\.md$/i.test(s.pathname));

    function load(s) {
      const template = templates.get(s.url);
      if (template) return Promise.resolve(template.content.cloneNode(true));
      if (cache.has(s.url)) return Promise.resolve(cache.get(s.url).cloneNode(true));
      return root
        .fetch(contentUrl(contentBase, s), { credentials: 'same-origin' })
        .then((r) => {
          if (!r.ok && r.status !== 413) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .then((text) => {
          const t = doc.createElement('template');
          t.innerHTML = text;
          cache.set(s.url, t.content);
          return t.content.cloneNode(true);
        });
    }

    function scrollToId(id, smooth) {
      const el = findById(body.querySelectorAll('[id]'), id);
      const top = el ? scrollTopFor(el, body) : 0;
      body.scrollTo({ top: top, behavior: smooth && !reduced() ? 'smooth' : 'auto' });
    }

    /** Move the page index of the shown document out of the article into the left column, and list its headings. */
    function buildToc() {
      headings = [];
      tocLinks = [];
      activeIndex = -1;
      if (!toc) return;
      const nav = body.querySelector('nav.page-toc');
      const label = nav && nav.querySelector('.toc-label');
      const list = nav && nav.querySelector('ul');
      if (!nav || !list) {
        toc.replaceChildren();
        toc.hidden = true;
        return;
      }
      toc.replaceChildren(...[label, list].filter(Boolean));
      nav.remove();
      toc.hidden = false;
      const ids = body.querySelectorAll('[id]');
      tocLinks = Array.prototype.slice.call(toc.querySelectorAll('a[href]'));
      const linked = [];
      tocLinks.forEach((a) => {
        let id = a.getAttribute('href').replace(/^#/, '');
        try {
          id = decodeURIComponent(id);
        } catch (error) {
          /* keep the raw id */
        }
        const h = findById(ids, id);
        linked.push(h);
      });
      headings = linked;
      updateCurrent(false);
    }

    function setCurrent(index, scrollNav) {
      if (index === activeIndex) return;
      activeIndex = index;
      tocLinks.forEach((a, i) => {
        if (i === index) a.setAttribute('aria-current', 'location');
        else a.removeAttribute('aria-current');
      });
      const link = tocLinks[index];
      if (scrollNav && link && link.scrollIntoView) {
        const box = toc.getBoundingClientRect();
        const at = link.getBoundingClientRect();
        if (at.top < box.top || at.bottom > box.bottom) link.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      }
    }

    function updateCurrent(scrollNav) {
      const present = headings.filter(Boolean);
      const found = currentHeadingIndex(present, body, 24);
      setCurrent(found < 0 ? -1 : headings.indexOf(present[found]), scrollNav);
    }

    body.addEventListener(
      'scroll',
      () => {
        if (headings.length === 0 || frame) return;
        const run = () => {
          frame = 0;
          updateCurrent(true);
        };
        frame = root.requestAnimationFrame ? root.requestAnimationFrame(run) : (run(), 0);
      },
      { passive: true }
    );

    function show(s, hash, top, label) {
      const mine = ++ticket;
      current = s;
      back.hidden = history.size() === 0;
      let name = s.pathname.split('/').pop() || '';
      try {
        name = decodeURIComponent(name);
      } catch (error) {
        /* keep the raw name */
      }
      title.textContent = label || name.replace(/\.(md|html)$/i, '');
      body.textContent = dialog.getAttribute('data-loading');
      if (toc) {
        toc.replaceChildren();
        toc.hidden = true;
      }
      headings = [];
      tocLinks = [];
      activeIndex = -1;
      load(s)
        .then((fragment) => {
          if (mine !== ticket) return;
          body.replaceChildren(fragment);
          buildToc();
          const h1 = body.querySelector('h1');
          if (h1) title.textContent = h1.textContent;
          if (typeof top === 'number') body.scrollTop = top;
          else scrollToId(hash, false);
          updateCurrent(true);
        })
        .catch(() => {
          if (mine !== ticket) return;
          body.textContent = dialog.getAttribute('data-error');
          if (toc) toc.hidden = true;
        });
    }

    /** Close at once, also when a closing animation is running. */
    function finishClose() {
      root.clearTimeout(closeTimer);
      closeTimer = 0;
      dialog.removeAttribute('data-closing');
      if (dialog.open) dialog.close();
    }

    /** Close with the short closing animation (pointer actions). Reduced motion and a closed dialog close at once. */
    function closeAnimated() {
      if (!dialog.open || dialog.hasAttribute('data-closing')) return;
      if (reduced()) return finishClose();
      dialog.setAttribute('data-closing', '');
      dialog.addEventListener('animationend', function done(e) {
        if (e.target !== dialog) return;
        dialog.removeEventListener('animationend', done);
        if (dialog.hasAttribute('data-closing')) finishClose();
      });
      closeTimer = root.setTimeout(finishClose, 250);
    }

    /** The live script says that files changed: fetch the open document again and keep the reading place. */
    function refresh(detail) {
      // Any change makes the cached fragments suspect, also when the dialog is closed or shows another document.
      cache.clear();
      if (!contentBase || !dialog.open || !current || !refreshApplies(current.pathname, detail)) return;
      const mine = ++ticket;
      const top = body.scrollTop;
      load(current)
        .then((fragment) => {
          if (mine !== ticket) return;
          body.replaceChildren(fragment);
          buildToc();
          const h1 = body.querySelector('h1');
          if (h1) title.textContent = h1.textContent;
          // The new text may be shorter: the browser clamps the position to the new height.
          body.scrollTop = top;
          updateCurrent(true);
        })
        .catch(() => {
          if (mine !== ticket) return;
          body.textContent = dialog.getAttribute('data-error');
          if (toc) toc.hidden = true;
        });
    }
    doc.addEventListener('pv:refresh', (e) => refresh(e.detail));

    function open(s, hash, link) {
      opener = link;
      openerKey = link && link.getAttribute ? { doc: link.getAttribute('data-pv-doc'), heading: link.getAttribute('data-pv-heading') } : null;
      history.clear();
      if (dialog.hasAttribute('data-closing')) finishClose();
      // The tint of the layer that the brick belongs to, for the frame of the dialog.
      const layer = link && link.closest ? link.closest('[data-tint]') : null;
      if (layer) dialog.setAttribute('data-tint', layer.getAttribute('data-tint'));
      else dialog.removeAttribute('data-tint');
      if (!dialog.open) {
        const from = link && link.getBoundingClientRect ? fromOffset(link.getBoundingClientRect(), root.innerWidth || 1, root.innerHeight || 1) : { x: 0, y: 8 };
        dialog.style.setProperty('--pv-from-x', from.x + 'px');
        dialog.style.setProperty('--pv-from-y', (link ? from.y : 8) + 'px');
        dialog.showModal();
        openedAt = Date.now();
      }
      show(s, hash, undefined, linkLabel(link));
      body.focus({ preventScroll: true });
    }

    function navigate(s, hash, label) {
      history.push({ s: current, top: body.scrollTop });
      show(s, hash, undefined, label);
      body.focus({ preventScroll: true });
    }

    back.addEventListener('click', () => {
      const previous = history.pop();
      if (previous) show(previous.s, '', previous.top);
      // Back hides itself on the first document while it holds focus; keep the place inside the dialog.
      body.focus({ preventScroll: true });
    });
    close.addEventListener('click', closeAnimated);
    // A click on the backdrop reports the dialog itself as its target; a click inside reports a child.
    // The press must also have started on the backdrop (so a text selection that ends there does not close it), and
    // not right after opening (so the second click of a double click on a brick does not close it again).
    dialog.addEventListener('mousedown', (e) => {
      downTarget = e.target;
    });
    dialog.addEventListener('click', (e) => {
      if (backdropCloses({ target: e.target, downTarget: downTarget, dialog: dialog, openedAt: openedAt, now: Date.now() })) closeAnimated();
      downTarget = null;
    });
    dialog.addEventListener('close', () => {
      // The close event arrives later than close(); a dialog opened again in between keeps its new document.
      if (dialog.open) return;
      ticket++;
      history.clear();
      dialog.removeAttribute('data-closing');
      body.textContent = '';
      if (toc) {
        toc.replaceChildren();
        toc.hidden = true;
      }
      headings = [];
      tocLinks = [];
      // A live update may have replaced the brick that opened the dialog: find its successor by document and heading.
      if (opener && !opener.isConnected && openerKey && openerKey.doc) {
        opener = Array.prototype.find.call(doc.querySelectorAll('a[data-pv-doc]'), (a) => a.getAttribute('data-pv-doc') === openerKey.doc && (a.getAttribute('data-pv-heading') || '') === (openerKey.heading || '')) || null;
      }
      if (opener && opener.isConnected) opener.focus();
      opener = null;
      openerKey = null;
    });

    doc.addEventListener('click', (e) => {
      if (!isPlainClick(e) || !e.target.closest) return;
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (a.hasAttribute('data-pv-doc')) {
        const s = splitUrl(href, doc.baseURI);
        if (isDocument(s)) {
          e.preventDefault();
          open(s, s.hash, a);
        }
        return;
      }
      const inToc = Boolean(toc) && toc.contains(a);
      if (!dialog.open || (!body.contains(a) && !inToc)) return;
      if (href.charAt(0) === '#') {
        e.preventDefault();
        let id = href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch (error) {
          /* keep the raw id */
        }
        scrollToId(id, true);
        if (inToc) setCurrent(tocLinks.indexOf(a), false);
        return;
      }
      const s = splitUrl(href, current.url);
      if (isDocument(s)) {
        e.preventDefault();
        navigate(s, s.hash, linkLabel(a));
      } else if (s) {
        // Resolve against the document, not the overview page that the browser would use otherwise.
        a.setAttribute('href', s.url + (s.hash ? '#' + encodeURIComponent(s.hash) : ''));
      }
    });
  }

  // Exposed so that the tests can run the logic without a browser. Nothing else reads it.
  root.pvDialogLogic = { findById: findById, backdropCloses: backdropCloses, linkLabel: linkLabel, splitUrl: splitUrl, isPlainClick: isPlainClick, createHistory: createHistory, contentUrl: contentUrl, currentHeadingIndex: currentHeadingIndex, scrollTopFor: scrollTopFor, fromOffset: fromOffset, refreshApplies: refreshApplies, init: init };
  if (root.document) init(root.document);
})();
