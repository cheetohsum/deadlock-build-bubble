// Minimal Panorama emulation on top of the DOM, so the preview runs the real in-game script and stylesheet.
(function () {
  const ASSET_BASE = 'https://assets-bucket.deadlock-api.com/assets-api-res/images/';

  // In-game texture path -> web image. Hero name logos come from the data's web URLs;
  // everything else follows the asset bucket layout (s2r://panorama/images/x/y_psd.vtex -> .../images/x/y.png).
  let artMap = null;
  function mapImage(src) {
    if (!artMap && window.BB_DATA) {
      artMap = {};
      for (const h of Object.values(window.BB_DATA.heroes)) if (h.nameArt && h.web) artMap[h.nameArt] = h.web.name;
    }
    // Exact game texture -> web image pairs recorded by gen-data (the CDN's folders don't mirror the game's).
    if (window.BB_WEB_IMAGES && window.BB_WEB_IMAGES[src]) return window.BB_WEB_IMAGES[src];
    if (artMap && artMap[src]) return artMap[src];
    const m = /^s2r:\/\/panorama\/images\/(.+?)(?:_psd|_png)?\.(?:vtex|vsvg)$/.exec(src || '');
    return m ? ASSET_BASE + m[1].replace(/^hud\/abilities\//, 'abilities/') + '.png' : '';
  }

  // Panorama's wash-color tints an image; in the browser the image becomes a mask over the colour.
  // Cursor position for GameUI.GetCursorPosition (moving the bubble), in the preview's CSS pixels.
  const cursor = [0, 0];
  window.addEventListener('mousemove', (e) => {
    const r = document.getElementById('hud').getBoundingClientRect();
    cursor[0] = e.clientX - r.left;
    cursor[1] = e.clientY - r.top;
  });
  // Left mouse button state for GameUI.IsMouseDown (press-and-hold dragging).
  let leftDown = false;
  window.addEventListener('mousedown', (e) => { if (e.button === 0) leftDown = true; });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) leftDown = false; });
  window.addEventListener('blur', () => { leftDown = false; });
  document.addEventListener('mouseleave', () => { leftDown = false; });
  window.GameUI = {
    GetCursorPosition: () => [cursor[0], cursor[1]],
    IsMouseDown: (button) => (button === 0 ? leftDown : false),
  };

  function panelStyle(el) {
    return new Proxy(el.style, {
      set(target, prop, value) {
        if (value === 'fit-children') value = 'auto';
        // Panorama's position: "Xpx Ypx 0px" places a panel inside its parent.
        if (prop === 'position' && /px/.test(String(value))) {
          const [x, y] = String(value).trim().split(/\s+/).map((v) => parseFloat(v) || 0);
          target.left = x + 'px';
          target.top = y + 'px';
          target.right = 'auto';
          return true;
        }
        if (prop === 'washColor') {
          const img = target.backgroundImage;
          // CSS masks need CORS, which the asset CDN only sends for its SVGs. Raster icons (the dark ability
          // silhouettes) are recoloured with a filter instead: black -> warm off-white, close to the cream wash.
          if (img && img !== 'none' && !/\.svg["')]*$|^url\(["']?data:image\/svg/i.test(img)) {
            target.filter = 'brightness(0) invert(1) sepia(0.15)';
            return true;
          }
          if (img && img !== 'none') {
            Object.assign(target, { webkitMaskImage: img, maskImage: img, webkitMaskSize: 'contain', maskSize: 'contain',
              webkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat', webkitMaskPosition: 'left center', maskPosition: 'left center' });
            target.backgroundImage = 'none';
          }
          target.backgroundColor = value;
          return true;
        }
        target[prop] = value;
        return true;
      },
      get(target, prop) { const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v; },
    });
  }

  let tooltip = null;
  function showTooltip(panel, text) {
    hideTooltip();
    tooltip = document.createElement('div');
    tooltip.className = 'pn-tooltip';
    tooltip.textContent = text;
    document.body.appendChild(tooltip);
    const r = panel._el.getBoundingClientRect();
    const t = tooltip.getBoundingClientRect();
    tooltip.style.left = Math.max(4, Math.min(window.innerWidth - t.width - 4, r.left + r.width / 2 - t.width / 2)) + 'px';
    tooltip.style.top = Math.max(4, r.top - t.height - 6) + 'px';
  }
  function hideTooltip() { if (tooltip) { tooltip.remove(); tooltip = null; } }

  // Panorama drag-and-drop: press on a draggable panel and move a few pixels; DragStart hands back a
  // display panel that follows the cursor until release, then DragEnd gets it.
  function fire(panel, name, ...args) {
    return ((panel._handlers && panel._handlers[name]) || []).map((fn) => fn(...args)).some(Boolean);
  }
  function wireDrag(panel) {
    panel._el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // Panorama has no text selection
      const sx = e.clientX, sy = e.clientY;
      let callbacks = null;
      const place = () => {
        const d = callbacks.displayPanel;
        if (d) d.style.position = (cursor[0] - (callbacks.offsetX || 0)) + 'px ' + (cursor[1] - (callbacks.offsetY || 0)) + 'px 0px';
      };
      const move = (ev) => {
        if (!callbacks) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
          callbacks = {};
          if (!fire(panel, 'DragStart', panel.id, callbacks)) { callbacks = null; stop(); return; }
          if (callbacks.displayPanel) callbacks.displayPanel._el.style.position = 'absolute';
        }
        place();
      };
      const stop = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      const up = (ev) => {
        stop();
        if (!callbacks) return;
        // The drop goes to the panel under the cursor (or its nearest ancestor with a DragDrop handler).
        let t = document.elementFromPoint(ev.clientX, ev.clientY);
        while (t && !(t._pn && t._pn._handlers && t._pn._handlers.DragDrop)) t = t.parentElement;
        if (t) fire(t._pn, 'DragDrop', panel.id, callbacks.displayPanel);
        fire(panel, 'DragEnd', panel.id, callbacks.displayPanel);
        // The release that ends a drag isn't a click.
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener('click', swallow, true);
        setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  class Panel {
    constructor(type, id, el) {
      this.type = type;
      this.id = id || '';
      this._el = el || document.createElement(type === 'TextEntry' ? 'input' : 'div');
      if (type === 'TextEntry') {
        Object.defineProperty(this, 'text', { get: () => this._el.value, set: (v) => { this._el.value = String(v); } });
      }
      this._el.classList.add('pn', 'pn-' + type);
      if (id) this._el.id = id;
      this._children = [];
      this._parent = null;
      this._dead = false;
      this.style = panelStyle(this._el);
      this._el._pn = this;
    }
    // Layout measurements Panorama exposes (the preview runs at a UI scale of 1).
    get actualxoffset() { return this._el.getBoundingClientRect().left - hudEl.getBoundingClientRect().left; }
    get actualyoffset() { return this._el.getBoundingClientRect().top - hudEl.getBoundingClientRect().top; }
    get actuallayoutwidth() { return this._el.offsetWidth; }
    get actuallayoutheight() { return this._el.offsetHeight; }
    get actualuiscale_x() { return 1; }
    get actualuiscale_y() { return 1; }
    GetPositionWithinWindow() {
      const r = this._el.getBoundingClientRect(), h = hudEl.getBoundingClientRect();
      return { x: r.left - h.left, y: r.top - h.top };
    }
    SetDraggable(v) { if (v && !this._dragWired) { this._dragWired = true; wireDrag(this); } }
    get text() { return this._el.textContent; }
    set text(v) { this._el.textContent = String(v).replace(/^\u200B/, ''); }
    get hittest() { return this._el.style.pointerEvents !== 'none'; }
    set hittest(v) { this._el.style.pointerEvents = v ? '' : 'none'; }
    AddClass(c) { this._el.classList.add(c); }
    RemoveClass(c) { this._el.classList.remove(c); }
    SetHasClass(c, v) { this._el.classList.toggle(c, !!v); }
    BHasClass(c) { return this._el.classList.contains(c); }
    IsValid() { return !this._dead; }
    Children() { return this._children.slice(); }
    GetParent() { return this._parent; }
    FindChildTraverse(id) {
      for (const c of this._children) { if (c.id === id) return c; const f = c.FindChildTraverse(id); if (f) return f; }
      return null;
    }
    RemoveAndDeleteChildren() { for (const c of this._children) { c._dead = true; c._el.remove(); } this._children = []; hideTooltip(); }
    DeleteAsync() { this._dead = true; this._el.remove(); if (this._parent) this._parent._children = this._parent._children.filter((c) => c !== this); }
    SetPanelEvent(name, fn) {
      if (name === 'oninputsubmit') {
        this._el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); fn(); } });
        return;
      }
      const map = { onactivate: 'click', onmouseover: 'mouseenter', onmouseout: 'mouseleave' };
      if (map[name]) this._el.addEventListener(map[name], (e) => { e.stopPropagation(); fn(); });
    }
    SetImage(src) { const u = mapImage(src); this._el.style.backgroundImage = u ? `url("${u}")` : ''; }
    GetAttributeString(name, def) { return def; }
  }

  function adopt(parent, child) { child._parent = parent; parent._children.push(child); parent._el.appendChild(child._el); return child; }

  const hudEl = document.getElementById('hud');
  const root = new Panel('CitadelHud', 'hud', hudEl);
  const abilities = adopt(root, new Panel('Panel', 'AbilitiesContainer'));
  const alive = adopt(root, new Panel('Panel', 'gameplay_hud_alive'));
  const progress = adopt(adopt(alive, new Panel('Panel', 'crosshair')), new Panel('Panel', 'progress'));

  const keyHandlers = [];
  const KEYS = { key_backslash: '\\', key_backquote: '`', key_f6: 'F6', key_f8: 'F8', key_insert: 'Insert' };
  // Any Panorama key name (key_h -> "h", key_f7 -> "F7"); typing into a text box isn't a hotkey.
  const keyFor = (name) => KEYS[name] || (/^key_f\d+$/.test(name) ? name.slice(4).toUpperCase() : name.replace(/^key_/, ''));
  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    for (const h of keyHandlers) {
      const want = keyFor(h.key);
      if (e.key === want || e.key.toLowerCase() === want) { e.preventDefault(); h.fn(); }
    }
  });

  window.$ = {
    GetContextPanel: () => root,
    CreatePanel: (type, parent, id) => adopt(parent, new Panel(type, id)),
    Schedule: (seconds, fn) => setTimeout(fn, seconds * 1000),
    Msg: (m) => { console.log(m); window.parent.postMessage({ type: 'bb-log', text: String(m) }, '*'); },
    RegisterKeyBind: (ctx, key, fn) => keyHandlers.push({ key, fn }),
    RegisterEventHandler: (name, panel, fn) => {
      panel._handlers = panel._handlers || {};
      (panel._handlers[name] = panel._handlers[name] || []).push(fn);
    },
    // Panorama's persistent storage. The preview keeps it in memory (pins saved in the manager are baked into
    // the data) and hands pins made in the bubble to the manager page, which saves them with its settings.
    persistentStorage: (() => {
      const store = new Map();
      return {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => {
          store.set(key, String(value));
          if (key === 'build_bubble_pins') window.parent.postMessage({ type: 'bb-pins', pins: JSON.parse(value) }, '*');
        },
        removeItem: (key) => { store.delete(key); },
      };
    })(),
    DispatchEvent: (name, panel, text) => {
      // In-game this opens the Steam overlay or default browser; the preview opens a new tab.
      if (name === 'ExternalBrowserGoToURL') { window.open(String(panel), '_blank', 'noopener'); return; }
      if (name === 'UIShowTextTooltip') showTooltip(panel, text);
      else if (name === 'UIHideTextTooltip') hideTooltip();
    },
  };

  // The manager page drives the fake HUD state: which hero is played, shop / draft open.
  window.bbSim = {
    setHero(cls) { [...progress._el.classList].filter((c) => /^hero_/.test(c)).forEach((c) => progress.RemoveClass(c)); if (cls) progress.AddClass(cls); },
    setShop(v) { abilities.SetHasClass('gShopOpen', v); },
    setDraft(v) { abilities.SetHasClass('gItemDraftOpen', v); },
    pressHotkey() { for (const h of keyHandlers) h.fn(); },
  };

  // Translate the Panorama-only CSS the bubble uses into browser CSS.
  function panoramaToCss(css) {
    return css
      .replace(/background-color:\s*gradient\(\s*linear,\s*0% 0%,\s*0% 100%,\s*from\(\s*([^)]+?)\s*\),\s*to\(\s*([^)]+?)\s*\)\s*\)/g, 'background: linear-gradient(to bottom, $1, $2)')
      .replace(/background-color:\s*gradient\(\s*linear,\s*0% 0%,\s*100% 0%,\s*from\(\s*([^)]+?)\s*\),\s*to\(\s*([^)]+?)\s*\)\s*\)/g, 'background: linear-gradient(to right, $1, $2)')
      .replace(/flow-children:\s*down;/g, 'display: flex; flex-direction: column; align-items: flex-start;')
      .replace(/flow-children:\s*right-wrap;/g, 'display: flex; flex-direction: row; flex-wrap: wrap; align-items: flex-start;')
      .replace(/flow-children:\s*right;/g, 'display: flex; flex-direction: row; align-items: flex-start;')
      .replace(/width:\s*fill-parent-flow\(\s*1\.0\s*\);/g, 'flex: 1 1 0; min-width: 0;')
      .replace(/horizontal-align:\s*center;/g, 'margin-left: auto; margin-right: auto; align-self: center;')
      .replace(/horizontal-align:\s*right;/g, 'margin-left: auto;')
      .replace(/horizontal-align:\s*left;/g, '')
      .replace(/vertical-align:\s*center;/g, 'align-self: center;')
      .replace(/vertical-align:\s*top;/g, 'align-self: flex-start;')
      .replace(/vertical-align:\s*bottom;/g, 'align-self: end;')
      .replace(/overflow:\s*squish scroll;/g, 'overflow-y: auto;')
      // Panorama shadows carry a strength after the blur: x y blur strength colour. The browser gets it twice
      // (text) or as a drop-shadow filter (images).
      .replace(/text-shadow:\s*(-?[\d.]+px)\s+(-?[\d.]+px)\s+([\d.]+px)\s+[\d.]+\s+(#[0-9a-fA-F]{3,8});/g, 'text-shadow: $1 $2 $3 $4, $1 $2 $3 $4;')
      .replace(/img-shadow:\s*(-?[\d.]+px)\s+(-?[\d.]+px)\s+([\d.]+px)\s+[\d.]+\s+(#[0-9a-fA-F]{3,8});/g, 'filter: drop-shadow($1 $2 $3 $4);')
      .replace(/visibility:\s*collapse;/g, 'display: none;')
      .replace(/visibility:\s*visible;/g, 'display: flex;')
      .replace(/ignore-parent-flow:\s*true;/g, 'position: absolute; top: 0; right: 0;')
      .replace(/text-overflow:\s*shrink;/g, 'text-overflow: ellipsis; white-space: nowrap; overflow: hidden;')
      .replace(/font-family:\s*"Swear Text Demo",\s*serif;/g, 'font-family: "Swear Text Demo", "Bahnschrift SemiCondensed", Georgia, serif; font-weight: 600;')
      .replace(/font-family:\s*block;/g, 'font-family: "Bahnschrift SemiCondensed", "Arial Narrow", sans-serif; font-weight: 600;')
      .replace(/font-family:\s*sansMono;/g, 'font-family: Consolas, "Cascadia Mono", monospace;')
      .replace(/font-family:\s*sans;/g, 'font-family: "Segoe UI", system-ui, sans-serif;');
  }

  window.bbLoadStyles = async function (url) {
    const css = await (await fetch(url)).text();
    const style = document.createElement('style');
    style.textContent = panoramaToCss(css);
    document.head.appendChild(style);
  };
})();
