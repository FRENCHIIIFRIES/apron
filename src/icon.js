// Draws Apron's icons as PNGs in memory, so the repo needs no binary assets.
// The app icon is a black tile with a faint dot-matrix grid and the island itself in the
// middle: a glowing pill with a dot-matrix waveform and Nothing's red "live" dot.
const zlib = require('zlib');

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distances (negative inside), in pixels.
const roundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const pill = (x0, x1, cy, r) => (x, y) => Math.hypot(x - Math.max(x0, Math.min(x1, x)), y - cy) - r;
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const union = (...shapes) => (x, y) => Math.min(...shapes.map((s) => s(x, y)));

/**
 * Paints layers back to front with 4x4 supersampling. A layer is { shape, color: [r,g,b,a] }
 * plus an optional clip shape, or { glow: shape, color, radius } for a soft halo outside a shape.
 */
function paint(size, layers) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          // premultiplied "over" compositing
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const l of layers) {
            let cov;
            if (l.glow) {
              const d = l.glow(x, y);
              cov = d > 0 ? Math.exp(-d / l.radius) : 1;
            } else cov = l.shape(x, y) <= 0 ? 1 : 0;
            if (l.clip && l.clip(x, y) > 0) cov = 0;
            const la = l.color[3] * cov;
            if (!la) continue;
            cr = l.color[0] * la + cr * (1 - la);
            cg = l.color[1] * la + cg * (1 - la);
            cb = l.color[2] * la + cb * (1 - la);
            ca = la + ca * (1 - la);
          }
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      out[i] = alpha ? Math.round(r / n / alpha) : 0;
      out[i + 1] = alpha ? Math.round(g / n / alpha) : 0;
      out[i + 2] = alpha ? Math.round(b / n / alpha) : 0;
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

const INK = [14, 14, 14];
const WHITE = [245, 245, 245];
const RED = [215, 25, 33]; // Nothing red

/** The app icon (installer, taskbar, Start menu, windows, tray). */
function appIconPng(size = 256) {
  const s = size;
  const detailed = size >= 64;
  const m = s * (detailed ? 0.04 : 0.02);
  const tile = roundRect(s / 2, s / 2, s / 2 - m, s / 2 - m, s * 0.23);
  const half = s * 0.2;
  const rad = s * 0.105;
  const cy = s * 0.5;
  const island = pill(s / 2 - half, s / 2 + half, cy, rad);
  const layers = [{ shape: tile, color: [...INK, 1] }];
  if (detailed) {
    // faint dot-matrix grid across the tile
    const step = s / 16;
    const grid = (x, y) => {
      const gx = (Math.floor(x / step) + 0.5) * step;
      const gy = (Math.floor(y / step) + 0.5) * step;
      return Math.hypot(x - gx, y - gy) - s * 0.0085;
    };
    layers.push({ shape: grid, clip: tile, color: [255, 255, 255, 0.09] });
    // hairline edge so the tile holds up on black backgrounds
    layers.push({ shape: (x, y) => Math.abs(tile(x, y) + s * 0.006) - s * 0.004, color: [255, 255, 255, 0.12] });
    layers.push({ glow: island, radius: s * 0.045, clip: tile, color: [255, 255, 255, 0.22] });
  }
  layers.push({ shape: island, color: [...WHITE, 1] });
  if (detailed) {
    // dot-matrix waveform on the left of the island
    const dot = s * 0.0115;
    const across = s * 0.046;
    const down = s * 0.03;
    const heights = [2, 4, 3, 5, 4, 2, 3];
    const dots = [];
    heights.forEach((h, i) => {
      const x = s / 2 - half - rad * 0.1 + i * across;
      for (let k = 0; k < h; k++) dots.push(circle(x, cy + (k - (h - 1) / 2) * down, dot));
    });
    layers.push({ shape: union(...dots), color: [...INK, 1] });
  }
  // red "live" dot in the right end of the island
  layers.push({ shape: circle(s / 2 + half, cy, rad * (detailed ? 0.46 : 0.55)), color: [...RED, 1] });
  return encodePng(size, paint(size, layers));
}

/** A multi-size .ico (PNG entries, fine on Windows Vista and later). */
function icoFile(sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const pngs = sizes.map((sz) => appIconPng(sz));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((sz, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(sz >= 256 ? 0 : sz, e);
    header.writeUInt8(sz >= 256 ? 0 : sz, e + 1);
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, ...pngs]);
}

module.exports = { appIconPng, icoFile };
