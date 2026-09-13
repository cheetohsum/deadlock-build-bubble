// Pulls builds and stats from api.deadlock-api.com and writes the data the bubble embeds.
// Usage: node tools/gen-data.js [--offline] [--refresh]
//   --offline reuses cached API responses only; --refresh ignores the cache.
const fs = require('fs');
const path = require('path');
const { CACHE, OUT, loadConfig, findGamePath, readVpkIndex, extractVpkFile } = require('./common');
const { measurePng } = require('./png');

const API = 'https://api.deadlock-api.com';
const OFFLINE = process.argv.includes('--offline');
const REGIONS = ['NAmerica', 'Europe', 'Asia', 'SAmerica', 'Oceania'];
const DAY = 86400;

const apiCacheDir = path.join(CACHE, 'api');
fs.mkdirSync(apiCacheDir, { recursive: true });

function cacheName(url) {
  return url.replace(/^https?:\/\/[^/]+\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 180) + '.json';
}

// Cached responses younger than this are reused; --refresh ignores the cache, --offline never hits the network.
const REFRESH = process.argv.includes('--refresh');
const CACHE_TTL_MS = 20 * 3600 * 1000;
// The API allows 200 requests per 60 s (see its ratelimit-* headers). Requests go out one at a time,
// ~150 per minute, and pause for the window reset when the remaining budget runs low.
const MIN_GAP_MS = 400;
const API_KEY = process.env.DEADLOCK_API_KEY || loadConfig().apiKey || '';
let lastRequestAt = 0;
let queue = Promise.resolve();
let blocked = false;          // set on HTTP 403: stop calling the API for the rest of the run

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPolitely(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (blocked) throw new Error('skipped (API blocked this run): ' + url);
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const headers = { 'User-Agent': 'deadlock-build-bubble (personal use)' };
    if (API_KEY) headers['X-API-KEY'] = API_KEY;
    const res = await fetch(url, { headers });
    const remaining = Number(res.headers.get('ratelimit-remaining'));
    if (res.headers.has('ratelimit-remaining') && remaining <= 5) {
      const reset = Number(res.headers.get('ratelimit-reset'));
      const pauseMs = (reset > 0 ? reset : 60) * 1000;
      console.warn(`  .. rate limit budget low (${remaining} left), pausing ${Math.round(pauseMs / 1000)}s`);
      lastRequestAt = Date.now() + pauseMs - MIN_GAP_MS;
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after')) || 5 * (attempt + 1);
      console.warn(`  .. ${res.status}, waiting ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }
    if (res.status === 403) { blocked = true; throw new Error('403 from API - stopping requests for this run (cached data is still used)'); }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }
  throw new Error('gave up after retries: ' + url);
}

function get(url) {
  const file = path.join(apiCacheDir, cacheName(url));
  const cached = fs.existsSync(file) ? fs.statSync(file) : null;
  if (OFFLINE || blocked || (cached && !REFRESH && Date.now() - cached.mtimeMs < CACHE_TTL_MS)) {
    if (!cached) return Promise.reject(new Error((blocked ? 'blocked' : 'offline') + ' and not cached: ' + url));
    return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  // Serialise network calls so parallel callers still go out one at a time.
  const run = queue.then(() => fetchPolitely(url)).then((json) => { fs.writeFileSync(file, JSON.stringify(json)); return json; });
  queue = run.catch(() => {});
  return run.catch((e) => {
    if (cached) { console.warn('  ! ' + e.message + ' (using stale cache)'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
    throw e;
  });
}

async function tryGet(url, fallback) {
  try { return await get(url); } catch (e) { console.warn('  ! ' + e.message); return fallback; }
}

// Files from the asset CDN (not the rate-limited API), cached forever by file name.
// The CDN answers missing files with an HTML page and status 200, so callers check the content.
async function getAsset(url, subdir) {
  const name = url.replace(/^https?:\/\/[^/]+\//, '').replace(/[^a-z0-9.]+/gi, '_');
  const file = path.join(CACHE, subdir, name);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (OFFLINE) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return buf;
  } catch (e) {
    console.warn('  ! asset: ' + e.message);
    return null;
  }
}

// A handful of ability icons are black silhouettes that vanish on a dark plate; the bubble tints those.
async function iconIsDark(url) {
  if (!url) return false;
  const m = measurePng(await getAsset(url, 'icons'));
  return !!m && m.coverage > 0.05 && m.luminance < 70;
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); }
  }));
  return out;
}

// Lower bound of the Wilson score interval: ranks win rates without trusting tiny samples.
function wilson(wins, n, z = 1.96) {
  if (!n) return 0;
  const p = wins / n;
  return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);
}

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// Default build categories arrive as localisation tokens (#Citadel_HeroBuilds_EarlyGame); show them as words.
const CATEGORY_WORDS = { Early: 'Early Game', Mid: 'Mid Game', Late: 'Late Game', Lane: 'Laning' };
function categoryLabel(name) {
  let s = String(name || '').trim();
  if (s.charAt(0) === '#') {
    s = s.replace(/^#Citadel_HeroBuilds_/, '').replace(/^#[A-Za-z]+_/, '');
    s = CATEGORY_WORDS[s] || s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  }
  return s.slice(0, 40) || 'Items';
}

async function main() {
  const cfg = loadConfig();
  // How much to load per hero (manager: "Builds to load", "Pro matches to load"), whole numbers within bounds.
  const clampInt = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  const BUILD_LIMIT = clampInt(cfg.maxBuilds, 1, 60, 18);
  const MATCH_LIMIT = clampInt(cfg.maxProMatches, 1, 45, 15);
  const gamePath = findGamePath(cfg);
  const now = Math.floor(Date.now() / 1000);

  console.log('assets...');
  const heroes = (await get(`${API}/v1/assets/heroes?only_active=true`))
    .filter((h) => h.player_selectable && !h.disabled && !h.in_development);
  const items = await get(`${API}/v1/assets/items`);
  const itemById = new Map(items.map((i) => [i.id, i]));

  // Map API image URLs onto textures that really exist in the installed game.
  let imageIndex = null;
  if (gamePath) {
    try { imageIndex = readVpkIndex(path.join(gamePath, 'game', 'citadel', 'pak01_dir.vpk')); } catch (e) { console.warn('  ! could not index game VPK: ' + e.message); }
  }
  // Game texture path -> the web image it came from, for the manager's browser preview (never shipped in-game).
  const webImages = {};
  function gameImage(url) {
    if (!url) return '';
    const m = /\/images\/(.+?)\.(png|webp|jpg|svg)$/i.exec(url);
    if (!m) return '';
    const p = m[1].toLowerCase();
    // The asset bucket reorganises some folders: ability icons live under hud/abilities in the game,
    // sometimes without the per-hero subfolder the bucket uses.
    const bases = [p];
    if (/^abilities\//.test(p)) {
      const flat = p.replace(/^abilities\/[^/]+\//, 'abilities/');
      bases.unshift(`hud/${p}`, `hud/${flat}`, flat);
    }
    const candidates = bases.flatMap((b) => [`${b}_psd.vtex`, `${b}_png.vtex`, `${b}.vsvg`]);
    let found = '';
    if (!imageIndex) found = candidates[0];
    else for (const c of candidates) if (imageIndex.has(`panorama/images/${c}_c`)) { found = c; break; }
    if (!found) return '';
    const s2r = `s2r://panorama/images/${found}`;
    webImages[s2r] = url;
    return s2r;
  }

  // Hero theme: the UI colour lifted 20% toward white so it reads on the dark bubble.
  function heroColor(h) {
    const c = h.colors && h.colors.ui;
    if (!Array.isArray(c) || c.length < 3) return (h.colors && h.colors.style_hex) || '';
    return '#' + c.slice(0, 3).map((v) => Math.round(v + (255 - v) * 0.2).toString(16).padStart(2, '0')).join('');
  }

  // Stylised name logo inside the game: panorama/images/heroes/hero_names/<name>.vsvg
  function nameArtPath(h) {
    const fromUrl = (/\/([^/]+)\.svg$/i.exec((h.images && h.images.name_image) || '') || [])[1] || '';
    const candidates = [fromUrl, h.class_name.replace(/^hero_/, ''), h.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')]
      .map((c) => c.toLowerCase()).filter(Boolean);
    if (!imageIndex) return '';
    for (const c of candidates) if (imageIndex.has(`panorama/images/heroes/hero_names/${c}.vsvg_c`)) return `s2r://panorama/images/heroes/hero_names/${c}.vsvg`;
    return '';
  }

  // Width / height of the name logo, read from the small SVG on the asset CDN (cached).
  async function svgAspect(url) {
    if (!url) return 0;
    const file = path.join(CACHE, 'svg', (/\/([^/]+\.svg)$/i.exec(url) || [])[1] || 'x.svg');
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!text && !OFFLINE) {
      try {
        const res = await fetch(url);
        if (res.ok) { text = await res.text(); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
      } catch (e) { console.warn('  ! name art: ' + e.message); }
    }
    const m = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(text) || /width="([\d.]+)"[^>]*height="([\d.]+)"/.exec(text);
    return m ? round(Number(m[1]) / Number(m[2]), 3) : 0;
  }

  const usedItems = new Set();
  const itemRow = (id) => {
    const it = itemById.get(id);
    if (!it || it.type !== 'upgrade') return null;
    usedItems.add(id);
    return id;
  };

  console.log('leaderboards...');
  const proAccounts = new Set();
  for (const region of REGIONS) {
    const lb = await tryGet(`${API}/v1/leaderboard/${region}`, { entries: [] });
    for (const e of lb.entries.slice(0, cfg.proLeaderboardDepth)) for (const id of e.possible_account_ids || []) proAccounts.add(id);
  }
  console.log(`  ${proAccounts.size} candidate pro accounts`);

  function decodeBuild(hb, abilityIndex, source) {
    const d = hb.details || {};
    const cats = [];
    for (const c of d.mod_categories || []) {
      const mods = [];
      for (const m of c.mods || []) {
        if (itemRow(m.ability_id) == null) continue;
        mods.push(m.annotation ? [m.ability_id, String(m.annotation).slice(0, 140)] : [m.ability_id]);
      }
      if (mods.length) cats.push([categoryLabel(c.name), mods]);
    }
    // currency_type 2 = ability unlock, 1 = ability point upgrade; array order is the skill path. Some builds
    // repeat the whole path several times, so each ability unlocks once and upgrades at most three times:
    // 16 steps at most, the first complete path.
    const steps = [];
    const level = [0, 0, 0, 0], unlocked = [false, false, false, false];
    for (const ch of (d.ability_order && d.ability_order.currency_changes) || []) {
      if (steps.length >= 16) break;
      const a = abilityIndex.get(ch.ability_id);
      if (a == null || ch.delta >= 0) continue;
      if (ch.currency_type === 2) { if (!unlocked[a]) { unlocked[a] = true; steps.push([a, 0]); } }
      else if (ch.currency_type === 1 && unlocked[a] && level[a] < 3) steps.push([a, ++level[a]]);
    }
    return {
      source,
      id: hb.hero_build_id,
      name: String(hb.name || 'Untitled build').slice(0, 80),
      favs: 0,
      updated: hb.last_updated_timestamp || 0,
      desc: String(hb.description || '').replace(/\r/g, '').replace(/[^\S\n]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 900),
      cats,
      steps,
    };
  }

  // Ability id sequences from stats: first sighting of an ability is its unlock, later ones are tiers 1-3.
  function decodeSequence(ids, abilityIndex) {
    const seen = [false, false, false, false];
    const level = [0, 0, 0, 0];
    const steps = [];
    for (const id of ids) {
      const a = abilityIndex.get(id);
      if (a == null) continue;
      if (!seen[a]) { seen[a] = true; steps.push([a, 0]); } else if (level[a] < 3) steps.push([a, ++level[a]]);
    }
    return steps;
  }

  function bestOrder(orders, minMatches, byWinrate) {
    const ok = (orders || []).filter((o) => o.matches >= minMatches);
    if (!ok.length) return null;
    ok.sort(byWinrate ? (a, b) => wilson(b.wins, b.matches) - wilson(a.wins, a.matches) : (a, b) => b.matches - a.matches);
    return ok[0];
  }

  function itemTable(stats, minMatches, sortBy) {
    // -> [[tier, [[id, winrate, matches, avgBuyS], ...]], ...] best first per tier
    const byTier = new Map();
    for (const s of stats || []) {
      const it = itemById.get(s.item_id);
      if (!it || it.type !== 'upgrade' || !it.shopable || s.matches < minMatches) continue;
      const tier = it.item_tier || 0;
      if (!byTier.has(tier)) byTier.set(tier, []);
      byTier.get(tier).push(s);
    }
    const out = [];
    for (const tier of [...byTier.keys()].sort((a, b) => a - b)) {
      const rows = byTier.get(tier);
      rows.sort(sortBy === 'picks' ? (a, b) => b.matches - a.matches : (a, b) => wilson(b.wins, b.matches) - wilson(a.wins, a.matches));
      // Up to 10 per tier: a full row in the bubble.
      out.push([tier, rows.slice(0, 10).map((s) => { itemRow(s.item_id); return [s.item_id, round(s.wins / s.matches), s.matches]; })]);
    }
    return out;
  }

  // One call per filter set returns item stats for every hero at once (bucket = hero id).
  console.log('item stats...');
  const byHero = (rows) => {
    const m = new Map();
    for (const r of rows || []) { if (!m.has(r.bucket)) m.set(r.bucket, []); m.get(r.bucket).push(r); }
    return m;
  };
  // Win-rate rank floors the bubble can switch between (the configured floor included). Higher floors
  // have far fewer matches, so they accept smaller samples.
  // All, then the first sub-rank of each tier from Ritualist (61) to Eternus (111).
  const WR_FLOORS = [...new Set([0, 61, 71, 81, 91, 101, 111, cfg.minBadgeWinrate])].sort((a, b) => a - b);
  // Eternus and Ascendant have few matches, so their tiers accept small samples (Wilson ranking still keeps
  // a lucky 3-for-3 item from topping the list).
  const floorMinItems = (f) => (f >= 111 ? 8 : f >= 101 ? 25 : f >= 81 ? 80 : cfg.minItemMatches);
  const floorMinOrders = (f) => (f >= 111 ? 5 : f >= 101 ? 10 : f >= 81 ? 20 : cfg.minAbilityOrderMatches);
  const allWin = new Map();
  for (const f of WR_FLOORS) {
    allWin.set(f, byHero(await tryGet(`${API}/v1/analytics/item-stats?bucket=hero&min_average_badge=${f}&min_matches=${floorMinItems(f)}`, [])));
  }
  const allPro = byHero(await tryGet(`${API}/v1/analytics/item-stats?bucket=hero&min_average_badge=${cfg.proBadge}&min_matches=20`, []));
  const allBrawl = byHero(await tryGet(`${API}/v1/analytics/item-stats?bucket=hero&game_mode=street_brawl&min_matches=40`, []));

  const heroOut = {};
  await mapLimit(heroes, 4, async (h) => {
    const sig = ['signature1', 'signature2', 'signature3', 'signature4'].map((k) => h.items && h.items[k]);
    const abilities = sig.map((cls) => items.find((i) => i.class_name === cls) || null);
    const abilityIndex = new Map(abilities.map((a, i) => [a && a.id, i]));
    const keys = abilities.map((a) => (a && a.image ? (/\/([^/]+)\.(png|webp)$/i.exec(a.image) || [])[1] || '' : '').toLowerCase());
    console.log(`${h.name}...`);

    const q = `hero_id=${h.id}`;
    const proItems = allPro.get(h.id) || [];
    const sbItems = allBrawl.get(h.id) || [];
    const [weekly, fav, proOrders, sbOrders, ...winOrdersByFloor] = await Promise.all([
      tryGet(`${API}/v1/builds?${q}&sort_by=weekly_favorites&only_latest=true&language=0&limit=25`, []),
      tryGet(`${API}/v1/builds?${q}&sort_by=favorites&only_latest=true&limit=250`, []),
      tryGet(`${API}/v1/analytics/ability-order-stats?${q}&min_average_badge=${cfg.proBadge}&min_matches=8`, []),
      tryGet(`${API}/v1/analytics/ability-order-stats?${q}&game_mode=street_brawl&min_matches=15`, []),
      ...WR_FLOORS.map((f) => tryGet(`${API}/v1/analytics/ability-order-stats?${q}&min_average_badge=${f}&min_matches=${floorMinOrders(f)}`, [])),
    ]);

    const withFavs = (row, source) => { const b = decodeBuild(row.hero_build, abilityIndex, source); b.favs = row.num_favorites || 0; return b; };

    // Builds go stale fast across patches: prefer ones updated in the last 90 days.
    const fresh = (r) => now - (r.hero_build.last_updated_timestamp || 0) < 90 * DAY;
    const usable = (r) => r.hero_build.details && (r.hero_build.details.mod_categories || []).length;
    const addBuild = (list, seen, max, row, source) => {
      if (list.length >= max || !row || seen.has(row.hero_build.hero_build_id)) return;
      seen.add(row.hero_build.hero_build_id);
      list.push(withFavs(row, source));
    };

    // Standard: the build dropdown's community builds - pinned first, then fresh weekly favourites,
    // fresh all-time favourites, and finally anything usable.
    const STANDARD_BUILDS = BUILD_LIMIT, PRO_BUILDS = BUILD_LIMIT;   // the bubble pages them six at a time
    const standards = [], standardSeen = new Set();
    const pinned = cfg.pinnedBuilds[String(h.id)];
    if (pinned) {
      const rows = await tryGet(`${API}/v1/builds?${q}&build_id=${pinned}&only_latest=true`, []);
      if (rows.length) addBuild(standards, standardSeen, STANDARD_BUILDS, rows[0], 'pinned');
    }
    for (const row of [...weekly.filter(usable).filter(fresh), ...fav.filter(usable).filter(fresh), ...weekly.filter(usable), ...fav.filter(usable)]) {
      addBuild(standards, standardSeen, STANDARD_BUILDS, row, 'community');
    }

    // Pro: builds authored by top-leaderboard accounts (fresh first, then favourites); else synthesised from top-rank matches.
    // Seeded with the Community builds so Pro only lists builds Community doesn't already show.
    const pros = [], proSeen = new Set(standardSeen);
    fav.filter((r) => proAccounts.has(r.hero_build.author_account_id) && usable(r))
      .sort((a, b) => (fresh(b) - fresh(a)) || (b.num_favorites - a.num_favorites))
      .forEach((row) => addBuild(pros, proSeen, PRO_BUILDS, row, 'pro-author'));
    if (!pros.length) {
      const order = bestOrder(proOrders, 1, false);
      const table = itemTable(proItems, 1, 'picks');
      if (order || table.length) {
        pros.push({
          source: 'pro-stats', id: 0, name: 'Top-rank consensus', favs: 0, updated: now,
          desc: 'No build published by a leaderboard player for this hero, so this is what top-rank players actually buy and level.',
          cats: table.map(([tier, rows]) => [`Tier ${tier}`, rows.map((r) => [r[0]])]),
          steps: order ? decodeSequence(order.abilities, abilityIndex) : [],
        });
      }
    }

    const sbOrder = bestOrder(sbOrders, 1, true);

    // Recent matches by this hero's top leaderboard players (NA + EU), newest first.
    // Each player's item list mixes shop purchases and ability unlocks/upgrades, all with game times.
    const RECENT_MATCHES = MATCH_LIMIT;   // the bubble shows them five to a page
    const nameById = new Map();
    for (const region of ['NAmerica', 'Europe']) {
      const lb = await tryGet(`${API}/v1/leaderboard/${region}/${h.id}`, { entries: [] });
      for (const e of lb.entries.slice(0, 15)) {
        const ids = (e.possible_account_ids || []).filter(Boolean);
        if (ids.length && !nameById.has(ids[0])) nameById.set(ids[0], e.account_name || 'Player');
      }
    }
    let recent = [];
    if (nameById.size) {
      const since = now - 21 * DAY;
      const matches = await tryGet(`${API}/v1/matches/metadata?hero_ids=${h.id}&account_ids=${[...nameById.keys()].join(',')}` +
        `&only_filtered_players=true&include_player_items=true&include_player_info=true&include_player_kda=true` +
        `&min_unix_timestamp=${since}&order_by=start_time&order_direction=desc&limit=${RECENT_MATCHES * 3}`, []);
      for (const m of matches) {
        const p = (m.players || []).find((x) => x.hero_id === h.id && nameById.has(x.account_id));
        if (!p) continue;
        const timeline = [], finals = [], steps = [], level = [0, 0, 0, 0], unlocked = [false, false, false, false];
        for (const it of p.items || []) {
          const a = abilityIndex.get(it.item_id);
          if (a != null) {
            if (it.upgrade_id === 0 && !unlocked[a]) { unlocked[a] = true; steps.push([a, 0]); }
            else if (it.upgrade_id !== 0 && level[a] < 3) steps.push([a, ++level[a]]);
            continue;
          }
          const shop = itemById.get(it.item_id);
          if (!shop || shop.type !== 'upgrade' || !shop.shopable) continue;
          itemRow(it.item_id);
          timeline.push([it.game_time_s, it.item_id, it.sold_time_s || 0]);
          if (!it.sold_time_s) finals.push(it.item_id);
        }
        recent.push({
          n: String(nameById.get(p.account_id)).slice(0, 60),
          w: p.player_match_outcome === 'Win' ? 1 : 0,
          t: Math.floor(Date.parse(String(m.start_time).replace(' ', 'T') + 'Z') / 1000) || 0,
          d: m.duration_s || 0,
          k: p.kills || 0, de: p.deaths || 0, a: p.assists || 0,
          nw: p.net_worth || 0,
          fi: finals.slice(-12),
          tl: timeline,
          st: steps,
        });
        if (recent.length >= RECENT_MATCHES) break;
      }
    }

    heroOut[h.id] = {
      recent,
      name: h.name,
      cls: h.class_name,
      img: gameImage(h.images && h.images.icon_image_small),
      color: heroColor(h),
      nameArt: nameArtPath(h),
      nameAspect: await svgAspect(h.images && h.images.name_image),
      web: { img: (h.images && h.images.icon_image_small) || '', name: (h.images && h.images.name_image) || '' },
      // [ability id, name, game icon, 1 if the icon is a dark silhouette that needs tinting]
      abilities: await Promise.all(abilities.map(async (a) => (a ? [a.id, a.name, gameImage(a.image), (await iconIsDark(a.image)) ? 1 : 0] : [0, '?', '', 0]))),
      keys,
      standards,
      pros,
      // Keyed by rank floor badge (0 = all ranks).
      winrates: Object.fromEntries(WR_FLOORS.map((f, i) => {
        const order = bestOrder(winOrdersByFloor[i], floorMinOrders(f), true);
        return [f, {
          items: itemTable(allWin.get(f).get(h.id) || [], floorMinItems(f), 'winrate'),
          steps: order ? decodeSequence(order.abilities, abilityIndex) : [],
          orderWr: order ? round(order.wins / order.matches) : 0,
          orderMatches: order ? order.matches : 0,
        }];
      })),
      brawl: {
        items: itemTable(sbItems, 40, 'winrate'),
        steps: sbOrder ? decodeSequence(sbOrder.abilities, abilityIndex) : [],
        orderWr: sbOrder ? round(sbOrder.wins / sbOrder.matches) : 0,
        orderMatches: sbOrder ? sbOrder.matches : 0,
      },
    };
  });

  const itemOut = {};
  for (const id of usedItems) {
    const it = itemById.get(id);
    itemOut[id] = [it.name, it.cost || 0, (it.item_slot_type || '')[0] || '', it.item_tier || 0, gameImage(it.shop_image || it.image)];
  }

  // Rank names/icons and how many matches sit at each average badge, for labels in the bubble and manager.
  const ranks = await tryGet(`${API}/v1/assets/ranks`, []);
  const dist = await tryGet(`${API}/v1/analytics/badge-distribution`, []);
  const rankName = (badge) => {
    if (!badge) return '';
    const tier = Math.floor(badge / 10), sub = badge % 10;
    const r = ranks.find((x) => x.tier === tier);
    return (r ? r.name : 'Tier ' + tier) + (sub ? ' ' + sub : '');
  };
  fs.writeFileSync(path.join(CACHE, 'ranks.json'), JSON.stringify({
    ranks: ranks.map((r) => ({ tier: r.tier, name: r.name, img: (r.images && (r.images.large_webp || r.images.large)) || '' })),
    distribution: dist.map((d) => [d.badge_level, d.total_matches, d.unique_players]),
  }));

  // The in-game icon for a rank floor: the tier icon (ranked/badges/rank06_lg, the same art the API and the
  // preview use), else the tier badge, else the small sub-rank badge. The preview gets the API's picture.
  const badgeArt = (badge) => {
    if (!badge || !imageIndex) return '';
    const tier = Math.floor(badge / 10), sub = badge % 10;
    const r = ranks.find((x) => x.tier === tier);
    const files = [`ranked/badges/rank${String(tier).padStart(2, '0')}_lg_psd.vtex`, `ranked/badges/rank${tier}/badge_lg_psd.vtex`];
    if (sub) files.push(`ranked/badges/rank${tier}/badge_sm_subrank${sub}_psd.vtex`);
    const file = files.find((f) => imageIndex.has(`panorama/images/${f}_c`));
    if (!file) return '';
    const s2r = `s2r://panorama/images/${file}`;
    // The preview uses the asset CDN's tier icon: the API's per-subrank images are rate-limited like the API.
    if (r && r.images) webImages[s2r] = r.images.large || '';
    return s2r;
  };

  // Header icons (Deadlock logo for the tracklock.gg button, settings gear). The game ships them as SVG
  // text inside the compiled file, which the manager preview shows as data URIs.
  const svgIcon = (file) => {
    if (!imageIndex || !imageIndex.has(`panorama/images/${file}_c`)) return '';
    const s2r = `s2r://panorama/images/${file}`;
    try {
      const buf = extractVpkFile(path.join(gamePath, 'game', 'citadel', 'pak01_dir.vpk'), `panorama/images/${file}_c`);
      const start = buf.indexOf('<svg'), end = buf.lastIndexOf('</svg>');
      if (start >= 0 && end > start) webImages[s2r] = 'data:image/svg+xml;utf8,' + encodeURIComponent(buf.toString('utf8', start, end + 6));
    } catch (e) { console.warn('  ! icon: ' + e.message); }
    return s2r;
  };

  const data = {
    generated: new Date().toISOString().slice(0, 10),
    // lookbackDays matches the analytics endpoints' default window (30 days).
    meta: {
      winrateRank: rankName(cfg.minBadgeWinrate),
      proRank: rankName(cfg.proBadge),
      winrateBadge: badgeArt(cfg.minBadgeWinrate),
      lookbackDays: 30,
      // Rank floors for the bubble's win-rate dropdown; defaultFloor is the manager's setting.
      // Names are short ("Ritualist+", "All"): the bubble shows badges and uses the names for tooltips.
      floors: WR_FLOORS.map((f) => ({ badge: f, name: f ? rankName(f).replace(/ 1$/, '') + '+' : 'All', img: badgeArt(f) })),
      defaultFloor: cfg.minBadgeWinrate,
      icons: { logo: svgIcon('icons/deadlock_logo.vsvg'), gear: svgIcon('icons/icon_gear.vsvg'), soul: svgIcon('hud/icons/icon_soul.vsvg'),
        tierCap: svgIcon('shop/tier_corner_cap.vsvg') },
    },
    heroes: heroOut,
    items: itemOut,
  };
  const settings = {
    defaultSource: cfg.defaultSource,
    hotkey: cfg.hotkey,
    autoShowShop: cfg.autoShowShop,
    autoShowDraft: cfg.autoShowDraft,
    position: cfg.position,
    compact: cfg.compact,
    animations: cfg.animations !== false,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(CACHE, 'data.json'), JSON.stringify(data, null, 1));
  // BB_WEB_IMAGES is only for the manager preview; tools/build.js leaves it out of the in-game script.
  fs.writeFileSync(path.join(OUT, 'build_bubble_data.js'),
    '// Generated by tools/gen-data.js - do not edit.\n' +
    'var BB_DATA = ' + JSON.stringify(data) + ';\n' +
    'var BB_SETTINGS = ' + JSON.stringify(settings) + ';\n' +
    'var BB_WEB_IMAGES = ' + JSON.stringify(webImages) + ';\n');

  const count = (k) => Object.values(heroOut).filter((h) => (k === 'winrate' ? h.winrates[cfg.minBadgeWinrate].items.length : (h[k + 's'] || []).length)).length;
  const dark = Object.values(heroOut).flatMap((h) => h.abilities.filter((a) => a[3]).map((a) => a[1]));
  console.log(`done: ${Object.keys(heroOut).length} heroes, ${usedItems.size} items; standard ${count('standard')}, pro ${count('pro')}, winrate ${count('winrate')}; dark ability icons ${dark.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
