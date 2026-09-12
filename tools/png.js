// Minimal PNG reader for 8-bit greyscale, RGB, palette, grey+alpha and RGBA images.
// Returns alpha-weighted mean luminance (0-255) and the share of the image that is opaque.
const zlib = require('zlib');

const PNG_SIGNATURE = '89504e470d0a1a0a';

function measurePng(buf) {
  if (!buf || buf.length < 8 || buf.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) return null;
  let o = 8, w = 0, h = 0, depth = 0, type = 0, palette = null, trns = null;
  const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const t = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (t === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; }
    else if (t === 'PLTE') palette = data;
    else if (t === 'tRNS') trns = data;
    else if (t === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !channels || !w || !h) return null;

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? px[(y - 1) * stride + x - channels] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }

  let lum = 0, alpha = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const p = i * channels;
    let r, g, bl, al = 1;
    if (type === 3) {
      const idx = px[p];
      r = palette ? palette[idx * 3] : 0; g = palette ? palette[idx * 3 + 1] : 0; bl = palette ? palette[idx * 3 + 2] : 0;
      al = trns && idx < trns.length ? trns[idx] / 255 : 1;
    } else if (channels >= 3) {
      r = px[p]; g = px[p + 1]; bl = px[p + 2];
      if (channels === 4) al = px[p + 3] / 255;
    } else {
      r = g = bl = px[p];
      if (channels === 2) al = px[p + 1] / 255;
    }
    lum += (0.2126 * r + 0.7152 * g + 0.0722 * bl) * al;
    alpha += al;
  }
  return { luminance: alpha ? lum / alpha : 0, coverage: alpha / n };
}

module.exports = { measurePng };
