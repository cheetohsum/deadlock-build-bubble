// Shared helpers: paths, config, game discovery, VPK index reading.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, 'cache');
const OUT = path.join(ROOT, 'out');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULT_CONFIG = {
  gamePath: '',
  pakNumber: 87,
  defaultSource: 'standard',      // standard | pro | winrate
  hotkey: 'key_backslash',
  autoShowShop: true,
  autoShowDraft: true,
  position: 'left',               // left | right
  compact: false,
  animations: true,               // change animations in the bubble (also switchable from its cog menu)
  minBadgeWinrate: 81,            // average match badge floor for win-rate stats: tier * 10 + subrank, 81 = Oracle 1
  proBadge: 111,                  // badge floor for the pro stats fallback, 111 = Eternus 1
  proLeaderboardDepth: 300,       // top N leaderboard entries per region counted as "pro"
  minItemMatches: 150,
  minAbilityOrderMatches: 40,
  pinnedBuilds: {},               // { "<heroId>": <hero_build_id> } overrides the standard build
  apiKey: '',                     // optional deadlock-api key (X-API-KEY) for higher rate limits; env DEADLOCK_API_KEY also works
};

function loadConfig() {
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return { ...DEFAULT_CONFIG, ...user, pinnedBuilds: { ...(user.pinnedBuilds || {}) } };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function steamLibraries() {
  const roots = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
  const libs = new Set();
  for (const r of roots) {
    const vdf = path.join(r, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libs.add(r);
    for (const m of fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
  }
  return [...libs];
}

function findGamePath(cfg) {
  if (cfg && cfg.gamePath && fs.existsSync(path.join(cfg.gamePath, 'game', 'citadel'))) return cfg.gamePath;
  for (const lib of steamLibraries()) {
    const p = path.join(lib, 'steamapps', 'common', 'Deadlock');
    if (fs.existsSync(path.join(p, 'game', 'citadel', 'gameinfo.gi'))) return p;
  }
  return '';
}

// Returns a Set of every file path stored in a VPK v2 directory file.
function readVpkIndex(vpkPath) {
  const buf = fs.readFileSync(vpkPath);
  if (buf.readUInt32LE(0) !== 0x55aa1234) throw new Error('not a VPK: ' + vpkPath);
  const headerSize = buf.readUInt32LE(4) === 2 ? 28 : 12;
  let o = headerSize;
  const str = () => { const e = buf.indexOf(0, o); const s = buf.toString('latin1', o, e); o = e + 1; return s; };
  const out = new Set();
  for (;;) {
    const ext = str(); if (!ext) break;
    for (;;) {
      const dir = str(); if (!dir) break;
      for (;;) {
        const name = str(); if (!name) break;
        const pre = buf.readUInt16LE(o + 4);
        o += 18 + pre;
        out.add((dir === ' ' ? '' : dir + '/') + name + '.' + ext);
      }
    }
  }
  return out;
}

// Reads one file out of a VPK v2 set (the _dir file plus its _NNN archives).
function extractVpkFile(dirVpkPath, entryPath) {
  const buf = fs.readFileSync(dirVpkPath);
  const headerSize = buf.readUInt32LE(4) === 2 ? 28 : 12;
  const treeSize = buf.readUInt32LE(8);
  const want = entryPath.toLowerCase();
  let o = headerSize;
  const str = () => { const e = buf.indexOf(0, o); const s = buf.toString('latin1', o, e); o = e + 1; return s; };
  for (;;) {
    const ext = str(); if (!ext) break;
    for (;;) {
      const dir = str(); if (!dir) break;
      for (;;) {
        const name = str(); if (!name) break;
        const pre = buf.readUInt16LE(o + 4), arc = buf.readUInt16LE(o + 6);
        const off = buf.readUInt32LE(o + 8), len = buf.readUInt32LE(o + 12);
        const preData = buf.subarray(o + 18, o + 18 + pre);
        o += 18 + pre;
        if ((dir === ' ' ? '' : dir + '/') + name + '.' + ext !== want) continue;
        if (!len) return Buffer.from(preData);
        if (arc === 0x7fff) return Buffer.concat([preData, buf.subarray(headerSize + treeSize + off, headerSize + treeSize + off + len)]);
        const archive = dirVpkPath.replace(/_dir\.vpk$/i, '_' + String(arc).padStart(3, '0') + '.vpk');
        const fd = fs.openSync(archive, 'r');
        try {
          const data = Buffer.alloc(len);
          fs.readSync(fd, data, 0, len, off);
          return Buffer.concat([preData, data]);
        } finally { fs.closeSync(fd); }
      }
    }
  }
  throw new Error(`${entryPath} not found in ${dirVpkPath}`);
}

module.exports = { ROOT, CACHE, OUT, CONFIG_PATH, DEFAULT_CONFIG, loadConfig, saveConfig, findGamePath, readVpkIndex, extractVpkFile };
