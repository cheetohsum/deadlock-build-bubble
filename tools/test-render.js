// Runs the real bubble script against a mock Panorama tree and drives every hero, tab and trigger.
// Usage: node tools/test-render.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, OUT } = require('./common');

class Panel {
  constructor(type, id) { this.type = type; this.id = id || ''; this.cls = new Set(); this.children = []; this.parent = null; this.events = {}; this.text = ''; this.image = ''; this.dead = false; this.style = {}; this.hittest = true; this.actualxoffset = 0; this.actualyoffset = 0; }
  AddClass(c) { this.cls.add(c); }
  RemoveClass(c) { this.cls.delete(c); }
  SetHasClass(c, v) { v ? this.cls.add(c) : this.cls.delete(c); }
  BHasClass(c) { return this.cls.has(c); }
  IsValid() { return !this.dead; }
  Children() { return this.children.slice(); }
  GetParent() { return this.parent; }
  FindChildTraverse(id) { for (const c of this.children) { if (c.id === id) return c; const f = c.FindChildTraverse(id); if (f) return f; } return null; }
  RemoveAndDeleteChildren() { for (const c of this.children) c.dead = true; this.children = []; }
  DeleteAsync() { this.dead = true; if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  SetPanelEvent(name, fn) { this.events[name] = fn; }
  SetImage(src) { this.image = src; }
  GetAttributeString() { return ''; }
  SetDraggable(v) { this.draggable = v; }
  GetPositionWithinWindow() { return this.winPos || { x: 0, y: 0 }; }
  count() { return 1 + this.children.reduce((n, c) => n + c.count(), 0); }
  all(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) c.all(pred, out); return out; }
}

function add(parent, type, id) { const p = new Panel(type, id); p.parent = parent; parent.children.push(p); return p; }

const root = new Panel('CitadelHud', 'Hud');
const abilities = add(root, 'Panel', 'AbilitiesContainer');
const alive = add(root, 'Panel', 'gameplay_hud_alive');
const progress = add(add(alive, 'Panel', 'crosshair'), 'Panel', 'progress');
add(abilities, 'CitadelHudAbilities', 'hud_signature');

const logs = [];
const scheduled = [];
let hotkey = null;
const $ = {
  GetContextPanel: () => root,
  CreatePanel: (type, parent, id) => add(parent, type, id),
  Schedule: (t, fn) => scheduled.push(fn),
  Msg: (m) => logs.push(String(m)),
  DispatchEvent: () => {},
  RegisterKeyBind: (ctx, key, fn) => { hotkey = fn; },
  RegisterEventHandler: (name, p, fn) => { (p.handlers = p.handlers || {})[name] = fn; },
  persistentStorage: { store: {}, getItem(k) { return k in this.store ? this.store[k] : null; }, setItem(k, v) { this.store[k] = String(v); } },
};

const script = fs.readFileSync(path.join(OUT, 'build_bubble_data.js'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'src', 'panorama', 'build_bubble.js'), 'utf8');
const sandbox = { $, console };
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'build_bubble.js' });
const BB = sandbox.BB_DATA;

function runTicks(n = 3) { for (let i = 0; i < n; i++) { const fns = scheduled.splice(0); fns.forEach((f) => f()); } }
function bubble() { return root.FindChildTraverse('BuildBubbleRoot'); }
function shown() { return bubble().BHasClass('BBShown'); }
function clickTab(label) {
  const tab = bubble().all((p) => p.cls.has('BBTab') && p.children.some((c) => c.text === label))[0];
  tab.events.onactivate();
}
function texts() { return bubble().all((p) => p.type === 'Label').map((p) => p.text); }

let failures = 0;
let animChecked = false;
function check(cond, msg) { if (!cond) { failures++; console.log('FAIL ' + msg); } }

runTicks(1);
check(!!hotkey, 'hotkey registered');
check(bubble() && !shown(), 'bubble exists and starts hidden');

// Shop trigger opens and closes the bubble.
abilities.AddClass('gShopOpen'); runTicks();
check(shown(), 'opens when gShopOpen appears');
abilities.RemoveClass('gShopOpen'); runTicks();
check(!shown(), 'closes when shop closes');

// Hotkey toggles; hotkey during shop dismisses.
hotkey(); runTicks(); check(shown(), 'hotkey opens');
hotkey(); runTicks(); check(!shown(), 'hotkey closes');
abilities.AddClass('gShopOpen'); runTicks(); hotkey(); runTicks();
check(!shown(), 'hotkey dismisses auto-open'); abilities.RemoveClass('gShopOpen'); runTicks();

// Every hero x tab x mode renders without script errors.
let maxPanels = 0;
for (const [id, h] of Object.entries(BB.heroes)) {
  [...progress.cls].forEach((c) => progress.RemoveClass(c));
  progress.AddClass(h.cls);
  for (const brawl of [false, true]) {
    if (brawl) abilities.AddClass('gItemDraftOpen'); else abilities.AddClass('gShopOpen');
    runTicks(8);
    check(shown(), `${h.name}: shown (brawl=${brawl})`);
    const name = texts().find((t) => t === h.name);
    check(!!name, `${h.name}: detected via hud class (brawl=${brawl})`);
    for (const tab of ['Community', 'Pro', 'Top WR']) {
      clickTab(tab); runTicks(1);
      maxPanels = Math.max(maxPanels, bubble().count());
      if (tab === 'Top WR' && !animChecked) {
        animChecked = true;
        check(bubble().all((p) => p.cls.has('BBItemGhost')).length > 0, `${h.name}: switching to Top WR animates the items that changed`);
        check(bubble().all((p) => p.cls.has('BBMorph') && p.children.filter((c) => c.cls.has('BBSlotBody')).length === 2).length > 0,
          `${h.name}: switching to Top WR morphs the section-head stats`);
        bubble().all((p) => p.cls.has('BBFloorPicker'))[0].events.onactivate(); runTicks(1);
        bubble().all((p) => p.cls.has('BBFloorOption'))[3].events.onactivate(); runTicks(1);
        const fhead = bubble().all((p) => p.cls.has('BBSectionHead'))[0];
        check(fhead.all((p) => p.cls.has('BBMorph') && p.children.filter((c) => c.cls.has('BBSlotBody')).length === 2).length === 0 &&
          fhead.all((p) => p.cls.has('BBFloorFaceBox') && p.children.length === 2).length === 1,
          `${h.name}: switching rank floor pops the rank icon without morphing the row`);
        check(bubble().all((p) => p.cls.has('BBItem') && p.all((c) => c.cls.has('BBMorph')).length > 0).length === 0,
          `${h.name}: switching rank floor counts item numbers in place`);
      }
      if (tab === 'Community' && (h.standards || []).length > 1) {
        // The build name opens a dropdown of the tab's builds; picking one switches the build shown.
        const picker = () => bubble().all((p) => p.cls.has('BBBuildPicker'))[0];
        picker().events.onactivate(); runTicks(1);
        const menuOpts = () => bubble().all((p) => p.cls.has('BBBuildOption'));
        check(menuOpts().length === Math.min(h.standards.length, 6), `${h.name}: build dropdown shows the first page of builds`);
        if (h.standards.length > 6) {
          const menuPanel = () => bubble().all((p) => p.cls.has('BBBuildMenu'))[0];
          menuPanel().all((p) => p.cls.has('BBPagerNext'))[0].events.onactivate(); runTicks(1);
          check(menuOpts().length === Math.min(h.standards.length - 6, 6), `${h.name}: build dropdown pages to the next builds`);
          menuPanel().all((p) => p.cls.has('BBPagerPrev'))[0].events.onactivate(); runTicks(1);
        }
        if ((h.pros || []).length > 1) {
          clickTab('Pro'); runTicks(1);
          check(bubble().all((p) => p.cls.has('BBBuildPicker'))[0].cls.has('BBMenuOpen'), `${h.name}: the build list stays open switching Community to Pro`);
          clickTab('Community'); runTicks(1);
        }
        const options = menuOpts();
        options[1].events.onactivate(); runTicks(1);
        const shown = bubble().all((p) => p.cls.has('BBBuildName'))[0].text;
        // Names starting with '#' get an invisible prefix so Panorama doesn't treat them as localisation tokens.
        check(h.standards[1].name.startsWith(shown.replace(/^​/, '').replace(/…$/, '')), `${h.name}: picking a build switches to it`);
        check(!bubble().all((p) => p.cls.has('BBBuildPicker'))[0].cls.has('BBMenuOpen'), `${h.name}: dropdown closes after picking`);
      }
      if (tab === 'Pro' && (h.recent || []).length) {
        // Expanding a recent pro match shows its timeline and ability build; clicking again collapses it.
        const rowOf = () => bubble().all((p) => p.cls.has('BBMatchRow'))[0];
        rowOf().events.onactivate(); runTicks(1);
        const card = bubble().all((p) => p.cls.has('BBMatch'))[0];
        check(card.cls.has('BBExpanded') && card.all((p) => p.cls.has('BBTimelineItem')).length > 0, `${h.name}: match expands with a timeline`);
        const tlTotal = h.recent[0].tl.length;
        check(card.all((p) => p.cls.has('BBTimelineItem')).length === Math.min(10, tlTotal), `${h.name}: timeline shows up to 10 per page`);
        if (tlTotal > 10) {
          card.all((p) => p.cls.has('BBPagerNext'))[0].events.onactivate(); runTicks(1);
          const page2 = bubble().all((p) => p.cls.has('BBMatch'))[0].all((p) => p.cls.has('BBTimelineItem')).length;
          check(page2 === Math.min(10, tlTotal - 10), `${h.name}: timeline pager moves to the next page`);
        }
        maxPanels = Math.max(maxPanels, bubble().count());
        rowOf().events.onactivate(); runTicks(1);
        check(!bubble().all((p) => p.cls.has('BBMatch'))[0].cls.has('BBExpanded'), `${h.name}: match collapses`);
      }
    }
    clickTab('Community');
    abilities.RemoveClass('gItemDraftOpen'); abilities.RemoveClass('gShopOpen'); runTicks();
  }
}

// Pinning from the dropdown: the pinned build moves to the top of Community and is labelled as pinned.
[...progress.cls].forEach((c) => progress.RemoveClass(c));
const pinHero = Object.values(BB.heroes).find((x) => (x.standards || []).length > 2);
progress.AddClass(pinHero.cls); abilities.AddClass('gShopOpen'); runTicks(8);
clickTab('Community'); runTicks(1);
bubble().all((p) => p.cls.has('BBBuildPicker'))[0].events.onactivate(); runTicks(1);
const pinTarget = pinHero.standards[2];
bubble().all((p) => p.cls.has('BBBuildOption'))[2].all((p) => p.cls.has('BBPinButton'))[0].events.onactivate(); runTicks(1);
const shownAfterPin = bubble().all((p) => p.cls.has('BBBuildName'))[0].text.replace(/^\u200B/, '').replace(/\u2026$/, '');
check(pinTarget.name.startsWith(shownAfterPin), 'pinning moves the build to the top of Community');
check(!bubble().all((p) => p.cls.has('BBHeaderPin'))[0].cls.has('BBHidden'), 'pinned build shows the pin icon in the header');
abilities.RemoveClass('gShopOpen'); runTicks();

// Hero picker path: no hero class -> picker; pick one -> renders it.
[...progress.cls].forEach((c) => progress.RemoveClass(c));
hotkey(); runTicks(8);
// Real hero tiles only (the last row is padded with invisible fillers).
const picks = bubble().all((p) => p.cls.has('BBPick') && !p.cls.has('BBPickSpacer'));
check(picks.length === Object.keys(BB.heroes).length, 'picker lists every hero when detection fails');
// The grid is sorted by name, so the first tile is the alphabetically first hero.
const firstByName = Object.values(BB.heroes).map((x) => x.name).sort()[0];
picks[0].events.onactivate(); runTicks(2);
check(texts().some((t) => t === firstByName), 'manual pick renders the picked hero');
bubble().all((p) => p.cls.has('BBHeroButton'))[0].events.onactivate(); runTicks(1);
check(bubble().all((p) => p.cls.has('BBPick')).length > 0, 'the portrait reopens the hero picker');
bubble().all((p) => p.cls.has('BBHeroButton'))[0].events.onactivate(); runTicks(2);
check(texts().some((t) => /Couldn't detect your hero/.test(t)), 'pressing the portrait again with nothing picked goes back to auto-detect');

// Settings cog opens its panel; Compact applies live; the tracklock.gg button opens the hero's page.
const dispatched = [];
const realDispatch = $.DispatchEvent;
$.DispatchEvent = (name, arg) => { dispatched.push([name, arg]); };
bubble().all((p) => p.cls.has('BBCogButton'))[0].events.onactivate(); runTicks(1);
check(bubble().all((p) => p.cls.has('BBToggle')).length >= 3, 'settings panel shows its toggles');
const compactRow = bubble().all((p) => p.cls.has('BBSettingRow') && p.children.some((c) => c.text === 'Compact'))[0];
compactRow.events.onactivate(); runTicks(1);
check(bubble().cls.has('BBCompact'), 'compact applies live from the settings panel');
const segF6 = bubble().all((p) => p.cls.has('BBSegOption') && p.children.some((c) => c.text === 'F6'))[0];
segF6.events.onactivate(); runTicks(1);
check(sandbox.BB_SETTINGS.hotkey === 'key_f6', 'hotkey can be changed from the settings panel');
const keyEntry = bubble().all((p) => p.cls.has('BBKeyEntry'))[0];
keyEntry.text = 'h'; keyEntry.events.oninputsubmit(); runTicks(1);
check(sandbox.BB_SETTINGS.hotkey === 'key_h', 'a typed hotkey is accepted');
const animRow = bubble().all((p) => p.cls.has('BBSettingRow') && p.children.some((c) => c.text === 'Animations'))[0];
animRow.events.onactivate(); runTicks(1);
check(bubble().cls.has('BBNoAnim') && sandbox.BB_SETTINGS.animations === false, 'animations can be switched off from the settings panel');
// The portrait test went back to auto-detect with no hero on screen; give it one so the button has a hero page.
progress.AddClass(Object.values(BB.heroes)[0].cls); runTicks(8);
bubble().all((p) => p.cls.has('BBTrackButton'))[0].events.onactivate();
check(dispatched.some(([n, u]) => n === 'ExternalBrowserGoToURL' && /^https:\/\/tracklock\.gg\/heroes\/[a-z0-9-]+\/probuild$/.test(u)), 'tracklock.gg button opens the hero page');
$.DispatchEvent = realDispatch;

// Rank floors without enough data grey out; a chosen floor a hero lacks shows a lower floor with data.
const enoughAt = (hero, f) => { const w = hero.winrates && hero.winrates[f]; return !!(w && w.steps.length && w.items.reduce((n, t) => n + t[1].length, 0) >= 8); };
const topFloor = BB.meta.floors[BB.meta.floors.length - 1];
const richHero = Object.values(BB.heroes).find((x) => enoughAt(x, topFloor.badge));
const thinHero = Object.values(BB.heroes).find((x) => !enoughAt(x, topFloor.badge));
if (richHero && thinHero) {
  [...progress.cls].forEach((c) => progress.RemoveClass(c));
  progress.AddClass(richHero.cls); runTicks(8);
  clickTab('Top WR'); runTicks(1);
  bubble().all((p) => p.cls.has('BBFloorPicker'))[0].events.onactivate(); runTicks(1);
  const richOpts = bubble().all((p) => p.cls.has('BBFloorOption'));
  richOpts[richOpts.length - 1].events.onactivate(); runTicks(1);
  [...progress.cls].forEach((c) => progress.RemoveClass(c));
  progress.AddClass(thinHero.cls); runTicks(8);
  const faceStack = bubble().all((p) => p.cls.has('BBFloorFaceBox'))[0].children[0];
  const face = faceStack.all((p) => p.cls.has('BBFloorBadge') && !p.cls.has('BBDropCopy'))[0] || faceStack;
  check(face.image !== topFloor.img, `${thinHero.name}: a rank floor without enough data falls back to one that has it`);
  bubble().all((p) => p.cls.has('BBFloorPicker'))[0].events.onactivate(); runTicks(1);
  const thinOpts = bubble().all((p) => p.cls.has('BBFloorOption'));
  check(thinOpts[thinOpts.length - 1].cls.has('Disabled'), `${thinHero.name}: the rank floor without enough data is greyed out`);
}

// Dragging the header (Panorama drag-and-drop) moves the bubble by as much as the drag ghost moves.
const header = bubble().all((p) => p.cls.has('BBHeaderRow'))[0];
check(header.draggable === true && !!(header.handlers && header.handlers.DragStart), 'header is draggable');
const dragCallbacks = {};
header.handlers.DragStart(header.id, dragCallbacks);
const ghost = dragCallbacks.displayPanel;
ghost.winPos = { x: 300, y: 200 }; runTicks(3);
ghost.winPos = { x: 420, y: 260 }; runTicks(2);
header.handlers.DragDrop(header.id, ghost);
// After an accepted drop the ghost may still move (Panorama's slide back); the bubble stays where it was dropped.
ghost.winPos = { x: 300, y: 200 }; runTicks(2);
header.handlers.DragEnd(header.id, ghost);
check(bubble().style.position === '120px 60px 0px' && bubble().cls.has('BBPlaced'), 'dragging moves the bubble with the ghost and keeps the drop');
const savedPlace = JSON.parse($.persistentStorage.store.build_bubble_place || 'null');
check(!!(savedPlace && savedPlace.pos && savedPlace.pos[0] === 120 && savedPlace.pos[1] === 60), 'dropped position is remembered');
check(ghost.dead, 'drag ghost is removed on drop');

// An unaccepted drop: the ghost slides back toward the start before DragEnd; the bubble stays where it was let go.
const cb2 = {};
header.handlers.DragStart(header.id, cb2);
const ghost2 = cb2.displayPanel;
ghost2.winPos = { x: 500, y: 300 }; runTicks(3);
ghost2.winPos = { x: 560, y: 340 }; runTicks(1);
ghost2.winPos = { x: 620, y: 380 }; runTicks(1);
ghost2.winPos = { x: 560, y: 340 }; runTicks(1);
ghost2.winPos = { x: 500, y: 300 }; runTicks(1);
header.handlers.DragEnd(header.id, ghost2);
check(bubble().style.position === '240px 140px 0px', 'an unaccepted drop stays where the mouse was let go (got ' + bubble().style.position + ')');

// While dragging, an invisible layer over the HUD takes the drop (so the shop's drop targets never get it).
{
  const cb3 = {};
  header.handlers.DragStart(header.id, cb3);
  const catcher = root.FindChildTraverse('BuildBubbleDropCatcher');
  check(!!(catcher && !catcher.dead && catcher.handlers && catcher.handlers.DragDrop), 'a drag puts a drop layer over the HUD');
  check(bubble().cls.has('BBMoving'), 'the bubble is highlighted while it is dragged');
  cb3.displayPanel.winPos = { x: 600, y: 300 }; runTicks(3);
  cb3.displayPanel.winPos = { x: 610, y: 310 }; runTicks(2);
  check(!!catcher && catcher.handlers.DragDrop(header.id, cb3.displayPanel) === true, 'the drop layer accepts the drop');
  check(!!catcher && catcher.dead && !bubble().cls.has('BBMoving'), 'the drop layer and the highlight are gone once dropped');
  header.handlers.DragEnd(header.id, cb3.displayPanel);
  check(!root.FindChildTraverse('BuildBubbleDropCatcher') && cb3.displayPanel.dead, 'nothing of the drag is left once it ends');
}

const tile = bubble().all((p) => p.cls.has('BBItem'))[0];
check(tile && tile.events.onmouseover && tile.hittestchildren === false, 'item tooltips cover the whole card');
check(bubble().all((p) => p.cls.has('BBMaxOrder') && p.events.onmouseover).length === 0, 'the max order has no tooltip of its own');
check(bubble().all((p) => p.type === 'Button' && ['BBPagerDot', 'BBPagerArrow', 'BBPinButton'].some((c) => p.cls.has(c))).length === 0, 'pager and pin controls are plain panels');

// A scrollbar like Panorama's (a VerticalScrollBar with a ScrollThumb) belongs to the body itself, so it outlives
// the body's content being cleared on each render.
{
  const body = bubble().all((p) => p.cls.has('BBBody'))[0];
  const sb = add(body, 'Panel', 'VerticalScrollBar');
  const th = add(sb, 'Panel', '');
  th.AddClass('ScrollThumb');
  const clear = body.RemoveAndDeleteChildren;
  body.RemoveAndDeleteChildren = function () { this.children = this.children.filter((c) => c !== sb); clear.call(this); this.children.push(sb); };
  clickTab('Community'); runTicks(3);
  clickTab('Pro'); runTicks(3);
  check(/color-stop/.test(sb.style.backgroundColor || '') && /cbbca666/.test(th.style.backgroundColor || ''), 'the body scrollbar is styled from script (tapered track and thumb)');
  if (sb.events.onmouseover) sb.events.onmouseover();
  check(/e9dcc6/.test(th.style.backgroundColor || ''), 'the scrollbar thumb glows beige while hovered');
  if (sb.events.onmouseout) sb.events.onmouseout();
  check(/cbbca666/.test(th.style.backgroundColor || ''), 'the scrollbar thumb settles back after hover');
  body.RemoveAndDeleteChildren = clear;
}

const errors = logs.filter((l) => /error|failed/i.test(l));
console.log(`heroes ${Object.keys(BB.heroes).length}, max panels in bubble ${maxPanels}, log lines ${logs.length}`);
if (errors.length) { failures += errors.length; console.log('script errors:\n  ' + [...new Set(errors)].slice(0, 10).join('\n  ')); }
console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
