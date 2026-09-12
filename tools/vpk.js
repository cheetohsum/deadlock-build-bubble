// Minimal VPK v2 writer: every file lives inside the _dir.vpk itself (archive index 0x7fff).
const fs = require('fs');
const zlib = require('zlib');

function writeVpk(outPath, files) {
  // files: [{ path: 'panorama/scripts/x.vjs_c', data: Buffer }]
  const tree = new Map(); // ext -> dir -> [{ name, data }]
  for (const f of files) {
    const norm = f.path.replace(/\\/g, '/').toLowerCase();
    const slash = norm.lastIndexOf('/');
    const dir = slash < 0 ? ' ' : norm.slice(0, slash);
    const file = norm.slice(slash + 1);
    const dot = file.lastIndexOf('.');
    const ext = dot < 0 ? ' ' : file.slice(dot + 1);
    const name = dot < 0 ? file : file.slice(0, dot);
    if (!tree.has(ext)) tree.set(ext, new Map());
    const dirs = tree.get(ext);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push({ name, data: f.data });
  }

  const treeParts = [];
  const dataParts = [];
  let dataOffset = 0;
  const cstr = (s) => Buffer.from(s + '\0', 'latin1');
  for (const [ext, dirs] of tree) {
    treeParts.push(cstr(ext));
    for (const [dir, entries] of dirs) {
      treeParts.push(cstr(dir));
      for (const e of entries) {
        treeParts.push(cstr(e.name));
        const meta = Buffer.alloc(18);
        meta.writeUInt32LE(zlib.crc32(e.data), 0);
        meta.writeUInt16LE(0, 4);          // preload bytes
        meta.writeUInt16LE(0x7fff, 6);     // data follows the tree in this file
        meta.writeUInt32LE(dataOffset, 8);
        meta.writeUInt32LE(e.data.length, 12);
        meta.writeUInt16LE(0xffff, 16);
        treeParts.push(meta);
        dataParts.push(e.data);
        dataOffset += e.data.length;
      }
      treeParts.push(cstr(''));
    }
    treeParts.push(cstr(''));
  }
  treeParts.push(cstr(''));

  const treeBuf = Buffer.concat(treeParts);
  const header = Buffer.alloc(28);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(treeBuf.length, 8);
  header.writeUInt32LE(dataOffset, 12); // file data section size
  // archive MD5, other MD5 and signature sections are left empty
  fs.writeFileSync(outPath, Buffer.concat([header, treeBuf, ...dataParts]));
}

module.exports = { writeVpk };
