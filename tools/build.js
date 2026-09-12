// Builds the addon VPK. Usage:
//   node tools/build.js [--skip-gen] [--offline] [--install] [--uninstall]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, CACHE, OUT, loadConfig, findGamePath, extractVpkFile } = require('./common');
const { compileJs, compileCss, compileXml } = require('./s2res');
const { writeVpk } = require('./vpk');

const args = new Set(process.argv.slice(2));
const STOCK_HUD_URL = 'https://raw.githubusercontent.com/SteamTracking/GameTracking-Deadlock/master/game/citadel/pak01_dir/panorama/layout/hud.xml';
const INSTALL_RECORD = path.join(CACHE, 'installed.json');

function log(m) { console.log(m); }

async function stockHudXml(gamePath) {
  const file = path.join(CACHE, 'stock', 'hud.xml');
  const pak01 = path.join(gamePath, 'game', 'citadel', 'pak01_dir.vpk');
  const stale = !fs.existsSync(file) || fs.statSync(file).mtimeMs < fs.statSync(pak01).mtimeMs;
  if (stale && !args.has('--offline')) {
    log('fetching stock hud.xml from GameTracking-Deadlock...');
    const res = await fetch(STOCK_HUD_URL);
    if (!res.ok) throw new Error(`stock hud.xml: HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await res.text());
  }
  if (!fs.existsSync(file)) throw new Error('no cached stock hud.xml (run once without --offline)');
  return fs.readFileSync(file, 'utf8');
}

function injectHud(xml) {
  xml = xml.replace(/^<!--.*?-->\s*/s, '');
  if (!xml.includes('<CitadelHud')) throw new Error('stock hud.xml does not look like the Deadlock HUD');
  const css = '\t\t<include src="s2r://panorama/styles/build_bubble.vcss_c" />\n';
  const js = '\t\t<include src="s2r://panorama/scripts/build_bubble.vjs_c" />\n';
  xml = xml.replace('</styles>', css + '\t</styles>');
  if (xml.includes('</scripts>')) xml = xml.replace('</scripts>', js + '\t</scripts>');
  else xml = xml.replace('</styles>', '</styles>\n\t<scripts>\n' + js + '\t</scripts>');
  return xml;
}

// Mount citadel/addons the way Deadlock Mod Manager does. Without the explicit Mod/Write lines the first
// "Game" path (citadel/addons) becomes the MOD and write path, the game can't find cfg/user_keys_default.vcfg,
// and it aborts on launch ("Unable to read default keybinding configuration").
const ADDON_SEARCH_PATHS = [
  ['Game', 'citadel/addons'], ['Mod', 'citadel'], ['Write', 'citadel'], ['Game', 'citadel'],
  ['Mod', 'core'], ['Write', 'core'], ['Game', 'core'],
];

function patchGameinfo(gamePath) {
  const gi = path.join(gamePath, 'game', 'citadel', 'gameinfo.gi');
  const text = fs.readFileSync(gi, 'utf8');
  if (/^\s*Game\s+citadel\/addons\s*$/m.test(text)) {
    // Already mounted (by us or Deadlock Mod Manager). Only safe if MOD still points at citadel.
    if (!/^\s*Mod\s+citadel\s*$/m.test(text)) {
      throw new Error('gameinfo.gi mounts citadel/addons without "Mod citadel", which crashes the game on launch. ' +
        'Restore it (Steam > Deadlock > Properties > Installed Files > Verify) and install again.');
    }
    return false;
  }
  const m = /^([ \t]*)Game[ \t]+citadel[ \t]*\r?\n[ \t]*Game[ \t]+core[ \t]*$/m.exec(text);
  if (!m) throw new Error('could not find the "Game citadel" / "Game core" search paths in gameinfo.gi');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = ADDON_SEARCH_PATHS.map(([key, value]) => `${m[1]}${key.padEnd(20)}${value}`).join(eol);
  const backup = path.join(CACHE, 'gameinfo.gi.bak');
  fs.copyFileSync(gi, backup);
  fs.writeFileSync(gi, text.slice(0, m.index) + block + text.slice(m.index + m[0].length));
  log(`patched gameinfo.gi with the addons search paths (backup: ${backup})`);
  return true;
}

function addonTarget(gamePath, pakNumber) {
  return path.join(gamePath, 'game', 'citadel', 'addons', `pak${String(pakNumber).padStart(2, '0')}_dir.vpk`);
}

function readRecord() { return fs.existsSync(INSTALL_RECORD) ? JSON.parse(fs.readFileSync(INSTALL_RECORD, 'utf8')) : null; }

function install(gamePath, cfg, vpkPath) {
  const target = addonTarget(gamePath, cfg.pakNumber);
  const rec = readRecord();
  if (fs.existsSync(target) && !(rec && rec.target === target && rec.size === fs.statSync(target).size)) {
    throw new Error(`${target} already exists and was not installed by this tool. Pick another pakNumber in config.json.`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(vpkPath, target);
  fs.writeFileSync(INSTALL_RECORD, JSON.stringify({ target, size: fs.statSync(target).size, at: new Date().toISOString() }, null, 2));
  log(`installed -> ${target}`);
  patchGameinfo(gamePath);
}

function uninstall() {
  const rec = readRecord();
  if (!rec || !fs.existsSync(rec.target)) { log('nothing installed by this tool'); return; }
  fs.unlinkSync(rec.target);
  fs.unlinkSync(INSTALL_RECORD);
  log(`removed ${rec.target} (gameinfo.gi left as is; Deadlock Mod Manager relies on the addons line too)`);
}

async function main() {
  if (args.has('--uninstall')) return uninstall();

  const cfg = loadConfig();
  const gamePath = findGamePath(cfg);
  if (!gamePath) throw new Error('Deadlock install not found; set gamePath in config.json');
  const pak01 = path.join(gamePath, 'game', 'citadel', 'pak01_dir.vpk');

  if (!args.has('--skip-gen')) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'gen-data.js'), ...(args.has('--offline') ? ['--offline'] : [])], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('gen-data failed');
  }
  const dataJs = path.join(OUT, 'build_bubble_data.js');
  if (!fs.existsSync(dataJs)) throw new Error('no generated data; run without --skip-gen');

  const templates = {
    xml: extractVpkFile(pak01, 'panorama/layout/hud.vxml_c'),
    css: extractVpkFile(pak01, 'panorama/styles/hud.vcss_c'),
    js: extractVpkFile(pak01, 'panorama/scripts/popups/popup_settings_old.vjs_c'),
  };

  const src = path.join(ROOT, 'src', 'panorama');
  // BB_WEB_IMAGES maps game textures to web images for the manager preview only; it stays out of the game.
  const data = fs.readFileSync(dataJs, 'utf8').split('\n').filter((l) => !l.startsWith('var BB_WEB_IMAGES')).join('\n');
  const script = data + '\n' + fs.readFileSync(path.join(src, 'build_bubble.js'), 'utf8');
  const style = fs.readFileSync(path.join(src, 'build_bubble.css'), 'utf8');
  const hud = injectHud(await stockHudXml(gamePath));

  const files = [
    { path: 'panorama/layout/hud.vxml_c', data: compileXml(hud, templates.xml) },
    { path: 'panorama/styles/build_bubble.vcss_c', data: compileCss(style, templates.css) },
    { path: 'panorama/scripts/build_bubble.vjs_c', data: compileJs(script, templates.js) },
  ];

  // Loose copies make it easy to inspect the output with Source 2 Viewer.
  const loose = path.join(OUT, 'pak');
  fs.rmSync(loose, { recursive: true, force: true });
  for (const f of files) {
    const p = path.join(loose, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.data);
  }
  fs.writeFileSync(path.join(OUT, 'hud.xml'), hud);

  const vpkPath = path.join(OUT, `pak${String(cfg.pakNumber).padStart(2, '0')}_dir.vpk`);
  writeVpk(vpkPath, files);
  log(`built ${vpkPath} (${fs.statSync(vpkPath).size} bytes; script ${Math.round(script.length / 1024)} KB)`);

  if (args.has('--install')) install(gamePath, cfg, vpkPath);
}

main().catch((e) => { console.error('build failed: ' + e.message); process.exit(1); });
