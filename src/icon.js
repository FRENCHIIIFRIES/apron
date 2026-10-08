// Draws Apron's icons as PNGs in memory, so the repo needs no binary assets.
// The app icon is a black tile with a faint dot-matrix grid and a white apron in the
// middle (neck strap, waist ties, a stitched pocket) wearing Nothing's red dot. It matches
// the logo in assets/logo.svg (scripts/make-logo.js), drawn in the same 100x100 units.
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

// Signed distances (negative inside).
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const roundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const union = (...shapes) => (x, y) => Math.min(...shapes.map((s) => s(x, y)));
/** A line through the points, w thick, with round ends and joins. */
const stroke = (pts, w) => (x, y) => {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const t = clamp01(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2));
    d = Math.min(d, Math.hypot(x - ax - (bx - ax) * t, y - ay - (by - ay) * t));
  }
  return d - w / 2;
};
/** Filled polygon (even-odd), after Inigo Quilez's sdPolygon. */
const polygon = (pts) => (x, y) => {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    const ex = xj - xi;
    const ey = yj - yi;
    const t = clamp01(((x - xi) * ex + (y - yi) * ey) / (ex * ex + ey * ey));
    d = Math.min(d, Math.hypot(x - xi - ex * t, y - yi - ey * t));
    if (yi > y !== yj > y && x < xi + ((y - yi) * ex) / ey) inside = !inside;
  }
  return inside ? -d : d;
};
/** Points along a cubic Bézier, for strokes. */
function bezier(p0, p1, p2, p3, n = 10) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([0, 1].map((k) => u ** 3 * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t ** 3 * p3[k]));
  }
  return out;
}

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

// The apron in 100x100 units (same outline as the logo).
const APRON_BODY = [
  [37, 28], [63, 28], [65, 31], [66, 47], [69, 51], [70, 51], [72, 55], [77, 87], [76, 92], [71, 94],
  [29, 94], [24, 92], [23, 87], [28, 55], [30, 51], [31, 51], [34, 47], [35, 31],
];
const STRAP = bezier([40, 30], [40, 9], [60, 9], [60, 30]);
const TIES = [
  bezier([31, 53], [23, 53], [18, 57], [14, 66]),
  bezier([31, 53], [25, 55], [23, 60], [23, 69]),
  bezier([69, 53], [77, 53], [82, 57], [86, 66]),
  bezier([69, 53], [75, 55], [77, 60], [77, 69]),
];

const cache = new Map();

/** The app icon (installer, taskbar, Start menu, windows, tray). Drawn once per size. */
function appIconPng(size = 256) {
  if (!cache.has(size)) cache.set(size, drawIcon(size));
  return cache.get(size);
}

function drawIcon(size) {
  const s = size;
  const detailed = size >= 48;
  const m = s * (detailed ? 0.04 : 0.02);
  const tile = roundRect(s / 2, s / 2, s / 2 - m, s / 2 - m, s * 0.23);
  // Apron units -> pixels: the apron (y 9..94) fills about 70% of the tile, centred.
  const k = (s * (detailed ? 0.0082 : 0.0092));
  const ox = s / 2 - 50 * k;
  const oy = s / 2 - 51.5 * k;
  const px = (shape) => (x, y) => shape((x - ox) / k, (y - oy) / k) * k;
  // Thin parts get a minimum pixel width so small icons stay crisp.
  const w = (units, minPx) => Math.max(units, minPx / k);

  const body = px(polygon(APRON_BODY));
  const strap = px(stroke(STRAP, w(4.5, detailed ? 0 : 1.3)));
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
    layers.push({ glow: body, radius: s * 0.05, clip: tile, color: [255, 255, 255, 0.18] });
  }
  const white = [body, strap];
  if (size >= 32) white.push(...TIES.map((t) => px(stroke(t, w(3.6, 1)))));
  layers.push({ shape: union(...white), color: [...WHITE, 1] });
  if (detailed) {
    // stitched waist seam and pocket
    const dash = (shape, period) => (x, y) => (Math.floor(((x - ox) / k + (y - oy) / k) / period) % 2 ? 1 : shape(x, y));
    layers.push({ shape: dash(px(stroke([[30.5, 56], [69.5, 56]], 1.6)), 2.2), color: [...INK, 1] });
    layers.push({ shape: dash((x, y) => Math.abs(px(roundRect(50, 73.5, 10, 7.5, 3))(x, y)) - 0.8 * k, 2.2), color: [...INK, 1] });
  }
  // Nothing's red dot on the bib
  layers.push({ shape: px(circle(50, 39, detailed ? 4.6 : 6)), color: [...RED, 1] });
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
