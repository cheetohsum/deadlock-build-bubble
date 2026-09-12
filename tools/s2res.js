// Writes Source 2 Panorama resources (vjs_c / vcss_c / vxml_c) in the text-DATA form the
// Source 2 Viewer reader understands: DATA = CRC32(text) + image list + text (JS: raw text).
// Metadata blocks (RED2, RERL) are copied from stock game files of the same type.
const zlib = require('zlib');

function readBlocks(buf) {
  const typeVersion = buf.readUInt16LE(6);
  const count = buf.readUInt32LE(12);
  const blocks = {};
  for (let i = 0; i < count; i++) {
    const o = 16 + i * 12;
    const type = buf.toString('latin1', o, o + 4);
    const off = o + 4 + buf.readUInt32LE(o + 4);
    blocks[type] = buf.subarray(off, off + buf.readUInt32LE(o + 8));
  }
  return { typeVersion, blocks };
}

function writeResource(typeVersion, blockList) {
  // blockList: [[type, Buffer], ...] in file order
  const tableEnd = 16 + blockList.length * 12;
  const align = (n) => (n + 15) & ~15;
  let cursor = align(tableEnd);
  const placed = blockList.map(([type, data]) => { const at = cursor; cursor = align(at + data.length); return { type, data, at }; });
  const size = placed.length ? placed[placed.length - 1].at + placed[placed.length - 1].data.length : tableEnd;
  const out = Buffer.alloc(size);
  out.writeUInt32LE(size, 0);
  out.writeUInt16LE(12, 4);
  out.writeUInt16LE(typeVersion, 6);
  out.writeUInt32LE(8, 8);
  out.writeUInt32LE(placed.length, 12);
  placed.forEach((b, i) => {
    const o = 16 + i * 12;
    out.write(b.type, o, 'latin1');
    out.writeUInt32LE(b.at - (o + 4), o + 4);
    out.writeUInt32LE(b.data.length, o + 8);
    b.data.copy(out, b.at);
  });
  return out;
}

function textData(text) {
  const body = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(6);
  head.writeUInt32LE(zlib.crc32(body), 0);
  head.writeUInt16LE(0, 4); // no image entries
  return Buffer.concat([head, body]);
}

// template: a stock compiled file of the same kind, used for header version and metadata blocks.
function compileJs(source, template) {
  const t = readBlocks(template);
  return writeResource(t.typeVersion, [['RED2', t.blocks.RED2], ['DATA', Buffer.from(source, 'utf8')]]);
}

// Panorama rejects some web CSS selector syntax, and a stylesheet it cannot parse makes hud.xml fail
// to load: a fatal error at game launch. Refuse the known cases at build time instead.
const UNSUPPORTED_CSS = [
  [/[+~]/, 'sibling combinator (+ or ~)'],
  [/::|:(?:not|is|where|has|nth-[a-z-]+)\(/, 'unsupported pseudo-class or pseudo-element'],
];
function checkPanoramaCss(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const rule = /([^{}]*)\{[^{}]*\}/g;
  let m;
  while ((m = rule.exec(text))) {
    for (const [pattern, what] of UNSUPPORTED_CSS) {
      if (!pattern.test(m[1])) continue;
      const line = text.slice(0, m.index + m[1].search(/\S|$/)).split('\n').length;
      throw new Error(`CSS line ${line}: ${what} in "${m[1].trim()}"; Panorama cannot parse it and the HUD would fail to load`);
    }
  }
}

function compileCss(source, template) {
  checkPanoramaCss(source);
  const t = readBlocks(template);
  return writeResource(t.typeVersion, [['RED2', t.blocks.RED2], ['DATA', textData(source)]]);
}

function compileXml(source, template) {
  const t = readBlocks(template);
  const list = [];
  if (t.blocks.RERL) list.push(['RERL', t.blocks.RERL]);
  list.push(['RED2', t.blocks.RED2], ['DATA', textData(source)]);
  return writeResource(t.typeVersion, list);
}

module.exports = { readBlocks, writeResource, compileJs, compileCss, compileXml };
