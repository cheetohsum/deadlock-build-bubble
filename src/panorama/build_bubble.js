// Deadlock Build Bubble - Panorama HUD addon.
// BB_DATA and BB_SETTINGS are prepended by tools/build.js from tools/gen-data.js output.
'use strict';
(function () {
  var VERSION = '0.11.0';
  var TAG = '[BuildBubble] ';
  var SOURCES = ['standard', 'pro', 'winrate'];
  var SOURCE_LABEL = { standard: 'Community', pro: 'Pro', winrate: 'Top WR' };
  var SLOT_CLASS = { w: 'BBWeapon', v: 'BBVitality', s: 'BBSpirit' };
  var META = BB_DATA.meta || {};
  var ICONS = META.icons || {};
  var LOOKBACK_DAYS = META.lookbackDays || 30;
  var FLOORS = (META.floors && META.floors.length) ? META.floors : [{ badge: 0, name: 'All ranks', img: '' }];
  // tracklock.gg pro builds: /heroes/<slug>/probuild, slug = lowercase name, "&" -> "and", spaces -> "-".
  var TRACKLOCK_HEROES = 'https://tracklock.gg/heroes/';
  var TRACKLOCK_ALL = 'https://tracklock.gg/probuilds';
  function tracklockSlug(name) {
    return String(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  var NAME_ART_HEIGHT = 26;
  var DEFAULT_TITLE_COLOR = '#cbbca6';
  var BUILD_NAME_MAX = 34;     // characters before a build name is cut (full name on hover)
  var OPTION_NAME_MAX = 44;    // same, inside the build dropdown
  var PLAYER_NAME_MAX = 13;    // characters before a player name is cut (full name on hover)
  var GROUP_GAP = 14;
  var LABEL_CHAR = 7.4;        // rough width of one uppercase group-label character

  // Item groups are packed side by side; these mirror .BBItem / .BBBody in the stylesheet (normal and compact).
  function itemSlot() { return BB_SETTINGS.compact ? 42 : 48; }      // tile width + gap
  function lineWidth() { return BB_SETTINGS.compact ? 404 : 500; }   // usable width inside the bubble body

  var hudRoot = $.GetContextPanel();
  var ui = {};
  var cache = { listener: null, abilities: null, alive: null, shop: null };
  var state = {
    byHotkey: false,
    dismissed: false,
    autoOpen: false,
    visible: false,
    source: SOURCES.indexOf(BB_SETTINGS.defaultSource) >= 0 ? BB_SETTINGS.defaultSource : 'standard',
    heroId: '',
    heroVia: '',
    manualHeroId: '',
    brawl: false,
    picking: false,
    expanded: -1,                    // index of the expanded recent match, -1 for none
    timelinePage: 0,                 // page of the expanded match's item timeline
    matchPage: 0,                    // page of the recent pro matches
    buildIdx: { standard: 0, pro: 0 },
    menuOpen: false,                 // build dropdown
    menuPage: 0,                     // page of the build dropdown
    floor: META.defaultFloor != null ? META.defaultFloor : FLOORS[0].badge,   // win-rate rank floor
    floorMenu: false,
    settingsOpen: false,             // cog panel
    settingsRev: 0,                  // bumps whenever a setting changes so the panel redraws
    moving: null,                    // { dx, dy } while the bubble follows the cursor
    pos: null,                       // [x, y] once the user has placed the bubble
    buildNameFull: '',
    renderedKey: '',
    nextDetect: 0,
    clock: 0,
  };

  // ---------- small helpers ----------
  function log(m) { try { $.Msg(TAG + m); } catch (e) {} }
  function valid(p) { try { return !!(p && p.IsValid && p.IsValid()); } catch (e) { return false; } }
  function find(parent, id) { try { return valid(parent) ? parent.FindChildTraverse(id) : null; } catch (e) { return null; } }
  function has(p, cls) { try { return valid(p) && p.BHasClass(cls); } catch (e) { return false; } }
  function kids(p) { try { return p.Children() || []; } catch (e) { return []; } }
  function safeText(s) { s = String(s == null ? '' : s); return s.charAt(0) === '#' ? '​' + s : s; }
  function thousands(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function shortDate(ts) { var d = new Date(ts * 1000); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + String(d.getUTCFullYear()).slice(-2); }
  function clock(s) { s = Math.max(0, Math.round(s)); var m = Math.floor(s / 60), r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r; }
  function souls(n) { return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n); }
  function ago(ts) {
    var s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'hr ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function cut(s, max) { s = String(s || ''); return s.length > max ? s.slice(0, max - 1).replace(/\s+$/, '') + '…' : s; }
  function pct(x) { return Math.round(x * 1000) / 10 + '%'; }
  function dot() { return '  ·  '; }
  function setStyle(p, prop, value) { try { p.style[prop] = value; } catch (e) {} }

  function el(type, parent, cls, text) {
    var p = $.CreatePanel(type, parent, '');
    if (cls) { var list = cls.split(' '); for (var i = 0; i < list.length; i++) if (list[i]) p.AddClass(list[i]); }
    if (text != null && type === 'Label') p.text = safeText(text);
    return p;
  }
  function image(parent, cls, src) {
    var p = el('Image', parent, cls);
    if (src) setImage(p, src);
    return p;
  }
  function setImage(p, src) {
    try { p.SetImage(src); } catch (e) { setStyle(p, 'backgroundImage', 'url("' + src + '")'); }
  }
  function tooltip(p, text) {
    if (!text) return;
    p.SetPanelEvent('onmouseover', function () { showTip(p, text); });
    p.SetPanelEvent('onmouseout', function () { hideTip(p); });
  }

  // Our own tooltip, drawn above the bubble (the game's tooltip layer sits underneath it in the HUD).
  // It stays laid out while hidden (opacity only), so it can be measured and placed under the panel.
  var tip = { panel: null, label: null, owner: null, seq: 0 };
  function tipPanel() {
    if (tip.panel && tip.panel.IsValid()) return tip.panel;
    tip.panel = $.CreatePanel('Panel', hudRoot, 'BuildBubbleTip');
    tip.panel.AddClass('BBTip');
    tip.panel.hittest = false;
    tip.label = el('Label', tip.panel, 'BBTipText', '');
    return tip.panel;
  }
  function anchorOf(p) {
    var s = uiScale();
    try {
      var at = p.GetPositionWithinWindow();
      if (at && isFinite(at.x) && isFinite(at.y)) return { x: at.x / s[0], y: at.y / s[1], w: p.actuallayoutwidth / s[0], h: p.actuallayoutheight / s[1] };
    } catch (e) {}
    var c = cursorInLayout();
    return c ? { x: c[0], y: c[1], w: 0, h: 18 } : null;
  }
  // Centred under the panel, or above it when there's no room below; kept on screen.
  function placeTip(p, seq) {
    var box = tip.panel;
    if (seq !== tip.seq || !box || !box.IsValid()) return;
    var a = anchorOf(p), s = uiScale();
    if (!a) return;
    var w = box.actuallayoutwidth / s[0], h = box.actuallayoutheight / s[1];
    var sw = hudRoot.actuallayoutwidth / s[0], sh = hudRoot.actuallayoutheight / s[1];
    var x = a.x + a.w / 2 - w / 2, y = a.y + a.h + 6;
    if (sw > 0) x = Math.min(x, sw - w - 6);
    if (sh > 0 && y + h > sh - 6) y = a.y - h - 6;
    setStyle(box, 'position', Math.round(Math.max(6, x)) + 'px ' + Math.round(Math.max(6, y)) + 'px 0px');
    box.AddClass('BBTipShown');
  }
  // delay (seconds): show only once the mouse has rested that long; moving off cancels it.
  function showTip(p, text, delay) {
    var box = tipPanel();
    tip.owner = p;
    var seq = ++tip.seq;
    box.RemoveClass('BBTipShown');
    var show = function () {
      if (seq !== tip.seq) return;
      tip.label.text = safeText(text);
      $.Schedule(0, function () { placeTip(p, seq); });
      $.Schedule(0.05, function () { placeTip(p, seq); });
    };
    if (delay) $.Schedule(delay, show); else show();
  }
  // Full build names wait a moment, so they don't pop up every time the mouse passes over.
  var NAME_TIP_DELAY = 1.1;
  function slowTooltip(p, text) {
    p.SetPanelEvent('onmouseover', function () { showTip(p, text, NAME_TIP_DELAY); });
    p.SetPanelEvent('onmouseout', function () { hideTip(p); });
  }
  function hideTip(p) {
    if (p && tip.owner !== p) return;
    tip.seq++;
    tip.owner = null;
    if (tip.panel && tip.panel.IsValid()) tip.panel.RemoveClass('BBTipShown');
  }
  function onClick(p, fn) { p.SetPanelEvent('onactivate', fn); }
  // Drawn push-pin: round head and a needle, tilted (the game has no pin icon).
  function pinGlyph(parent, cls) {
    var icon = el('Panel', parent, 'BBPinIcon ' + (cls || ''));
    el('Panel', icon, 'BBPinHead');
    el('Panel', icon, 'BBPinNeedle');
    return icon;
  }
  // Opens a page in the Steam overlay browser, or the default browser when the overlay is off.
  function openUrl(url) {
    try { $.DispatchEvent('ExternalBrowserGoToURL', url); log('opened ' + url); return; } catch (e) {}
    try { SteamOverlayAPI.OpenExternalBrowserURL(url); log('opened ' + url); } catch (e2) { log('could not open ' + url); }
  }
  // Drawn calendar icon (outline with a filled top band) followed by a label.
  function calendarStat(parent, tip) {
    var stat = el('Panel', parent, 'BBStat');
    var cal = el('Panel', stat, 'BBCalIcon');
    el('Panel', cal, 'BBCalTop');
    var text = el('Label', stat, 'BBStatText', '');
    tooltip(stat, tip);
    return { stat: stat, text: text };
  }
  function starStat(parent, tip) {
    var stat = el('Panel', parent, 'BBStat');
    el('Label', stat, 'BBStarIcon', '★');
    var text = el('Label', stat, 'BBStatText', '');
    tooltip(stat, tip);
    return { stat: stat, text: text };
  }

  // Name logos range from nearly square (Rem, Pocket) to very wide (Haze, Paradox). One fixed height makes the
  // narrow ones look tiny, so size for similar visual weight: narrower logos get taller, within limits.
  function logoSize(aspect, base, maxH, maxW) {
    var h = Math.max(base * 0.75, Math.min(maxH, base * Math.pow(3 / aspect, 0.4)));
    var w = h * aspect;
    var capW = maxW || base * 7;
    if (w > capW) { w = capW; h = w / aspect; }
    return { w: Math.round(w), h: Math.round(h) };
  }
  // A hero's stylised name logo, tinted with their theme colour.
  function nameArt(parent, cls, h, base, maxH, maxW) {
    var art = image(parent, cls, h.nameArt);
    var size = logoSize(h.nameAspect, base, maxH, maxW);
    setStyle(art, 'width', size.w + 'px');
    setStyle(art, 'height', size.h + 'px');
    setStyle(art, 'washColor', h.color || DEFAULT_TITLE_COLOR);
    return art;
  }

  // ---------- hero detection ----------
  var HERO_IDS = Object.keys(BB_DATA.heroes);
  var ABILITY_TOKEN = {};  // ability icon basename -> hero id
  var HERO_STEM = [];      // [stem, heroId] from the hero portrait file name, longest first
  function baseName(src) {
    var m = /([^\/\\"')]+?)(?:_psd|_png)?(?:_[0-9a-f]{8})?\.(?:vtex_c|vtex|png|psd|vsvg)/i.exec(String(src || ''));
    return m ? m[1].toLowerCase() : '';
  }
  HERO_IDS.forEach(function (id) {
    var h = BB_DATA.heroes[id];
    h.keys.forEach(function (k) { if (k) ABILITY_TOKEN[k] = id; });
    var stem = baseName(h.img).replace(/_sm$/, '');
    if (stem) HERO_STEM.push([stem, id]);
  });
  HERO_STEM.sort(function (a, b) { return b[0].length - a[0].length; });

  function imageSrc(img) {
    var s = '';
    try { s = img.src || ''; } catch (e) {}
    if (!s) { try { s = img.GetAttributeString('src', '') || ''; } catch (e) {} }
    if (!s) { try { s = img.style.backgroundImage || ''; } catch (e) {} }
    return String(s || '');
  }

  // The crosshair progress panel carries the local hero's class (hero_inferno or inferno).
  function heroFromClass() {
    if (!valid(cache.alive)) cache.alive = find(hudRoot, 'gameplay_hud_alive');
    var cross = kids(cache.alive);
    for (var i = 0; i < cross.length; i++) {
      if (cross[i].id !== 'crosshair') continue;
      var inner = kids(cross[i]);
      for (var j = 0; j < inner.length; j++) {
        if (inner[j].id !== 'progress') continue;
        for (var k = 0; k < HERO_IDS.length; k++) {
          var cls = BB_DATA.heroes[HERO_IDS[k]].cls;
          if (has(inner[j], cls) || has(inner[j], cls.replace(/^hero_/, ''))) return HERO_IDS[k];
        }
      }
    }
    return '';
  }

  function collectImages(panel, depth, out) {
    if (!valid(panel) || depth > 8) return;
    var list = kids(panel);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === 'AbilityImage') out.push(list[i]);
      collectImages(list[i], depth + 1, out);
    }
  }

  function heroFromAbilities(debug) {
    if (!valid(cache.abilities)) cache.abilities = find(hudRoot, 'hud_signature');
    var imgs = [];
    collectImages(cache.abilities, 0, imgs);
    var votes = {}, best = '', seen = [];
    for (var i = 0; i < imgs.length; i++) {
      var b = baseName(imageSrc(imgs[i]));
      seen.push(b || '?');
      var id = ABILITY_TOKEN[b];
      if (id) { votes[id] = (votes[id] || 0) + 1; if (!best || votes[id] > votes[best]) best = id; }
    }
    if (debug) log('ability images: ' + (seen.join(', ') || 'none found'));
    return best;
  }

  function heroFromShop(debug) {
    if (!valid(cache.shop)) cache.shop = find(hudRoot, 'CitadelHudHeroShop');
    var img = find(find(cache.shop, 'HeroPanel'), 'HeroImage');
    var b = baseName(imageSrc(img));
    if (debug) log('shop hero image: ' + (b || 'none'));
    for (var i = 0; i < HERO_STEM.length; i++) {
      if (b === HERO_STEM[i][0] || b.indexOf(HERO_STEM[i][0] + '_') === 0) return HERO_STEM[i][1];
    }
    return '';
  }

  function detectHero(debug) {
    if (state.manualHeroId) return [state.manualHeroId, 'picked'];
    var id = heroFromClass();
    if (id) return [id, 'hud class'];
    id = heroFromAbilities(debug);
    if (id) return [id, 'ability icons'];
    id = heroFromShop(debug);
    if (id) return [id, 'shop portrait'];
    return ['', 'not detected'];
  }

  function refreshHero(force) {
    if (!force && state.clock < state.nextDetect) return;
    state.nextDetect = state.clock + (state.visible ? 1 : 5);
    var r = detectHero(force && !state.heroId);
    if (r[0] !== state.heroId) {
      if (state.heroId && r[0]) state.brawl = false;
      state.heroId = r[0];
      state.heroVia = r[1];
      state.expanded = -1;
      state.buildIdx = { standard: 0, pro: 0 };
      state.menuOpen = false;
      state.floorMenu = false;
      log('hero = ' + (r[0] ? BB_DATA.heroes[r[0]].name : 'unknown') + ' (' + r[1] + ')');
    }
  }

  // ---------- open / close ----------
  function readGlobalState() {
    if (!valid(cache.listener)) cache.listener = find(hudRoot, 'AbilitiesContainer');
    return {
      shop: has(cache.listener, 'gShopOpen') || has(hudRoot, 'gShopOpen'),
      draft: has(cache.listener, 'gItemDraftOpen') || has(hudRoot, 'gItemDraftOpen'),
    };
  }

  function setVisible(v) {
    if (v === state.visible) return;
    state.visible = v;
    if (v) { refreshHero(true); render(); } else { stopMove(); hideTip(); }
    ui.root.SetHasClass('BBShown', v);
    ui.root.hittest = v;
  }

  function toggle() {
    if (state.visible) {
      state.byHotkey = false;
      if (state.autoOpen) state.dismissed = true;
    } else {
      state.byHotkey = true;
      state.dismissed = false;
    }
    update();
  }

  function update() {
    var g = readGlobalState();
    if (g.draft) state.brawl = true;
    var auto = (BB_SETTINGS.autoShowShop && g.shop) || (BB_SETTINGS.autoShowDraft && g.draft);
    if (auto !== state.autoOpen) {
      state.autoOpen = auto;
      if (!auto) state.dismissed = false;
    }
    setVisible(state.byHotkey || (state.autoOpen && !state.dismissed));
    refreshHero(false);
    if (state.visible) render();
  }

  function tick() {
    state.clock += state.visible ? 0.2 : 0.35;
    try { update(); } catch (e) { log('tick error: ' + e); }
    $.Schedule(state.visible ? 0.2 : 0.35, tick);
  }

  // ---------- moving the bubble ----------
  // Press on an empty part of the header, drag, and release to drop. If the game can't report the mouse
  // button, a click picks the bubble up and the next click drops it.
  var drag = { overHeader: false, overControl: 0, wasDown: false, loop: false, native: false };
  function uiScale() {
    var sx = 1, sy = 1;
    try { sx = hudRoot.actualuiscale_x || 1; sy = hudRoot.actualuiscale_y || 1; } catch (e) {}
    return [sx, sy];
  }
  function cursorInLayout() {
    try {
      var c = GameUI.GetCursorPosition();
      var s = uiScale();
      return c ? [c[0] / s[0], c[1] / s[1]] : null;
    } catch (e) { return null; }
  }
  function rootPosition() {
    if (state.pos) return state.pos;
    var s = uiScale();
    try { return [ui.root.actualxoffset / s[0], ui.root.actualyoffset / s[1]]; } catch (e) { return [0, 0]; }
  }
  function placeRoot(x, y) {
    var s = uiScale(), maxX = 0, maxY = 0;
    try {
      maxX = hudRoot.actuallayoutwidth / s[0] - ui.root.actuallayoutwidth / s[0];
      maxY = hudRoot.actuallayoutheight / s[1] - 60;
    } catch (e) {}
    if (maxX > 0) x = Math.max(0, Math.min(x, maxX));
    if (maxY > 0) y = Math.max(0, Math.min(y, maxY));
    state.pos = [x, y];
    ui.root.AddClass('BBPlaced');
    setStyle(ui.root, 'position', Math.round(x) + 'px ' + Math.round(y) + 'px 0px');
  }
  function mouseDown() {
    try { return typeof GameUI.IsMouseDown === 'function' ? !!GameUI.IsMouseDown(0) : null; } catch (e) { return null; }
  }
  function follow() {
    var c = cursorInLayout();
    if (c && state.moving) placeRoot(c[0] - state.moving.dx, c[1] - state.moving.dy);
  }
  function startMove() {
    var c = cursorInLayout();
    if (!c) { log('moving is unavailable (no cursor position API)'); return false; }
    var at = rootPosition();
    state.moving = { dx: c[0] - at[0], dy: c[1] - at[1] };
    ui.root.AddClass('BBMoving');
    return true;
  }
  function stopMove() {
    var wasMoving = !!state.moving;
    state.moving = null;
    if (ui.root) ui.root.RemoveClass('BBMoving');
    if (wasMoving) savePlacement();
  }
  // Every frame while the cursor is over the header or a drag is running: a press that starts on the
  // header (not on one of its buttons) picks the bubble up, releasing the button drops it.
  function dragLoop() {
    var down = mouseDown();
    if (down === null) { drag.loop = false; return; }
    if (state.moving) {
      if (down) follow(); else stopMove();
    } else if (down && !drag.wasDown && drag.overHeader && !drag.overControl) {
      startMove();
    }
    drag.wasDown = down;
    if (state.moving || drag.overHeader) $.Schedule(0.016, dragLoop); else drag.loop = false;
  }
  function watchDrag() {
    if (drag.loop) return;
    drag.loop = true;
    drag.wasDown = !!mouseDown();
    dragLoop();
  }
  // Fallback when the game can't report the mouse button: click to pick up, click again to drop.
  function toggleMove() {
    if (drag.native || mouseDown() !== null) return;
    if (state.moving) { stopMove(); return; }
    if (startMove()) (function followEachFrame() { if (!state.moving) return; follow(); $.Schedule(0.016, followEachFrame); })();
  }
  // Header buttons: show their tooltip and keep a press on them from starting a drag.
  function controlTip(p, text) {
    p.SetPanelEvent('onmouseover', function () { drag.overControl++; if (text) showTip(p, text); });
    p.SetPanelEvent('onmouseout', function () { drag.overControl = Math.max(0, drag.overControl - 1); hideTip(p); });
  }

  // Preferred way to move: Panorama's own drag-and-drop on the header. The drag ghost (invisible) follows
  // the cursor, and each frame the bubble moves by as much as the ghost has. No cursor or mouse-button
  // API needed; the polling above is only the fallback when drag-and-drop is missing.
  var dnd = null;
  function ghostAt() {
    var s = uiScale();
    try {
      var p = dnd.ghost.GetPositionWithinWindow();
      if (p && isFinite(p.x) && isFinite(p.y)) return [p.x / s[0], p.y / s[1]];
    } catch (e) {}
    try {
      var x = dnd.ghost.actualxoffset, y = dnd.ghost.actualyoffset;
      if (isFinite(x) && isFinite(y)) return [x / s[0], y / s[1]];
    } catch (e2) {}
    return null;
  }
  // Samples the ghost each frame. A reading that jumps (the ghost reset to a corner, say) is ignored; good ones go into
  // a short trail so a drop can be placed where the mouse was let go.
  function moveWithGhost() {
    var at = ghostAt();
    dnd.frames++;
    if (!at || dnd.frames < 2) return;   // the ghost reaches the cursor a frame after the drag starts
    if (!dnd.start) { dnd.start = at; dnd.last = at; return; }
    if (Math.abs(at[0] - dnd.last[0]) + Math.abs(at[1] - dnd.last[1]) > 500) return;
    dnd.last = at;
    var pos = [dnd.from[0] + at[0] - dnd.start[0], dnd.from[1] + at[1] - dnd.start[1]];
    dnd.trail.push(pos);
    if (dnd.trail.length > 90) dnd.trail.shift();
    placeRoot(pos[0], pos[1]);
  }
  // Where the mouse was let go. An unaccepted drop slides the ghost straight back toward where the drag began, so walk
  // back over the trail while it was closing in on the start; the point before that is the release.
  function releasePoint() {
    var t = dnd.trail, i = t.length - 1;
    if (i < 1) return t[i] || null;
    var dist = function (p) { return Math.abs(p[0] - dnd.from[0]) + Math.abs(p[1] - dnd.from[1]); };
    while (i > 0 && dist(t[i - 1]) > dist(t[i]) + 0.5) i--;
    return t[i];
  }
  function followGhost() {
    if (!dnd || dnd.dropped) return;
    moveWithGhost();
    $.Schedule(0.016, followGhost);
  }
  function enableDrag(handle) {
    if (typeof handle.SetDraggable !== 'function' || typeof $.RegisterEventHandler !== 'function') return false;
    try {
      handle.SetDraggable(true);
      $.RegisterEventHandler('DragStart', handle, function (panelId, callbacks) {
        var ghost = $.CreatePanel('Panel', hudRoot, '');
        ghost.AddClass('BBDragGhost');
        ghost.hittest = false;
        callbacks.displayPanel = ghost;
        callbacks.offsetX = 0;
        callbacks.offsetY = 0;
        hideTip();
        dnd = { ghost: ghost, from: rootPosition(), start: null, last: null, frames: 0, dropped: false, trail: [] };
        ui.root.AddClass('BBMoving');
        followGhost();
        return true;
      });
      // Accept our own drop: Panorama slides the ghost of an unaccepted drop back to where the drag began,
      // and the bubble used to follow it home.
      // No new reading at the drop itself: by then the game may already have reset the ghost.
      var accept = function () {
        if (!dnd) return false;
        dnd.dropped = true;
        return true;
      };
      var hover = function () { return !!dnd; };
      [handle, ui.root].forEach(function (target) {
        $.RegisterEventHandler('DragEnter', target, hover);
        $.RegisterEventHandler('DragDrop', target, accept);
      });
      $.RegisterEventHandler('DragEnd', handle, function (panelId, dragged) {
        if (dnd && !dnd.dropped) {
          var back = releasePoint();
          if (back) placeRoot(back[0], back[1]);
          log('drag: drop was not accepted; placed where it was let go');
        }
        if (dnd && !dnd.start) log('drag: no ghost position reported');
        dnd = null;
        ui.root.RemoveClass('BBMoving');
        savePlacement();
        try { if (dragged && dragged.IsValid()) dragged.DeleteAsync(0); } catch (e) {}
        return true;
      });
      return true;
    } catch (e) {
      log('drag-and-drop unavailable: ' + e);
      return false;
    }
  }

  // ---------- data helpers ----------
  function rankText(kind) {
    var r = kind === 'pro' ? META.proRank : META.winrateRank;
    return r ? r + '+ matches' : 'all ranks';
  }
  function floorInfo(badge) {
    for (var i = 0; i < FLOORS.length; i++) if (FLOORS[i].badge === badge) return FLOORS[i];
    return FLOORS[0];
  }
  // A rank floor has enough win-rate data for a hero when it has an ability order and a handful of items to rank.
  var FLOOR_MIN_ITEMS = 8;
  function floorHasData(h, badge) {
    var w = h && h.winrates && h.winrates[badge];
    if (!w || !w.steps || !w.steps.length) return false;
    var n = 0;
    for (var i = 0; i < (w.items || []).length; i++) n += w.items[i][1].length;
    return n >= FLOOR_MIN_ITEMS;
  }
  // The floor shown for a hero: the chosen one, or when the hero lacks data there the nearest lower floor with data
  // (else the lowest with data). The choice stays, so heroes that have data at that floor still show it.
  function shownFloor(h) {
    if (!h || floorHasData(h, state.floor)) return state.floor;
    for (var i = FLOORS.length - 1; i >= 0; i--) if (FLOORS[i].badge < state.floor && floorHasData(h, FLOORS[i].badge)) return FLOORS[i].badge;
    for (var j = 0; j < FLOORS.length; j++) if (floorHasData(h, FLOORS[j].badge)) return FLOORS[j].badge;
    return state.floor;
  }

  // Win-rate data for the chosen rank floor (Street Brawl has its own, unfiltered).
  function winrateData(h) {
    if (state.brawl) return h.brawl;
    var all = h.winrates || {};
    return all[shownFloor(h)] || all[FLOORS[0].badge] || { items: [], steps: [], orderWr: 0, orderMatches: 0 };
  }

  // One-line note under the tabs, only where it adds something the header doesn't already say.
  function sourceNote(b) {
    if (b.source === 'pro-stats') return 'What ' + rankText('pro') + ' players buy (no pro build published)';
    return '';
  }

  // Pins: a pinned build shows first under Community, marked PINNED. Pins made in the bubble are kept in
  // Panorama's persistent storage (when the game provides it) and win over the manager's pinned build.
  var PIN_KEY = 'build_bubble_pins';
  var pins = loadPins();           // { heroId: buildId }; 0 = unpinned in the bubble
  function pinStore() { try { return $.persistentStorage || null; } catch (e) { return null; } }
  function loadPins() {
    try { var s = pinStore(); var raw = s && s.getItem(PIN_KEY); return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
  }
  function savePins() {
    try { var s = pinStore(); if (s) s.setItem(PIN_KEY, JSON.stringify(pins)); else log('pins last for this session (no persistent storage)'); }
    catch (e) { log('could not save pins: ' + e); }
  }

  // ---------- remembered placement ----------
  // Where the bubble was dragged to, and the screen side picked in the cog menu, survive restarts. They
  // only apply while the manager's own screen side is still the one they were saved over.
  var PLACE_KEY = 'build_bubble_place';
  var BAKED_POSITION = BB_SETTINGS.position;
  function loadPlacement() {
    try {
      var s = pinStore(), raw = s && s.getItem(PLACE_KEY), p = raw ? JSON.parse(raw) : null;
      return p && p.base === BAKED_POSITION ? p : null;
    } catch (e) { return null; }
  }
  function savePlacement() {
    try {
      var s = pinStore();
      if (s) s.setItem(PLACE_KEY, JSON.stringify({ base: BAKED_POSITION, side: BB_SETTINGS.position, pos: state.pos }));
    } catch (e) { log('could not save position: ' + e); }
  }

  // The hotkey and animations picked in the cog menu survive restarts too, while the manager's own values
  // are still the ones they replaced.
  var PREFS_KEY = 'build_bubble_prefs';
  var BAKED_PREFS = JSON.stringify([BB_SETTINGS.hotkey, BB_SETTINGS.animations !== false]);
  function savePrefs() {
    try {
      var s = pinStore();
      if (s) s.setItem(PREFS_KEY, JSON.stringify({ base: BAKED_PREFS, hotkey: BB_SETTINGS.hotkey, animations: BB_SETTINGS.animations !== false }));
    } catch (e) { log('could not save settings: ' + e); }
  }
  function loadPrefs() {
    try {
      var s = pinStore(), raw = s && s.getItem(PREFS_KEY), p = raw ? JSON.parse(raw) : null;
      if (!p || p.base !== BAKED_PREFS) return;
      if (typeof p.hotkey === 'string' && p.hotkey) BB_SETTINGS.hotkey = p.hotkey;
      if (typeof p.animations === 'boolean') BB_SETTINGS.animations = p.animations;
    } catch (e) {}
  }
  function pinnedId(h) {
    if (!h) return 0;
    if (Object.prototype.hasOwnProperty.call(pins, state.heroId)) return pins[state.heroId] || 0;
    var first = (h.standards || [])[0];
    return first && first.source === 'pinned' ? first.id : 0;
  }
  function withSource(b, source) { var c = {}; for (var k in b) c[k] = b[k]; c.source = source; return c; }
  function findBuild(h, id) {
    var all = (h.standards || []).concat(h.pros || []);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  function buildsFor(h, source) {
    if (!h) return [];
    var pid = pinnedId(h);
    if (source === 'standard') {
      var list = (h.standards || []).filter(function (b) { return b.id !== pid; })
        .map(function (b) { return b.source === 'pinned' ? withSource(b, 'community') : b; });
      var pinned = pid ? findBuild(h, pid) : null;
      if (pinned) list.unshift(withSource(pinned, 'pinned'));
      return list;
    }
    if (source === 'pro') return (h.pros || []).filter(function (b) { return b.id !== pid; });
    return [];
  }

  // Pin (or unpin) a build, then show it at the top of Community.
  function togglePin(b) {
    var h = BB_DATA.heroes[state.heroId];
    var pinnedNow = pinnedId(h) === b.id;
    pins[state.heroId] = pinnedNow ? 0 : b.id;
    savePins();
    log((pinnedNow ? 'unpinned ' : 'pinned ') + b.name);
    state.source = 'standard';
    state.buildIdx.standard = 0;
    state.menuOpen = false;
    settingChanged();
  }
  function currentBuild(h) {
    var list = buildsFor(h, state.source);
    if (!list.length) return null;
    return list[Math.min(state.buildIdx[state.source] || 0, list.length - 1)];
  }

  // ---------- change animations ----------
  // Each render is compared with the last one for the same hero. A piece that changed recesses (shrinks and
  // fades away) with its old look, then the new piece grows back out into the hole; unchanged pieces stay
  // put. Max-order icons that trade places arc past each other. One eased clock drives a render's changes.
  var CHANGE_S = 0.46;        // a whole change
  var RECESS_PART = 0.45;     // share of it spent recessing; the new piece grows over the rest
  var changes = { prev: null, next: null, base: null, list: [] };
  // Ease in-out (cubic): slow start, quick middle, soft landing.
  function smooth(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function scale3(s) { s = Math.max(0.001, s).toFixed(3); return 'scale3d( ' + s + ', ' + s + ', 1 )'; }
  // End of an animation: drop the inline transform and opacity so the stylesheet applies again. Leaving even an
  // identity transform set keeps the panel drawn as a separate layer, which clips the shadows of what's inside it.
  function settle(p) { setStyle(p, 'transform', null); setStyle(p, 'opacity', null); }
  function tween(seconds, step, done) {
    // Animations off (cog menu): every change lands on its end state at once.
    if (BB_SETTINGS.animations === false) { step(1); if (done) done(); return; }
    var start = Date.now();
    (function frame() {
      var t = Math.min(1, (Date.now() - start) / (seconds * 1000));
      step(t);
      if (t < 1) $.Schedule(0.016, frame); else if (done) done();
    })();
  }
  function change(p, fn, done) { changes.list.push({ p: p, fn: fn, done: done }); fn(0); }
  function recess(p) {
    change(p, function (t) {
      var k = smooth(Math.min(1, t / RECESS_PART));
      setStyle(p, 'transform', scale3(1 - k));
      setStyle(p, 'opacity', String(1 - k));
    }, function () { p.DeleteAsync(0); });
  }
  function emerge(p) {
    change(p, function (t) {
      var k = smooth(Math.max(0, (t - RECESS_PART) / (1 - RECESS_PART)));
      setStyle(p, 'transform', scale3(k));
      setStyle(p, 'opacity', String(Math.min(1, k * 1.5)));
    }, function () { settle(p); });
  }
  // Glide home from dx pixels away along an arc: rightward travellers pass over, leftward ones under.
  function arcHome(p, dx) {
    var lift = dx < 0 ? 12 : -12;
    change(p, function (t) {
      var k = smooth(t);
      setStyle(p, 'transform', 'translate3d( ' + (dx * (1 - k)).toFixed(1) + 'px, ' + (-lift * Math.sin(Math.PI * k)).toFixed(1) + 'px, 0px )');
    }, function () { settle(p); });
  }
  // Portrait pop: grows from 40% with a slight overshoot (ease-out-back).
  var popSeq = 0, portraitFace = null, pickerOpen = false;
  function backOut(t) { var c = 1.4; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
  function popIn(p) {
    var seq = ++popSeq;
    tween(0.36, function (t) {
      if (seq !== popSeq || !p.IsValid()) return;
      setStyle(p, 'transform', scale3(0.4 + 0.6 * backOut(t)));
      setStyle(p, 'opacity', String(Math.min(1, t * 3)));
    });
  }
  // Hero picker tiles slide in from the left, row after row (and a touch later along each row).
  function slideIn(list, perRow) {
    var ROW_DELAY = 0.045, COL_DELAY = 0.02, DUR = 0.3, DIST = 36;
    var total = DUR + ROW_DELAY * Math.ceil(list.length / perRow) + COL_DELAY * perRow;
    tween(total, function (t) {
      var now = t * total;
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p.IsValid()) continue;
        var k = smooth(Math.max(0, Math.min(1, (now - Math.floor(i / perRow) * ROW_DELAY - (i % perRow) * COL_DELAY) / DUR)));
        setStyle(p, 'transform', 'translate3d( ' + (-DIST * (1 - k)).toFixed(1) + 'px, 0px, 0px )');
        setStyle(p, 'opacity', String(k));
      }
    });
  }
  // Morph: a clipping wrapper whose width eases down while the old content retracts, then up while the new content
  // expands, so whatever sits beside it slides along. Widths are measured once laid out (a frame after creation).
  function widthOf(p) {
    try { var w = p.actuallayoutwidth / uiScale()[0]; return w > 0 ? w : null; } catch (e) { return null; }
  }
  function morph(wrap, oldBody, newBody) {
    var w0 = null, w1 = null;
    if (newBody && oldBody) newBody.SetHasClass('BBHidden', true);
    if (!oldBody) setStyle(wrap, 'maxWidth', '0px');
    change(wrap, function (t) {
      if (oldBody && t < RECESS_PART) {
        if (w0 === null) w0 = widthOf(oldBody);
        if (w0 === null) return;
        var k = smooth(t / RECESS_PART);
        setStyle(wrap, 'maxWidth', (w0 * (1 - k)).toFixed(1) + 'px');
        setStyle(wrap, 'opacity', String(1 - k));
        return;
      }
      if (oldBody) {
        // Halfway: the old content goes, the new one starts from nothing.
        if (oldBody.IsValid()) oldBody.DeleteAsync(0);
        oldBody = null;
        if (newBody) newBody.SetHasClass('BBHidden', false);
        setStyle(wrap, 'maxWidth', '0px');
        return;
      }
      if (!newBody) return;
      if (w1 === null) w1 = widthOf(newBody);
      if (w1 === null) return;
      var k2 = smooth(Math.max(0, (t - RECESS_PART) / (1 - RECESS_PART)));
      setStyle(wrap, 'maxWidth', (w1 * k2).toFixed(1) + 'px');
      setStyle(wrap, 'opacity', String(Math.min(1, k2 * 1.4)));
    }, function () {
      if (oldBody && oldBody.IsValid()) oldBody.DeleteAsync(0);
      if (!newBody) { wrap.DeleteAsync(0); return; }
      newBody.SetHasClass('BBHidden', false);
      setStyle(wrap, 'maxWidth', '2000px');
      setStyle(wrap, 'opacity', '1');
    });
  }

  // Section-head stats as slots that morph across tab and build switches: lead (Top WR win rate and matches),
  // a (rank floor, or the build's favourites), b (calendar: lookback window, or the build's last update). Each slot
  // is { kind, text, build(parent, oldText) }. Between slots of the same kind the slot stays put with its icon and
  // only the text retracts and expands; between different kinds the whole slot retracts and the new one expands;
  // a slot that appears or goes away slides in or out.
  var HEAD_SLOTS = ['lead', 'a', 'b'];
  function slotBody(wrap, slot, oldText) { var body = el('Panel', wrap, 'BBSlotBody'); slot.build(body, oldText); return body; }
  function headSlots(head, slots) {
    var track = !!(changes.next && !changes.next.head);
    if (track) changes.next.head = slots;
    var base = track && changes.base && changes.base.head;
    HEAD_SLOTS.forEach(function (name) {
      var now = slots[name], was = base && base[name];
      if (!now && !was) return;
      var wrap = el('Panel', head, 'BBMorph');
      if (!base || (now && was && now.kind === was.kind)) { if (now) slotBody(wrap, now, base && was ? was.text : null); return; }
      morph(wrap, was ? slotBody(wrap, was) : null, now ? slotBody(wrap, now) : null);
    });
  }
  // Text that retracts and expands into its new value when it changed (plain label otherwise).
  function morphText(parent, cls, text, oldText, oldCls, oldColor) {
    if (oldText == null || (oldText === text && (!oldCls || oldCls === cls))) return el('Label', parent, cls, text);
    var wrap = el('Panel', parent, 'BBMorph');
    var old = el('Label', wrap, oldCls || cls, oldText);
    if (oldColor) setStyle(old, 'color', oldColor);
    var label = el('Label', wrap, cls, text);
    morph(wrap, old, label);
    return label;
  }
  // Icon + text stat (favs: star, cal: calendar); the icon stays while its text morphs.
  function statSlot(kind, text, tip) {
    return { kind: kind, text: text, build: function (p, oldText) {
      var stat = el('Panel', p, 'BBStat');
      if (kind === 'favs') el('Label', stat, 'BBStarIcon', '★');
      else el('Panel', el('Panel', stat, 'BBCalIcon'), 'BBCalTop');
      morphText(stat, 'BBStatText', text, oldText);
      tooltip(stat, tip);
    } };
  }
  function labelSlot(kind, cls, text) {
    return { kind: kind, text: text, build: function (p, oldText) {
      if (changes.floorSwitch && oldText != null && oldText !== text) countText(el('Label', p, cls, text), oldText, text);
      else morphText(p, cls, text, oldText);
    } };
  }

  // Group names (item tiers, build sections) retract and expand into their new text when they change.
  function catName(block, key, text) {
    var wrap = el('Panel', block, 'BBMorph');
    var base = changes.base && changes.base.cats;
    if (changes.next) changes.next.cats[key] = text;
    var was = base ? base[key] : undefined;
    if (!base || !changes.next || was === text) { el('Label', wrap, 'BBCatName', text); return; }
    morph(wrap, was != null ? el('Label', wrap, 'BBCatName', was) : null, el('Label', wrap, 'BBCatName', text));
  }

  // Every number in a text counts from its old value to its new one (keeping decimals and thousands commas) when
  // both texts have the same shape; otherwise the new text simply shows.
  function numberParts(s) { return String(s).split(/(\d[\d,]*(?:\.\d+)?)/); }
  function countText(label, oldText, newText) {
    var a = numberParts(oldText), b = numberParts(newText);
    var same = a.length === b.length && a.every(function (p, i) { return i % 2 === 1 || p === b[i]; });
    if (!same) { label.text = newText; return; }
    change(label, function (t) {
      var k = smooth(t);
      label.text = b.map(function (p, i) {
        if (i % 2 === 0) return p;
        var from = parseFloat(a[i].replace(/,/g, '')), to = parseFloat(p.replace(/,/g, ''));
        var s = (from + (to - from) * k).toFixed((p.split('.')[1] || '').length);
        return /,/.test(p + a[i]) ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : s;
      }).join('');
    }, function () { label.text = newText; });
  }
  function mixHex(a, b, k) {
    var out = '#';
    for (var i = 1; i < 7; i += 2) {
      var v = Math.round(parseInt(a.substr(i, 2), 16) * (1 - k) + parseInt(b.substr(i, 2), 16) * k);
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
  }
  function lerpColor(label, from, to) {
    if (!/^#[0-9a-f]{6}$/i.test(from) || !/^#[0-9a-f]{6}$/i.test(to)) { setStyle(label, 'color', to); return; }
    change(label, function (t) { setStyle(label, 'color', mixHex(from, to, smooth(t))); }, function () { setStyle(label, 'color', to); });
  }
  // Grows in over the second half of a change with a slight overshoot (for icons that pop in).
  function emergePop(p) {
    change(p, function (t) {
      var k = Math.max(0, (t - RECESS_PART) / (1 - RECESS_PART));
      setStyle(p, 'transform', scale3(k > 0 ? backOut(k) : 0));
      setStyle(p, 'opacity', String(Math.min(1, k * 2)));
    }, function () { settle(p); });
  }

  // The number under an item: stays put when unchanged; on a rank-floor switch it counts to its new value and its
  // colour slides along the win-rate gradient; otherwise it retracts and expands into the new number.
  function itemNumber(tile, slot, cls, text, color) {
    var was = slot != null && changes.base && changes.base.nums ? changes.base.nums[slot] : null;
    if (slot != null && changes.next) changes.next.nums[slot] = { text: text, cls: cls, color: color };
    var label;
    if (!was || (was.text === text && was.cls === cls)) {
      label = el('Label', tile, cls, text);
      if (color) {
        if (was && was.color && was.color !== color && changes.floorSwitch) lerpColor(label, was.color, color);
        else setStyle(label, 'color', color);
      }
      return label;
    }
    if (changes.floorSwitch && was.cls === cls) {
      label = el('Label', tile, cls, text);
      countText(label, was.text, text);
      if (color) { if (was.color) lerpColor(label, was.color, color); else setStyle(label, 'color', color); }
      return label;
    }
    label = morphText(tile, cls, text, was.text, was.cls, was.color);
    if (color) setStyle(label, 'color', color);
    return label;
  }

  function beginChanges() {
    changes.next = { hero: state.heroId, skills: null, maxed: null, items: {}, hasItems: false, head: null, cats: {}, nums: {},
      source: state.source, floor: shownFloor(BB_DATA.heroes[state.heroId]), brawl: state.brawl };
    changes.base = changes.prev;
    var b0 = changes.base;
    changes.floorSwitch = !!(b0 && b0.hero === state.heroId && b0.source === 'winrate' && state.source === 'winrate' &&
      b0.brawl === state.brawl && b0.floor !== changes.next.floor);
    changes.list = [];
  }
  function endChanges() {
    if (changes.next.skills || changes.next.hasItems || changes.next.head) changes.prev = changes.next;
    changes.next = null;
    var list = changes.list;
    changes.list = [];
    if (!list.length) return;
    tween(CHANGE_S, function (t) {
      for (var i = 0; i < list.length; i++) { try { if (list[i].p.IsValid()) list[i].fn(t); } catch (e) {} }
    }, function () {
      for (var i = 0; i < list.length; i++) { try { if (list[i].p.IsValid() && list[i].done) list[i].done(); } catch (e) {} }
    });
  }

  // ---------- items ----------
  function renderItemTile(parent, id, note, stat, statTip, statColor, slot) {
    var it = BB_DATA.items[id];
    if (!it) return;
    var tile = el('Panel', parent, 'BBItem ' + (SLOT_CLASS[it[2]] || '') + ' BBT' + (it[3] || 1));
    // The icon sits in a holder of its own size, so a change can stack the outgoing icon on top of it.
    var holder = el('Panel', tile, 'BBItemSlot');
    // As in the shop: a rough-edge mask cuts into the card, with the paper texture laid over it.
    var icon = image(holder, 'BBItemIcon BBWear' + wearOf(id), it[4]);
    el('Panel', holder, 'BBCardPaper BBWear' + wearOf(id) + ' BBPaper' + (1 + variant(id, 1, 3)) + wearTurn(id, 2)).hittest = false;
    el('Panel', holder, 'BBCardScuff BBWear' + wearOf(id) + ' BBScuff' + (1 + variant(id, 3, 3)) + wearTurn(id, 4)).hittest = false;
    el('Panel', holder, 'BBCardEdge BBEdge' + (1 + variant(id, 5, 3)) + wearTurn(id, 6) + ' BBDepth' + variant(id, 7, 3)).hittest = false;
    tierCorner(holder, it[3], it[2]);
    // Top WR keeps its win rate under the card; the tier shows as the card's corner tab (no souls cost).
    if (stat) itemNumber(tile, slot, 'BBItemStat', stat, statColor);
    // The whole card shows the tooltip: its layers (corner tab, worn edges, the number) don't take the mouse.
    tile.hittestchildren = false;
    tooltip(tile, it[0] + '  (' + thousands(it[1]) + ' souls)' + (statTip ? '\n' + statTip : '') + (note ? '\n\n' + note : ''));
    if (slot != null) animateItem(holder, icon, slot, id);
  }
  // Slots are "group:position"; the same item in the same slot as last time stays still.
  function animateItem(holder, icon, slot, id) {
    if (!changes.next) return;
    changes.next.items[slot] = id;
    changes.next.hasItems = true;
    var base = changes.base;
    if (!base || !base.hasItems || base.items[slot] === id) return;
    var old = base.items[slot] && BB_DATA.items[base.items[slot]];
    if (old) {
      var ghost = el('Panel', holder, 'BBItemGhost ' + (SLOT_CLASS[old[2]] || '') + ' BBT' + (old[3] || 1));
      ghost.hittest = false;
      image(ghost, 'BBItemIcon BBWear' + wearOf(base.items[slot]), old[4]).hittest = false;
      recess(ghost);
    }
    emerge(icon);
  }

  // Tier corner tab, as on the shop's cards: a category-coloured cap in the top-right corner with the tier numeral.
  var ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
  var CAP_COLOR = { w: '#e3973c', v: '#7bbf45', s: '#b67cf0' };
  function tierCorner(holder, tier, slot) {
    var cap = el('Panel', holder, 'BBTierCap');
    cap.hittest = false;
    // The shop's own corner cap (a white triangle filling the top-right corner), tinted by category; a drawn one
    // only if the image is missing.
    if (ICONS.tierCap) setStyle(image(cap, 'BBTierCapImg', ICONS.tierCap), 'washColor', CAP_COLOR[slot] || CAP_COLOR.w);
    else el('Panel', cap, 'BBTierCapShape');
    el('Label', cap, 'BBTierNum', ROMAN[tier] || '');
  }

  // Item groups sit side by side while they fit on a line; a group is never split across lines
  // (one wider than a whole line gets its own line and wraps inside it).
  function packGroups(parent, groups) {
    var line = null, used = 0;
    var slot = itemSlot(), width = lineWidth();
    var perLine = Math.floor(width / slot);
    groups.forEach(function (g, gi) {
      var w = Math.min(width, Math.max(Math.min(g.count, perLine) * slot, Math.ceil(g.label.length * LABEL_CHAR)));
      var startLine = !line || used + GROUP_GAP + w > width;
      if (startLine) { line = el('Panel', parent, 'BBCatLine'); used = 0; }
      var block = el('Panel', line, 'BBCat');
      setStyle(block, 'width', w + 'px');
      if (!startLine) { setStyle(block, 'marginLeft', GROUP_GAP + 'px'); used += GROUP_GAP; }
      used += w;
      if (g.label) catName(block, gi, g.label);
      g.fill(el('Panel', block, 'BBItemRow'));
    });
  }

  function renderBuildItems(parent, build) {
    packGroups(parent, build.cats.map(function (cat, ci) {
      return {
        label: cat[0],
        count: cat[1].length,
        fill: function (row) { for (var j = 0; j < cat[1].length; j++) renderItemTile(row, cat[1][j][0], cat[1][j][1] || '', '', '', '', ci + ':' + j); },
      };
    }));
  }

  // Red (lowest) -> amber -> green (highest), scaled to the win rates shown in one view.
  var GRADIENT = [[255, 92, 80], [255, 206, 110], [120, 214, 104]];
  function gradientColor(t) {
    t = Math.max(0, Math.min(1, t));
    var seg = t < 0.5 ? 0 : 1, local = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    var a = GRADIENT[seg], b = GRADIENT[seg + 1], hex = '#';
    for (var i = 0; i < 3; i++) { var v = Math.round(a[i] + (b[i] - a[i]) * local); hex += (v < 16 ? '0' : '') + v.toString(16); }
    return hex;
  }

  function renderStatItems(parent, table) {
    var lo = 1, hi = 0;
    for (var i = 0; i < table.length; i++) {
      for (var k = 0; k < table[i][1].length; k++) { var w = table[i][1][k][1]; if (w < lo) lo = w; if (w > hi) hi = w; }
    }
    var span = hi - lo;
    packGroups(parent, table.map(function (tier, ti) {
      var rows = tier[1];
      return {
        label: '',   // the cards' corner tabs show the tier
        count: rows.length,
        fill: function (row) {
          for (var j = 0; j < rows.length; j++) {
            var wr = rows[j][1];
            renderItemTile(row, rows[j][0], '', Math.round(wr * 100) + '%',
              pct(wr) + ' win rate over ' + thousands(rows[j][2]) + ' matches',
              gradientColor(span > 0 ? (wr - lo) / span : 1), ti + ':' + j);
          }
        },
      };
    }));
  }

  // ---------- ability order ----------
  // Ability icon on a dark plate. A few icons are black silhouettes (flagged by gen-data), so the image
  // alone is washed cream; the plate behind it stays dark.
  var DARK_ICON_WASH = '#e9e3d8';
  // Wear: each icon gets one of the shop's three rough-edge masks (picked by id, so it always looks the same).
  function wearOf(id) { return 1 + (Math.abs(Number(id) || 0) % 3); }
  // A fixed "random" pick per item and layer: every card's damage differs, but never changes between renders.
  function variant(id, salt, n) { return Math.floor(Math.abs(Number(id) || 0) / (1 + salt * 131)) % n; }
  // Classes that turn / flip a wear layer (one of eight) and set how deep the worn edge goes (one of three).
  function wearTurn(id, salt) { return ' BBTurn' + variant(id, salt, 8); }
  function abilityIcon(parent, cls, ab) {
    // The wear mask goes on the image, not the plate: a mask on the plate also cut off its drop shadow (once the
    // mask texture had loaded, i.e. from the second render on).
    var plate = el('Panel', parent, cls);
    plate.hittestchildren = false;   // the plate as a whole takes the mouse, so its tooltip shows anywhere over it
    var img = image(plate, 'BBAbilityImg BBWear' + wearOf(ab[0]), ab[2]);
    if (ab[3]) setStyle(img, 'washColor', DARK_ICON_WASH);
    el('Panel', plate, 'BBCardEdge BBEdge' + (1 + variant(ab[0], 5, 3)) + wearTurn(ab[0], 6) + ' BBDepth' + variant(ab[0], 7, 3)).hittest = false;
    return plate;
  }

  // Width of the ability grid: icon column, then one cell per ability point (18px + 2px gap, compact 15px + 2px),
  // capped at the line (cells then shrink to share it).
  function skillGridWidth(steps) {
    var compact = BB_SETTINGS.compact;
    return Math.min(lineWidth(), (compact ? 20 : 24) + steps * ((compact ? 15 : 18) + 2) - 2);
  }

  // Grid: one row per ability, one column per ability point in the order you spend them; then the order
  // abilities reach tier 3, as icons joined by double chevrons.
  function renderSkills(parent, h, steps) {
    if (!steps || !steps.length) { el('Label', parent, 'BBEmpty', 'No ability order for this hero yet.'); return; }
    // An unlock and three upgrades for each of four abilities: 16 points at most.
    if (steps.length > 16) steps = steps.slice(0, 16);
    // Grid and max order share a block as wide as the grid, so the max order centres under it.
    var skillWrap = el('Panel', parent, 'BBSkillWrap');
    setStyle(skillWrap, 'width', skillGridWidth(steps.length) + 'px');
    // The first grid of a render is the main one: it is compared with the last render and animated.
    var track = !!(changes.next && !changes.next.skills);
    if (track) changes.next.skills = {};
    var grid = el('Panel', skillWrap, 'BBSkillGrid');
    var head = el('Panel', grid, 'BBSkillRow BBSkillHead');
    el('Panel', head, 'BBSkillIconSpacer');
    for (var n = 0; n < steps.length; n++) el('Label', el('Panel', head, 'BBSkillCell BBSkillStep'), 'BBSkillStepText', String(n + 1));
    for (var a = 0; a < 4; a++) {
      var row = el('Panel', grid, 'BBSkillRow');
      var ab = h.abilities[a];
      var icon = abilityIcon(row, 'BBSkillIcon', ab);
      tooltip(icon, (a + 1) + '. ' + ab[1]);
      for (var s = 0; s < steps.length; s++) {
        var mine = steps[s][0] === a;
        var cell = el('Panel', row, 'BBSkillCell' + (mine ? ' BBSkillOn' : ''));
        var fill = mine ? skillFill(cell, steps[s][1]) : null;
        if (track) animateSkill(cell, fill, a + ':' + s, mine ? steps[s][1] : -1);
      }
    }
    var maxed = [];
    for (var k = 0; k < steps.length; k++) if (steps[k][1] === 3) maxed.push(steps[k][0]);
    var oldMax = track && changes.base && changes.base.maxed;
    if (track) changes.next.maxed = maxed.slice();
    if (!maxed.length) return;
    var order = el('Panel', skillWrap, 'BBMaxOrder');
    for (var m = 0; m < maxed.length; m++) {
      if (m) {
        var chev = el('Panel', order, 'BBChevron');
        el('Panel', chev, 'BBChevronStroke BBChevronBack');
        el('Panel', chev, 'BBChevronStroke BBChevronFront');
      }
      var ab2 = h.abilities[maxed[m]];
      // The slot moves when the order changes; the plate inside grows on hover.
      var maxSlot = el('Panel', order, 'BBMaxSlot');
      var plate = abilityIcon(maxSlot, 'BBMaxIcon', ab2);
      tooltip(plate, ab2[1]);
      if (oldMax) {
        var from = changes.base.hero === state.heroId ? oldMax.indexOf(maxed[m]) : -1;
        if (from < 0) emerge(maxSlot);
        else if (from !== m) arcHome(maxSlot, (from - m) * maxStride());
      }
    }
  }

  // A filled ability cell: a piece carrying the tier colour and number.
  function skillFill(cell, tier) {
    var fill = el('Panel', cell, 'BBSkillFill BBTier' + tier);
    el('Label', fill, 'BBSkillCellText', tier === 0 ? '●' : String(tier));
    return fill;
  }
  // Cell "ability:step" holds a tier (or -1 when empty); a cell that holds the same as last time stays filled.
  function animateSkill(cell, fill, key, tier) {
    if (tier >= 0) changes.next.skills[key] = tier;
    var base = changes.base && changes.base.skills;
    if (!base) return;
    var was = key in base ? base[key] : -1;
    if (was === tier) return;
    if (was >= 0) { var ghost = skillFill(cell, was); ghost.hittest = false; recess(ghost); }
    if (fill) emerge(fill);
  }
  // Distance between max-order icons: icon plus the chevron between (compact sizes when compact).
  function maxStride() { return BB_SETTINGS.compact ? 46 : 58; }

  // Section: optional title, underlined; returns the body panel.
  function section(parent, title) {
    var s = el('Panel', parent, 'BBSection');
    if (title) el('Label', el('Panel', s, 'BBSectionHead'), 'BBSectionTitle', title);
    return s;
  }

  // Win-rate rank floor dropdown: just the rank badge ("All" has none); names live in the tooltips so
  // every floor from Ritualist to Eternus fits on one line.
  function floorTip(f) { return f.badge ? 'Matches averaging ' + f.name.replace(/\+$/, '') + ' or higher' : 'Matches at all ranks'; }
  function floorFace(parent, f) {
    if (!f.img) return el('Label', parent, 'BBFloorName', f.name);
    // The badge with its drop stroke: a white copy behind it, in one stack.
    var stack = el('Panel', parent, 'BBBadgeStack');
    setStyle(image(stack, 'BBFloorBadge BBDropCopy', f.img), 'washColor', '#ffffff');
    image(stack, 'BBFloorBadge', f.img);
    return stack;
  }
  // oldFloor (from the last render): after a floor switch the old icon pops out and the new one pops in.
  function floorPicker(parent, oldFloor) {
    var shown = shownFloor(BB_DATA.heroes[state.heroId]);
    var f = floorInfo(shown);
    var btn = el('Button', parent, 'BBFloorPicker' + (state.floorMenu ? ' BBMenuOpen' : ''));
    var line = el('Panel', btn, 'BBFloorLine');
    var faceBox = el('Panel', line, 'BBFloorFaceBox');
    var face = floorFace(faceBox, f);
    if (oldFloor != null && oldFloor !== String(shown) && changes.next) {
      var ghost = floorFace(faceBox, floorInfo(Number(oldFloor)));
      ghost.hittest = false;
      recess(ghost);
      emergePop(face);
    }
    el('Panel', line, 'BBBuildCaret');
    onClick(btn, function () { state.floorMenu = !state.floorMenu; render(); });
  }
  // Rank floor menu: eases open under the stats line, and folds shut when a floor is picked or it is closed.
  var floorFold = { open: false, height: 0, seq: 0 };
  var FLOOR_MENU_H = 46;   // one row of 34px options with 6px above and below
  function floorMenu(parent) {
    var menu = el('Panel', parent, 'BBFloorMenu');
    setStyle(menu, 'height', floorFold.height.toFixed(1) + 'px');
    var hero = BB_DATA.heroes[state.heroId], shown = shownFloor(hero);
    FLOORS.forEach(function (f) {
      // Floors without enough data for this hero are greyed out and can't be picked.
      var ok = floorHasData(hero, f.badge);
      var opt = el('Button', menu, 'BBFloorOption' + (f.badge === shown ? ' Active' : '') + (ok ? '' : ' Disabled'));
      floorFace(el('Panel', el('Panel', opt, 'BBOptStack'), 'BBFloorOptFace'), f);
      tooltip(opt, ok ? floorTip(f) : 'Not enough data');
      onClick(opt, function () { if (!ok) return; state.floor = f.badge; state.floorMenu = false; render(); });
    });
    // The body is rebuilt on every render, so a fold still under way carries on in the new menu.
    var open = !!state.floorMenu, target = open ? FLOOR_MENU_H : 0;
    if (open !== floorFold.open || Math.abs(floorFold.height - target) > 0.5) fold(floorFold, menu, open, target);
  }

  // Highest win-rate ability order: stats line (win rate, matches, rank floor dropdown), then the grid.
  function renderWinrateSkills(h) {
    var wr = winrateData(h);
    var s = el('Panel', ui.body, 'BBSection');
    var head = el('Panel', s, 'BBSectionHead');
    var slots = {};
    if (wr.orderMatches) slots.lead = labelSlot('lead', 'BBSectionStat', pct(wr.orderWr) + ' WR' + dot() + thousands(wr.orderMatches) + ' matches' + dot());
    if (state.brawl) slots.a = labelSlot('brawl', 'BBSectionStat', 'Street Brawl');
    else slots.a = { kind: 'floor', text: String(shownFloor(h)), build: floorPicker };
    // Lookback window, to the right of the rank floor: the same calendar slot as a build's date on the other tabs.
    slots.b = statSlot('cal', LOOKBACK_DAYS + 'd', 'Matches from the last ' + LOOKBACK_DAYS + ' days');
    headSlots(head, slots);
    if (!state.brawl && (state.floorMenu || floorFold.open || floorFold.height > 0.5)) floorMenu(s);
    renderSkills(s, h, wr.steps);
    return wr.steps;
  }

  // ---------- recent pro matches ----------
  function smallItem(parent, id, cls, tip) {
    var it = BB_DATA.items[id];
    if (!it) return null;
    var icon = image(parent, cls + ' ' + (SLOT_CLASS[it[2]] || '') + ' BBT' + (it[3] || 1) + ' BBWear' + wearOf(id), it[4]);
    tooltip(icon, it[0] + (tip ? '\n' + tip : ''));
    return icon;
  }

  // Item timeline pager: "1-10 of 23", arrows, and page dots (the current one a wider pill).
  var TIMELINE_PAGE = 10;
  function pager(parent, page, pages, total, go, per, tips) {
    per = per || TIMELINE_PAGE;
    tips = tips || ['Earlier purchases', 'Later purchases'];
    var bar = el('Panel', parent, 'BBPager');
    var first = page * per + 1, last = Math.min(total, (page + 1) * per);
    el('Label', bar, 'BBPagerLabel', first + '\u2013' + last + ' of ' + total);
    var prev = el('Panel', bar, 'BBPagerArrow BBPagerPrev' + (page === 0 ? ' Disabled' : ''));
    el('Panel', prev, 'BBPagerChevron');
    tooltip(prev, tips[0]);
    // The page turns just after the click: the render rebuilds the pager, the clicked button included.
    var turn = function (p) { $.Schedule(0, function () { go(p); }); };
    onClick(prev, function () { if (page > 0) turn(page - 1); });
    for (var p = 0; p < pages; p++) {
      (function (target) {
        var dotBtn = el('Panel', bar, 'BBPagerDot' + (target === page ? ' Active' : ''));
        el('Panel', dotBtn, 'BBPagerDotMark');
        onClick(dotBtn, function () { if (target !== page) turn(target); });
      })(p);
    }
    var next = el('Panel', bar, 'BBPagerArrow BBPagerNext' + (page >= pages - 1 ? ' Disabled' : ''));
    el('Panel', next, 'BBPagerChevron');
    tooltip(next, tips[1]);
    onClick(next, function () { if (page < pages - 1) turn(page + 1); });
  }

  function renderMatchDetail(parent, h, m) {
    var detail = el('Panel', parent, 'BBMatchDetail');
    var pages = Math.max(1, Math.ceil(m.tl.length / TIMELINE_PAGE));
    var page = Math.min(state.timelinePage, pages - 1);
    var head = el('Panel', detail, 'BBDetailHead');
    el('Label', head, 'BBDetailTitle', 'ITEM TIMELINE');
    if (pages > 1) pager(head, page, pages, m.tl.length, function (p) { state.timelinePage = p; render(); });
    var line = el('Panel', detail, 'BBTimeline');
    var end = Math.min(m.tl.length, (page + 1) * TIMELINE_PAGE);
    for (var i = page * TIMELINE_PAGE; i < end; i++) {
      var ev = m.tl[i];
      var cell = el('Panel', line, 'BBTimelineItem');
      var icon = smallItem(cell, ev[1], 'BBTimelineIcon', 'Bought ' + clock(ev[0]) + (ev[2] ? '  ·  sold ' + clock(ev[2]) : ''));
      if (!icon) continue;
      if (ev[2]) icon.AddClass('BBSold');
      el('Label', cell, 'BBTimelineTime', clock(ev[0]));
    }
    el('Label', detail, 'BBDetailTitle', 'ABILITY BUILD');
    renderSkills(detail, h, m.st);
  }

  // Recent pro matches, five to a page with a pager in the heading. Turning the page slides the rows in; opening
  // a match eases its details open (measured once laid out) and closing one folds them shut.
  var MATCH_PAGE = 5;
  var matchView = { key: '', open: -1, page: -1 };
  function contentHeight(box) {
    try {
      var c = box.Children()[0];
      var hgt = c ? c.actuallayoutheight / uiScale()[1] : 0;
      return hgt > 0 ? hgt : null;
    } catch (e) { return null; }
  }
  function foldOpen(box) {
    var full = null;
    setStyle(box, 'height', '0px');
    tween(FOLD_S + 0.06, function (t) {
      if (!box.IsValid()) return;
      if (full === null) { full = contentHeight(box); if (full === null) return; }
      setStyle(box, 'height', (full * smooth(t)).toFixed(1) + 'px');
    }, function () { if (box.IsValid()) setStyle(box, 'height', 'fit-children'); });
  }
  function foldShut(box) {
    var from = null;
    box.hittest = false;
    tween(FOLD_S, function (t) {
      if (!box.IsValid()) return;
      if (from === null) { from = contentHeight(box); if (from === null) return; }
      setStyle(box, 'height', (from * (1 - smooth(t))).toFixed(1) + 'px');
    }, function () { if (box.IsValid()) box.DeleteAsync(0); });
  }
  function renderRecentMatches(h) {
    var list = h.recent || [];
    if (!list.length) return;
    var s = el('Panel', ui.body, 'BBSection');
    var head = el('Panel', s, 'BBSectionHead');
    el('Label', head, 'BBSectionTitle BBFill', 'RECENT PRO MATCHES');
    var pages = Math.max(1, Math.ceil(list.length / MATCH_PAGE));
    var page = Math.min(state.matchPage, pages - 1);
    if (pages > 1) {
      pager(head, page, pages, list.length, function (p) { state.matchPage = p; state.expanded = -1; render(); },
        MATCH_PAGE, ['Newer matches', 'Older matches']);
    }
    // Compared with the last time this list was drawn: a page turn, or a match opened or closed.
    var key = state.heroId + '|' + state.source;
    var turned = matchView.key === key && matchView.page !== page;
    var wasOpen = matchView.key === key && !turned ? matchView.open : -1;
    matchView = { key: key, open: state.expanded, page: page };
    var cards = [];
    for (var idx = page * MATCH_PAGE; idx < Math.min(list.length, (page + 1) * MATCH_PAGE); idx++) cards.push(matchCard(s, h, list[idx], idx, wasOpen));
    if (turned) slideIn(cards, 1);
  }
  function matchCard(s, h, m, idx, wasOpen) {
    var open = state.expanded === idx;
    var card = el('Panel', s, 'BBMatch' + (m.w ? '' : ' BBLoss') + (open ? ' BBExpanded' : ''));
    var row = el('Button', card, 'BBMatchRow');
    onClick(row, function () { state.expanded = open ? -1 : idx; state.timelinePage = 0; render(); });

    var res = el('Panel', row, 'BBMatchResult');
    el('Label', res, 'BBMatchWin', m.w ? 'WIN' : 'LOSS');
    el('Label', res, 'BBMatchAgo', ago(m.t));

    var player = el('Label', row, 'BBMatchPlayer', cut(m.n, PLAYER_NAME_MAX));
    if (m.n.length > PLAYER_NAME_MAX) tooltip(player, m.n);

    var kda = el('Panel', row, 'BBMatchKda');
    el('Label', kda, 'BBMatchKdaLine', m.k + '/' + m.de + '/' + m.a);
    el('Label', kda, 'BBMatchKdaRatio', (Math.round((m.k + m.a) / Math.max(1, m.de) * 100) / 100).toFixed(2) + ' KDA');

    var items = el('Panel', row, 'BBMatchItems');
    for (var i = 0; i < m.fi.length; i++) smallItem(items, m.fi[i], 'BBMatchItem', '');

    // Souls: the soul icon and the amount (the word when the icon is missing).
    var soulsCol = el('Panel', row, 'BBMatchSouls');
    var soulsLine = el('Panel', soulsCol, 'BBMatchSoulsLine');
    if (ICONS.soul) image(soulsLine, 'BBSoulIcon', ICONS.soul);
    el('Label', soulsLine, 'BBMatchSoulsText', souls(m.nw) + (ICONS.soul ? '' : ' souls'));
    el('Label', soulsCol, 'BBMatchTime', clock(m.d));

    var toggleBox = el('Panel', row, 'BBMatchToggle');
    el('Panel', toggleBox, 'BBMatchChevron');

    if (open) {
      var box = el('Panel', card, 'BBFoldBox');
      renderMatchDetail(box, h, m);
      if (wasOpen !== idx) foldOpen(box);
    } else if (wasOpen === idx) {
      var shut = el('Panel', card, 'BBFoldBox');
      renderMatchDetail(shut, h, m);
      foldShut(shut);
    }
    return card;
  }

  // ---------- header ----------
  // Title: the hero's stylised name logo tinted with their theme colour, or their name in that colour.
  var NAME_LABEL_H = 30;   // the text hero name (no logo art)
  function renderTitle(h, hidden) {
    var color = (h && h.color) || DEFAULT_TITLE_COLOR;
    var art = h && h.nameArt && h.nameAspect ? h.nameArt : '';
    ui.heroNameArt.SetHasClass('BBHidden', !art);
    ui.heroName.SetHasClass('BBHidden', !!art);
    if (art) {
      var size = logoSize(h.nameAspect, BB_SETTINGS.compact ? 22 : NAME_ART_HEIGHT, BB_SETTINGS.compact ? 26 : 32);
      setImage(ui.heroNameArt, art);
      setStyle(ui.heroNameArt, 'width', size.w + 'px');
      setStyle(ui.heroNameArt, 'height', size.h + 'px');
      setStyle(ui.heroNameArt, 'washColor', color);
    }
    ui.heroName.text = safeText(h ? h.name : 'Build Bubble');
    setStyle(ui.heroName, 'color', color);
    var target = hidden ? 0 : art ? size.h - 2 : NAME_LABEL_H;
    if (target !== nameFold.target) { nameFold.target = target; fold(nameFold, ui.nameBox, target > 0, target, true); }
  }

  // Build name line: long names are cut, the full name shows on hover.
  function setBuildName(text) {
    state.buildNameFull = String(text || '');
    ui.buildName.text = safeText(cut(state.buildNameFull, BUILD_NAME_MAX));
  }

  // Top WR has no build, so the header shows just the hero.
  function renderWinrateHeader() {
    ui.buildRow.SetHasClass('BBRowGone', true);
    state.buildNameFull = '';
  }

  // Tab and build switches: the build name wraps shut, the content changes, then the new name unwraps.
  var NAME_WRAP_S = 0.2;
  function unwrapTo(change) {
    if (BB_SETTINGS.animations === false) { change(); render(); return; }
    ui.buildPicker.AddClass('BBNameWrap');
    $.Schedule(NAME_WRAP_S, function () {
      change();
      render();
      $.Schedule(0.03, function () { ui.buildPicker.RemoveClass('BBNameWrap'); });
    });
  }
  function switchTab(src) {
    if (src === state.source && !state.picking) return;
    unwrapTo(function () {
      state.source = src;
      state.picking = false;
      state.expanded = -1;
      // The build list stays open between Community and Pro (its rows morph); Top WR has no builds.
      state.menuOpen = state.menuOpen && (src === 'standard' || src === 'pro');
      if (state.menuOpen) state.menuPage = Math.floor((state.buildIdx[src] || 0) / MENU_PAGE);
      state.floorMenu = false;
      floorFold = { open: false, height: 0, seq: floorFold.seq + 1 };
      matchView.key = '';
    });
  }

  // Build dropdown: the builds for this tab, each with its stars and date, six to a page with a pager below.
  var MENU_PAGE = 6;
  var MENU_MAX_H = 300;   // the dropdown's max-height in the stylesheet
  function renderBuildMenu(h) {
    var list = buildsFor(h, state.source);
    var open = state.menuOpen && list.length > 1 && !state.picking;
    ui.buildPicker.SetHasClass('BBMenuOpen', open);
    ui.buildCaret.SetHasClass('BBHidden', list.length < 2);
    if (!open) {
      if (menuFold.open) foldMenu(false);
      return;
    }
    ui.buildMenu.RemoveAndDeleteChildren();
    if (!menuFold.open) setStyle(ui.buildMenu, 'height', menuFold.height.toFixed(1) + 'px');
    ui.buildMenu.SetHasClass('BBHidden', false);
    var inner = el('Panel', ui.buildMenu, 'BBMenuInner');
    var pages = Math.max(1, Math.ceil(list.length / MENU_PAGE));
    var page = Math.min(state.menuPage, pages - 1);
    // With the list already open (tab switch or page turn), each row's name, favourites and date retract and expand
    // into the new build's values; the icons stay put.
    var oldRows = menuFold.open && changes.base && changes.base.menu ? changes.base.menu : null;
    var rows = [];
    list.forEach(function (b, idx) {
      if (Math.floor(idx / MENU_PAGE) !== page) return;
      var active = idx === Math.min(state.buildIdx[state.source] || 0, list.length - 1);
      var opt = el('Button', inner, 'BBBuildOption' + (active ? ' Active' : ''));
      if (b.source === 'pinned') pinGlyph(opt, 'BBPinMark');
      var row = { name: cut(b.name, OPTION_NAME_MAX), favs: b.favs ? thousands(b.favs) : null,
        date: b.updated && b.source !== 'pro-stats' ? shortDate(b.updated) : null };
      var was = oldRows ? oldRows[rows.length] || {} : {};
      rows.push(row);
      var name = morphText(el('Panel', opt, 'BBOptNameBox'), 'BBBuildOptionName', row.name, oldRows ? was.name || '' : null);
      if (b.name.length > OPTION_NAME_MAX) slowTooltip(name, b.name);
      var stats = el('Panel', opt, 'BBBuildStats');
      if (row.favs) statSlot('favs', row.favs, 'Favourites').build(stats, was.favs);
      if (row.date) statSlot('cal', row.date, 'Last updated').build(stats, was.date);
      if (b.id) {
        var pinned = b.source === 'pinned';
        var pinBtn = el('Panel', opt, 'BBPinButton' + (pinned ? ' On' : ''));
        pinGlyph(pinBtn);
        onClick(pinBtn, function () { togglePin(b); });
      }
      onClick(opt, function () { unwrapTo(function () { state.buildIdx[state.source] = idx; state.menuOpen = false; }); });
    });
    if (changes.next) changes.next.menu = rows;
    if (pages > 1) {
      pager(el('Panel', inner, 'BBMenuPager'), page, pages, list.length,
        function (p) { state.menuPage = p; render(); }, MENU_PAGE, ['Previous builds', 'More builds']);
    }
    // Opening eases to the list's measured height; while open it fits its content (a page turn included).
    if (!menuFold.open) foldMenu(true);
    else {
      setStyle(ui.buildMenu, 'height', 'fit-children');
      $.Schedule(0.03, function () { var hgt = contentHeight(ui.buildMenu); if (hgt !== null) menuFold.height = Math.min(hgt, MENU_MAX_H); });
    }
  }

  // Dropdowns (build list, settings) ease their height open and shut; the content stays while it folds away.
  var FOLD_S = 0.26;
  var menuFold = { open: false, height: 0, seq: 0 };
  var settingsFold = { open: false, height: 0, seq: 0 };
  var nameFold = { open: false, height: 0, seq: 0, target: -1 };
  // Like fold(), for content whose height is only known once laid out: opening eases to the measured height and
  // then fits the content; closing eases from the current height to nothing.
  function foldMeasured(f, panel, open, measure) {
    var seq = ++f.seq, from = f.height, to = open ? null : 0;
    f.open = open;
    panel.AddClass('BBFolding');
    tween(FOLD_S, function (t) {
      if (seq !== f.seq || !panel.IsValid()) return;
      if (to === null) { to = measure(); if (to === null) return; }
      f.height = from + (to - from) * smooth(t);
      setStyle(panel, 'height', f.height.toFixed(1) + 'px');
    }, function () {
      if (seq !== f.seq || !panel.IsValid()) return;
      panel.RemoveClass('BBFolding');
      if (open) setStyle(panel, 'height', 'fit-children');
      else { panel.SetHasClass('BBHidden', true); panel.RemoveAndDeleteChildren(); f.height = 0; }
    });
  }
  function fold(f, panel, open, target, keep) {
    var seq = ++f.seq, from = f.height;
    f.open = open;
    panel.AddClass('BBFolding');
    tween(FOLD_S, function (t) {
      if (seq !== f.seq || !panel.IsValid()) return;
      f.height = from + (target - from) * smooth(t);
      setStyle(panel, 'height', f.height.toFixed(1) + 'px');
    }, function () {
      if (seq !== f.seq || !panel.IsValid()) return;
      panel.RemoveClass('BBFolding');
      if (!open && !keep) { panel.SetHasClass('BBHidden', true); panel.RemoveAndDeleteChildren(); }
    });
  }
  function foldMenu(open) {
    foldMeasured(menuFold, ui.buildMenu, open, function () {
      var hgt = contentHeight(ui.buildMenu);
      return hgt === null ? null : Math.min(hgt, MENU_MAX_H);
    });
  }

  // ---------- settings (cog) ----------
  // Changes apply straight away and last for this game session; the manager keeps them permanently.
  function settingChanged() { state.settingsRev++; render(); }

  function toggleRow(label, on, apply) {
    var row = el('Button', ui.settings, 'BBSettingRow');
    el('Label', row, 'BBSettingLabel', label);
    var sw = el('Panel', row, 'BBToggle' + (on ? ' On' : ''));
    el('Panel', sw, 'BBToggleKnob');
    onClick(row, function () { apply(!on); settingChanged(); });
  }

  function choiceRow(label, options, current, apply) {
    var row = el('Panel', ui.settings, 'BBSettingRow');
    el('Label', row, 'BBSettingLabel', label);
    var seg = el('Panel', row, 'BBSeg');
    options.forEach(function (o) {
      var btn = el('Button', seg, 'BBSegOption' + (o[0] === current ? ' Active' : ''));
      el('Label', btn, 'BBSegText', o[1]);
      onClick(btn, function () { if (o[0] !== current) { apply(o[0]); settingChanged(); } });
    });
  }

  function renderSettings() {
    ui.cogBtn.SetHasClass('BBActive', state.settingsOpen);
    if (!state.settingsOpen) {
      if (settingsFold.open) fold(settingsFold, ui.settings, false, 0);
      return;
    }
    ui.settings.RemoveAndDeleteChildren();
    if (!settingsFold.open) setStyle(ui.settings, 'height', settingsFold.height.toFixed(1) + 'px');
    ui.settings.SetHasClass('BBHidden', false);
    toggleRow('Open with the shop', !!BB_SETTINGS.autoShowShop, function (v) { BB_SETTINGS.autoShowShop = v; });
    toggleRow('Open in the Street Brawl draft', !!BB_SETTINGS.autoShowDraft, function (v) { BB_SETTINGS.autoShowDraft = v; });
    toggleRow('Compact', !!BB_SETTINGS.compact, function (v) { BB_SETTINGS.compact = v; ui.root.SetHasClass('BBCompact', v); });
    toggleRow('Animations', BB_SETTINGS.animations !== false, function (v) {
      BB_SETTINGS.animations = v;
      ui.root.SetHasClass('BBNoAnim', !v);
      savePrefs();
    });
    choiceRow('Screen side', [['left', 'Left'], ['right', 'Right']], BB_SETTINGS.position === 'right' ? 'right' : 'left',
      function (v) { BB_SETTINGS.position = v; state.pos = null; savePlacement(); $.Schedule(0, rebuild); });
    choiceRow('Default tab', SOURCES.map(function (s) { return [s, SOURCE_LABEL[s]]; }), BB_SETTINGS.defaultSource,
      function (v) { BB_SETTINGS.defaultSource = v; state.source = v; });
    hotkeyRow();
    // Rows (34px, compact 30px) plus the panel's 2px + 10px padding.
    var target = ui.settings.Children().length * (BB_SETTINGS.compact ? 30 : 34) + 12;
    if (!settingsFold.open) fold(settingsFold, ui.settings, true, target);
    else { settingsFold.height = target; setStyle(ui.settings, 'height', target + 'px'); }
  }

  // Rebuild the bubble in place (used when it moves to the other side of the screen).
  function rebuild() {
    state.pos = null;
    build();
    ui.root.SetHasClass('BBShown', state.visible);
    ui.root.hittest = state.visible;
    state.renderedKey = '';
    render();
  }

  function setMeta(text) {
    ui.meta.text = text || '';
    ui.meta.SetHasClass('BBHidden', !text);
  }

  function renderPicker(body, slide) {
    if (!state.heroId) el('Label', body, 'BBEmpty', "Couldn't detect your hero. Pick one:");
    // Explicit fixed-height rows: in-game, right-wrap stacked the tall tiles on top of each other.
    var grid = el('Panel', body, 'BBPicker');
    // Seven to a row; the tiles share the row's width, and the last row is padded so its tiles keep the same size.
    var perRow = 7;
    var row = null, tiles = [];
    HERO_IDS.slice().sort(function (a, b) { return BB_DATA.heroes[a].name < BB_DATA.heroes[b].name ? -1 : 1; }).forEach(function (id, n) {
      var hero = BB_DATA.heroes[id];
      if (n % perRow === 0) row = el('Panel', grid, 'BBPickRow');
      var btn = el('Button', row, 'BBPick' + (id === state.heroId ? ' Active' : ''));
      tiles.push(btn);
      // The portrait in a holder, cut by the shop's rough-edge mask (a cut-out, so nothing laid over it).
      var face = el('Panel', btn, 'BBPickFace');
      image(face, 'BBPickIcon BBWear' + wearOf(id), hero.img);
      // Drop stroke: a white copy of the name sits behind it, a little down and to the right. It lights up on hover
      // and for the current hero; the name in front keeps its colour.
      var nameStack = el('Panel', btn, 'BBNameStack');
      if (hero.nameArt && hero.nameAspect) {
        var artMaxW = BB_SETTINGS.compact ? 50 : 64;
        setStyle(nameArt(nameStack, 'BBPickArt BBDropCopy', hero, 16, 24, artMaxW), 'washColor', '#ffffff');
        nameArt(nameStack, 'BBPickArt', hero, 16, 24, artMaxW);
      } else {
        var name = el('Label', nameStack, 'BBPickName', hero.name);
        if (hero.color) setStyle(name, 'color', hero.color);
      }
      onClick(btn, function () { state.manualHeroId = id; state.picking = false; state.heroId = ''; refreshHero(true); render(); });
    });
    for (var pad = tiles.length % perRow ? perRow - tiles.length % perRow : 0; pad > 0; pad--) {
      el('Panel', row, 'BBPick BBPickSpacer').hittest = false;
    }
    if (slide) slideIn(tiles, perRow);
  }

  function render() {
    var key = [state.heroId, state.source, state.brawl, state.picking, state.expanded,
      state.buildIdx.standard, state.buildIdx.pro, state.menuOpen, state.floor, state.floorMenu,
      state.settingsOpen, state.settingsRev, state.timelinePage, state.menuPage, state.matchPage].join('|');
    if (key === state.renderedKey) return;
    state.renderedKey = key;
    beginChanges();
    try { renderView(); } finally { endChanges(); }
    styleScrollbars();
  }

  // ---------- scrollbars ----------
  // In-game the game's own scrollbar rules (dark track, grey thumb with a light top / dark right border) kept winning
  // over our stylesheet, so the body's and build list's scrollbars are styled from script: inline styles beat every
  // stylesheet rule. Track and thumb both fade out toward their ends; the thumb glows beige while the mouse is on the bar.
  var SCROLL_TRACK = 'gradient( linear, 0% 0%, 0% 100%, from( #ffffff00 ), color-stop( 0.18, #ffffff0a ), color-stop( 0.82, #ffffff0a ), to( #ffffff00 ) )';
  var SCROLL_THUMB = 'gradient( linear, 0% 0%, 0% 100%, from( #cbbca600 ), color-stop( 0.22, #cbbca666 ), color-stop( 0.78, #cbbca666 ), to( #cbbca600 ) )';
  var SCROLL_GLOW = 'gradient( linear, 0% 0%, 0% 100%, from( #e9dcc600 ), color-stop( 0.22, #e9dcc6d9 ), color-stop( 0.78, #e9dcc6d9 ), to( #e9dcc600 ) )';
  var scrollLogged = false;
  function thumbLook(thumb, lit) {
    setStyle(thumb, 'backgroundColor', lit ? SCROLL_GLOW : SCROLL_THUMB);
    setStyle(thumb, 'boxShadow', lit ? '#e3d3b640 0px 0px 6px 0px' : 'none');
  }
  // A panel's scrollbar only exists once its content overflows; each new one is styled once (marked by a class).
  function styleScrollbar(scroller) {
    var bar = find(scroller, 'VerticalScrollBar');
    if (!valid(bar) || has(bar, 'BBScrollStyled')) return;
    var thumb = null;
    try { bar.Children().forEach(function (c) { if (!thumb && has(c, 'ScrollThumb')) thumb = c; }); } catch (e) {}
    bar.AddClass('BBScrollStyled');
    setStyle(bar, 'width', '6px');
    setStyle(bar, 'marginRight', '4px');
    setStyle(bar, 'borderRadius', '3px');
    setStyle(bar, 'backgroundColor', SCROLL_TRACK);
    setStyle(bar, 'boxShadow', 'none');
    if (thumb) {
      setStyle(thumb, 'width', '6px');
      setStyle(thumb, 'borderRadius', '3px');
      setStyle(thumb, 'borderTop', '0px solid #00000000');
      setStyle(thumb, 'borderRight', '0px solid #00000000');
      thumbLook(thumb, false);
      bar.SetPanelEvent('onmouseover', function () { if (valid(thumb)) thumbLook(thumb, true); });
      bar.SetPanelEvent('onmouseout', function () { if (valid(thumb)) thumbLook(thumb, false); });
    }
    if (!scrollLogged) { scrollLogged = true; log('scrollbar styled' + (thumb ? '' : ' (no thumb found)')); }
  }
  // Looked for just after layout, and again once a dropdown has finished easing open.
  function styleScrollbars() {
    var run = function () { styleScrollbar(ui.body); styleScrollbar(ui.buildMenu); };
    $.Schedule(0.05, run);
    $.Schedule(FOLD_S + 0.1, run);
  }

  function renderView() {
    var h = BB_DATA.heroes[state.heroId];
    // While picking, the header is just a "?" portrait: the hero name and the build line fold away.
    var picking = !h || state.picking;
    var justOpened = picking && !pickerOpen, justClosed = !picking && pickerOpen;
    pickerOpen = picking;
    if (h) ui.heroIcon.SetImage(h.img);
    ui.heroIcon.SetHasClass('BBHidden', picking);
    ui.heroQuestion.SetHasClass('BBHidden', !picking);
    var face = picking ? '?' : state.heroId;
    if (face !== portraitFace) { portraitFace = face; popIn(picking ? ui.heroQuestion : ui.heroIcon); }
    renderTitle(h, picking);
    ui.modeTag.SetHasClass('BBHidden', !state.brawl);
    for (var t = 0; t < SOURCES.length; t++) ui.tabs[SOURCES[t]].SetHasClass('Active', SOURCES[t] === state.source);

    hideTip();
    ui.body.RemoveAndDeleteChildren();
    // Leaving the hero picker: a copy of it folds shut at the top while the hero's view slides up beneath.
    if (justClosed) {
      var pickerGhost = el('Panel', ui.body, 'BBFoldBox');
      pickerGhost.hittest = false;
      renderPicker(el('Panel', pickerGhost, 'BBPickerGhost'), false);
      foldShut(pickerGhost);
    }
    setMeta('');
    ui.buildPin.SetHasClass('BBHidden', true);
    ui.buildRow.SetHasClass('BBRowGone', false);
    renderSettings();
    renderBuildMenu(h);
    if (picking) {
      ui.buildRow.SetHasClass('BBRowGone', true);
      state.buildNameFull = '';
      renderPicker(ui.body, justOpened);
      return;
    }

    if (state.source === 'winrate') {
      renderWinrateHeader();
      renderWinrateSkills(h);
      var wr = winrateData(h);
      var items = section(ui.body, 'ITEMS');
      if (wr.items.length) renderStatItems(items, wr.items); else el('Label', items, 'BBEmpty', 'Not enough matches yet.');
      return;
    }

    var b = currentBuild(h);
    if (!b) {
      setBuildName('No ' + SOURCE_LABEL[state.source].toLowerCase() + ' build yet');
      renderWinrateSkills(h);
      el('Label', ui.body, 'BBEmpty', 'Nothing published for this hero yet. Try the other tabs.');
      if (state.source === 'pro') renderRecentMatches(h);
      return;
    }
    setBuildName(b.name);
    ui.buildPin.SetHasClass('BBHidden', b.source !== 'pinned');
    setMeta(sourceNote(b));

    // Community and Pro both follow the chosen build's own ability order, headed by the build's favourites and
    // last-updated date. A build without an ability order shows the win-rate one under that same heading (the rank
    // dropdown belongs to Top WR only).
    var order = el('Panel', ui.body, 'BBSection');
    var orderHead = el('Panel', order, 'BBSectionHead');
    var slots = {};
    if (b.favs) slots.a = statSlot('favs', thousands(b.favs), 'Favourites');
    if (b.updated && b.source !== 'pro-stats') slots.b = statSlot('cal', shortDate(b.updated), 'Last updated');
    if (!slots.a && !slots.b) slots.a = labelSlot('title', 'BBSectionTitle', 'ABILITY ORDER');
    headSlots(orderHead, slots);
    renderSkills(order, h, b.steps.length ? b.steps : winrateData(h).steps);
    renderBuildItems(section(ui.body, b.source === 'pro-stats' ? 'MOST BOUGHT BY TIER' : 'ITEMS'), b);
    if (b.desc) el('Label', section(ui.body, "AUTHOR'S NOTES"), 'BBNotes', b.desc);
    if (state.source === 'pro') renderRecentMatches(h);
  }

  // ---------- construction ----------
  // A round header button with an icon from the game's own art (or a text fallback).
  function iconButton(parent, cls, icon, fallback, tip) {
    var wear = { BBTrackButton: 1, BBCogButton: 2 }[cls] || 3;
    var btn = el('Button', parent, 'BBIconButton ' + cls + ' BBWear' + wear);
    if (icon) image(btn, 'BBIconImg', icon);
    else el('Label', btn, 'BBIconText', fallback);
    controlTip(btn, tip);
    return btn;
  }

  function build() {
    var old = hudRoot.FindChildTraverse('BuildBubbleRoot');
    if (old) old.DeleteAsync(0);
    hideTip();
    menuFold = { open: false, height: 0, seq: menuFold.seq + 1 };
    settingsFold = { open: false, height: 0, seq: settingsFold.seq + 1 };
    nameFold = { open: false, height: 0, seq: nameFold.seq + 1, target: -1 };
    portraitFace = null;

    // Left of the screen by default, with the speech-bubble tail pointing toward the middle.
    var onLeft = BB_SETTINGS.position !== 'right';
    ui.root = $.CreatePanel('Panel', hudRoot, 'BuildBubbleRoot');
    ui.root.AddClass('BBRoot');
    ui.root.SetHasClass('BBNoAnim', BB_SETTINGS.animations === false);
    ui.root.AddClass(onLeft ? 'BBLeft' : 'BBRight');
    if (BB_SETTINGS.compact) ui.root.AddClass('BBCompact');
    ui.root.hittest = false;

    if (!onLeft) el('Panel', ui.root, 'BBTail BBTailLeft');
    var frame = el('Panel', ui.root, 'BBFrame');
    if (onLeft) el('Panel', ui.root, 'BBTail BBTailRight');

    // Paper creases and light scuffs first, so the portrait, names and buttons sit on top of them. The header has no
    // padding of its own (in-game, full-size layers only cover a panel's area inside its padding); the row inside it
    // holds the padding and everything else, and is also what you drag the bubble by.
    var headerBox = el('Panel', frame, 'BBHeader');
    el('Panel', headerBox, 'BBCrease').hittest = false;
    var header = el('Panel', headerBox, 'BBHeaderRow');
    header.SetPanelEvent('onmouseover', function () { drag.overHeader = true; if (!drag.native) watchDrag(); });
    header.SetPanelEvent('onmouseout', function () { drag.overHeader = false; });
    onClick(header, toggleMove);
    drag.native = enableDrag(header);
    if (!drag.reported) {
      drag.reported = true;
      log('moving: ' + (drag.native ? 'drag-and-drop' : 'no drag-and-drop (SetDraggable ' + typeof header.SetDraggable +
        ', RegisterEventHandler ' + typeof $.RegisterEventHandler + ', GameUI ' + typeof GameUI + ')'));
    }
    var heroBtn = el('Button', header, 'BBHeroButton');
    ui.heroIcon = image(heroBtn, 'BBHeroIcon', '');
    ui.heroQuestion = el('Label', heroBtn, 'BBHeroQuestion BBHidden', '?');
    controlTip(heroBtn, '');
    // Opens the hero picker; pressed again with nothing picked, it closes it and goes back to auto-detect.
    onClick(heroBtn, function () {
      if (state.picking || !BB_DATA.heroes[state.heroId]) {
        state.manualHeroId = '';
        state.picking = false;
        state.heroId = '';
        refreshHero(true);
      } else {
        state.picking = true;
      }
      state.menuOpen = false;
      render();
    });
    var titles = el('Panel', header, 'BBTitles');
    titles.hittest = false;
    // Hero name (logo art, or text when there is none) in a box that folds away while picking a hero.
    ui.nameBox = el('Panel', titles, 'BBNameBox');
    ui.nameBox.hittest = false;
    setStyle(ui.nameBox, 'height', '0px');
    ui.heroNameArt = image(ui.nameBox, 'BBHeroNameArt BBHidden', '');
    ui.heroNameArt.hittest = false;
    ui.heroName = el('Label', ui.nameBox, 'BBHeroName', 'Build Bubble');
    ui.heroName.hittest = false;

    // Build line: the build name is a dropdown of the tab's other builds.
    ui.buildRow = el('Panel', titles, 'BBBuildRow');
    // The name line tilts on hover and its text takes a white shadow (strongest while the dropdown is open).
    // A plain panel rather than a Button: the game draws its own outline around a hovered or focused Button.
    ui.buildPicker = el('Panel', ui.buildRow, 'BBBuildPicker');
    var buildLine = el('Panel', ui.buildPicker, 'BBBuildLine');
    ui.buildPin = pinGlyph(buildLine, 'BBPinMark BBHeaderPin BBHidden');
    ui.buildName = el('Label', buildLine, 'BBBuildName', '');
    ui.buildCaret = el('Panel', buildLine, 'BBBuildCaret BBHidden');
    ui.buildPicker.SetPanelEvent('onmouseover', function () {
      drag.overControl++;
      if (state.buildNameFull.length > BUILD_NAME_MAX) showTip(ui.buildPicker, state.buildNameFull, NAME_TIP_DELAY);
    });
    ui.buildPicker.SetPanelEvent('onmouseout', function () {
      drag.overControl = Math.max(0, drag.overControl - 1);
      hideTip(ui.buildPicker);
    });
    onClick(ui.buildPicker, function () {
      var count = buildsFor(BB_DATA.heroes[state.heroId], state.source).length;
      if (count < 2) return;
      state.menuOpen = !state.menuOpen;
      // Open on the page holding the build on show.
      if (state.menuOpen) state.menuPage = Math.floor(Math.min(state.buildIdx[state.source] || 0, count - 1) / MENU_PAGE);
      state.settingsOpen = false;
      render();
    });

    ui.modeTag = el('Label', header, 'BBModeTag BBHidden', 'STREET BRAWL');

    // tracklock.gg for the hero on screen, settings cog, close.
    var track = iconButton(header, 'BBTrackButton', ICONS.logo, 'TL', 'Open pro builds for this hero on tracklock.gg');
    onClick(track, function () {
      var hero = BB_DATA.heroes[state.heroId];
      openUrl(hero ? TRACKLOCK_HEROES + tracklockSlug(hero.name) + '/probuild' : TRACKLOCK_ALL);
    });
    ui.cogBtn = iconButton(header, 'BBCogButton', ICONS.gear, '⚙', '');
    onClick(ui.cogBtn, function () { state.settingsOpen = !state.settingsOpen; state.menuOpen = false; render(); });
    var close = ui.closeBtn = el('Button', header, 'BBClose BBWear3');
    el('Panel', close, 'BBCloseBar BBCloseBarA');
    el('Panel', close, 'BBCloseBar BBCloseBarB');
    controlTip(close, '');
    onClick(close, toggle);
    // Grime over the header, like the shop's tabs (on top, but it lets the mouse through).

    ui.settings = el('Panel', frame, 'BBSettings BBHidden');
    ui.buildMenu = el('Panel', frame, 'BBBuildMenu BBHidden');

    var tabs = el('Panel', frame, 'BBTabs');
    el('Panel', tabs, 'BBCrease').hittest = false;   // under the tabs
    ui.tabs = {};
    SOURCES.forEach(function (src) {
      var tab = el('Button', tabs, 'BBTab');
      // Light scuffs on each tab (under the label).
      el('Panel', tab, 'BBCardScuff BBTabScuff BBScuff' + (1 + SOURCES.indexOf(src) % 3)).hittest = false;
      el('Label', tab, 'BBTabText', SOURCE_LABEL[src]);
      onClick(tab, function () { switchTab(src); });
      ui.tabs[src] = tab;
    });

    ui.meta = el('Label', frame, 'BBMeta BBHidden', '');
    // The body sits on a faint copy of the shop's worn builds page, behind its scrolling content.
    var bodyWrap = el('Panel', frame, 'BBBodyWrap');
    el('Panel', bodyWrap, 'BBPaperPage').hittest = false;
    ui.body = el('Panel', bodyWrap, 'BBBody');
  }

  // Hotkeys the cog menu offers. Panorama can't unbind a key, so each key is bound the first time it is
  // chosen and only acts while it is the current hotkey.
  var HOTKEYS = [['key_backslash', '\\'], ['key_backquote', '`'], ['key_f6', 'F6'], ['key_f8', 'F8'], ['key_insert', 'Ins']];
  var boundKeys = {};
  function hotkeyLabel(key) {
    for (var i = 0; i < HOTKEYS.length; i++) if (HOTKEYS[i][0] === key) return HOTKEYS[i][1];
    return String(key).replace(/^key_/, '').toUpperCase();
  }
  function bindKey(key) {
    if (boundKeys[key]) return;
    boundKeys[key] = true;
    var fn = function () {
      if (key === BB_SETTINGS.hotkey) {
        // A typed key has now proved itself: forget the previous one and remember this one.
        if (fallbackKey) { fallbackKey = null; savePrefs(); }
      } else if (key !== fallbackKey) return;
      try { toggle(); } catch (e) { log('toggle error: ' + e); }
    };
    try { $.RegisterKeyBind('', key, fn); log('hotkey ' + key + ' bound (global)'); return; } catch (e) { log('global keybind failed: ' + e); }
    try { $.RegisterKeyBind(hudRoot, key, fn); log('hotkey ' + key + ' bound (hud)'); } catch (e2) { log('hud keybind failed: ' + e2); }
  }
  // A preset key is used and saved at once. A typed one may not be a key the game knows, so until it has been
  // pressed once the previous key keeps working and nothing is saved.
  var fallbackKey = null;
  function setHotkey(key, typed) {
    if (key === BB_SETTINGS.hotkey) return;
    if (typed) { if (!fallbackKey) fallbackKey = BB_SETTINGS.hotkey; } else fallbackKey = null;
    BB_SETTINGS.hotkey = key;
    bindKey(key);
    if (!typed) savePrefs();
  }
  // Typed hotkeys: "H", "f7", "Home", "key_pgup" -> Panorama key names (key_h, key_f7, key_home, key_pgup).
  var KEY_ALIAS = { '\\': 'backslash', '`': 'backquote', '/': 'slash', ';': 'semicolon', "'": 'apostrophe', ',': 'comma',
    '.': 'period', '-': 'minus', '=': 'equal', '[': 'lbracket', ']': 'rbracket', ins: 'insert', del: 'delete',
    pageup: 'pgup', pagedown: 'pgdn', esc: 'escape' };
  function keyName(text) {
    var t = String(text || '').replace(/\s+/g, '').toLowerCase();
    if (t.indexOf('key_') === 0) t = t.slice(4);
    if (KEY_ALIAS[t]) t = KEY_ALIAS[t];
    return /^[a-z0-9_]+$/.test(t) ? 'key_' + t : '';
  }
  // Hotkey row: the usual keys as a segmented choice, and a box to type any other key (Enter applies it).
  function hotkeyRow() {
    var row = el('Panel', ui.settings, 'BBSettingRow');
    el('Label', row, 'BBSettingLabel', 'Hotkey');
    var seg = el('Panel', row, 'BBSeg'), preset = false;
    HOTKEYS.forEach(function (o) {
      var on = o[0] === BB_SETTINGS.hotkey;
      if (on) preset = true;
      var btn = el('Button', seg, 'BBSegOption' + (on ? ' Active' : ''));
      el('Label', btn, 'BBSegText', o[1]);
      onClick(btn, function () { if (!on) { setHotkey(o[0]); settingChanged(); } });
    });
    var entry = el('TextEntry', row, 'BBKeyEntry' + (preset ? '' : ' Active'));
    if (!preset) entry.text = hotkeyLabel(BB_SETTINGS.hotkey);
    tooltip(entry, 'Any other key: type it (H, F7, Home...) and press Enter');
    entry.SetPanelEvent('oninputsubmit', function () {
      var key = keyName(entry.text);
      if (!key) { entry.AddClass('BBInvalid'); return; }
      setHotkey(key, true);
      settingChanged();
    });
  }

  loadPrefs();
  var savedPlace = loadPlacement();
  if (savedPlace && (savedPlace.side === 'left' || savedPlace.side === 'right')) BB_SETTINGS.position = savedPlace.side;
  build();
  if (savedPlace && savedPlace.pos && isFinite(savedPlace.pos[0]) && isFinite(savedPlace.pos[1])) placeRoot(savedPlace.pos[0], savedPlace.pos[1]);
  bindKey(BB_SETTINGS.hotkey);
  log('loaded v' + VERSION + ', ' + HERO_IDS.length + ' heroes, data ' + BB_DATA.generated);
  $.Schedule(1.0, tick);
})();
