// dom.js — tiny DOM helpers: h() for element creation (replaces innerHTML
// string templates), keyedList() for stable list diffing, and a cleanup bag
// so a view's render(mount) return value (the existing overlay-manager /
// widget-host teardown contract — see overlay-manager.js's `entry.cleanup`)
// can tear down every listener/child it created in one call. No vdom, no
// diffing beyond keyed lists, no build step — everything here is plain DOM.
//
// Deliberately NOT a component model: no props, no lifecycle hooks, no
// re-render scheduling. Every view in this codebase is "closures + plain
// functions, mutate DOM directly, re-run a render function on data change" —
// this is additive tooling for use inside that shape, not a replacement for it.

// h(tag, props, ...children) -> HTMLElement
//   props: attrs (strings/booleans), `class`/`className`, `style` (object),
//   `on<Event>` handlers (bound directly, no delegation magic), `data-*`
//   passthrough. children: string | Node | Array<string|Node>, nullish/false
//   entries are skipped (ergonomic conditional rendering). children are text
//   nodes by default (always escaped, no XSS risk) — pass `html` in props as
//   an explicit opt-in escape hatch for the rare case that needs raw markup.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v; // explicit escape hatch, opt-in only
    else if (typeof v === 'boolean') { if (v) el.setAttribute(k, ''); }
    else el.setAttribute(k, v);
  }
  appendChildren(el, children.flat(Infinity));
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// text(str) -> Text node. Explicit helper so call sites read as intentionally
// safe — a real text node instead of an innerHTML-escaped string, strictly
// safer than the hand-rolled escapeHtml() pattern it replaces.
export const text = (str) => document.createTextNode(str ?? '');

// cleanupBag() -> {add(fn), run()} — collects teardown functions so a view
// can register listeners/timers/subscriptions as it builds the DOM and tear
// them all down in the single function it returns from render() (the
// existing contract every panel/widget already relies on).
export function cleanupBag() {
  const fns = [];
  return {
    add(fn) { if (typeof fn === 'function') fns.push(fn); },
    run() { while (fns.length) { try { fns.pop()(); } catch { /* teardown must never throw */ } } },
  };
}

// keyedList(container, items, keyFn, renderFn, updateFn?) — reconciles
// container's children against `items` by key: reuses existing nodes in
// place (no rebuild -> no lost focus/scroll/hover/in-flight screen-reader
// announcements), removes nodes whose key disappeared, inserts new nodes at
// the right position, reorders via insertBefore when key order changed.
// updateFn(node, item) is called on every existing node so it can patch
// text/classes in place; renderFn(item) builds a brand-new node the first
// time a key appears (and is the only place event listeners get bound —
// existing nodes are patched, never rebuilt, so listeners never accumulate).
export function keyedList(container, items, keyFn, renderFn, updateFn) {
  const existing = new Map(); // key -> node
  for (const node of container.children) existing.set(node.dataset.key, node);
  let prev = null;
  const seen = new Set();
  for (const item of items) {
    const key = String(keyFn(item));
    seen.add(key);
    let node = existing.get(key);
    if (!node) {
      node = renderFn(item);
      node.dataset.key = key;
    } else if (updateFn) {
      updateFn(node, item);
    }
    const after = prev ? prev.nextSibling : container.firstChild;
    if (after !== node) container.insertBefore(node, after);
    prev = node;
  }
  for (const [key, node] of existing) {
    if (!seen.has(key)) node.remove();
  }
}
