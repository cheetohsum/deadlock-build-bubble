// Build Bubble Manager: local-only settings UI, live preview and build/install buttons.
// Usage: node gui/server.js [--port 5178] [--no-open]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, CACHE, OUT, loadConfig, saveConfig, findGamePath, DEFAULT_CONFIG } = require('../tools/common');

const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 5178;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

// Files the preview may read; everything else is refused.
const STATIC = {
  '/': 'gui/index.html',
  '/preview.html': 'gui/preview.html',
  '/shim.js': 'gui/shim.js',
  '/bubble/build_bubble.js': 'src/panorama/build_bubble.js',
  '/bubble/build_bubble.css': 'src/panorama/build_bubble.css',
  '/bubble/build_bubble_data.js': 'out/build_bubble_data.js',
};

let running = null; // one tool run at a time

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

function status() {
  const cfg = loadConfig();
  const gamePath = findGamePath(cfg);
  const dataFile = path.join(CACHE, 'data.json');
  const record = path.join(CACHE, 'installed.json');
  let data = null;
  if (fs.existsSync(dataFile)) {
    const d = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    data = { generated: d.generated, heroes: Object.keys(d.heroes).length };
  }
  let addonsLine = null;
  if (gamePath) {
    const gi = path.join(gamePath, 'game', 'citadel', 'gameinfo.gi');
    if (fs.existsSync(gi)) addonsLine = /^\s*Game\s+citadel\/addons\s*$/m.test(fs.readFileSync(gi, 'utf8'));
  }
  const built = fs.readdirSync(OUT, { withFileTypes: true }).filter((f) => /^pak\d+_dir\.vpk$/.test(f.name)).map((f) => f.name);
  return {
    gamePath,
    data,
    built,
    installed: fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null,
    addonsLine,
    busy: running ? running.label : null,
  };
}

function runTool(label, args) {
  return new Promise((resolve) => {
    if (running) return resolve({ ok: false, log: `busy: ${running.label}` });
    const child = spawn(process.execPath, args, { cwd: ROOT });
    running = { label };
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('close', (code) => { running = null; resolve({ ok: code === 0, log }); });
  });
}

const ACTIONS = {
  gen: ['Refreshing data', ['tools/gen-data.js']],
  build: ['Building', ['tools/build.js', '--skip-gen']],
  install: ['Installing', ['tools/build.js', '--skip-gen', '--install']],
  uninstall: ['Uninstalling', ['tools/build.js', '--uninstall']],
  test: ['Testing', ['tools/test-render.js']],
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const file = path.join(ROOT, STATIC[url.pathname]);
      if (!fs.existsSync(file)) return send(res, 404, 'not built yet', 'text/plain');
      return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
    }
    if (url.pathname === '/api/status') return send(res, 200, status());
    if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, { config: loadConfig(), defaults: DEFAULT_CONFIG });
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const next = { ...loadConfig() };
      for (const k of Object.keys(DEFAULT_CONFIG)) if (k in body) next[k] = body[k];
      saveConfig(next);
      return send(res, 200, { config: next });
    }
    if (url.pathname === '/api/ranks') {
      const f = path.join(CACHE, 'ranks.json');
      return send(res, 200, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { ranks: [], distribution: [] });
    }
    if (url.pathname === '/api/heroes') {
      const f = path.join(CACHE, 'data.json');
      if (!fs.existsSync(f)) return send(res, 200, []);
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      return send(res, 200, Object.entries(d.heroes).map(([id, h]) => ({
        id,
        name: h.name,
        cls: h.cls,
        color: h.color || '',
        img: (h.web && h.web.img) || '',
        nameArt: (h.web && h.web.name) || '',
        aspect: h.nameAspect || 0,
      })).sort((a, b) => a.name.localeCompare(b.name)));
    }
    const m = /^\/api\/run\/(\w+)$/.exec(url.pathname);
    if (m && req.method === 'POST' && ACTIONS[m[1]]) {
      const [label, args] = ACTIONS[m[1]];
      return send(res, 200, await runTool(label, args));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`Build Bubble Manager: ${url}`);
  if (!process.argv.includes('--no-open') && process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});
