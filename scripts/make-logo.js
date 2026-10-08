// Writes assets/logo.svg: the island mark next to "APRON" in Nothing-style dot-matrix
// letters, on a black dotted tile. Pure SVG, so it stays sharp at any size.
const fs = require('fs');
const path = require('path');

// 5x7 dot-matrix glyphs, top row first.
const GLYPHS = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
};

const W = 760;
const H = 240;
const PITCH = 13; // dot spacing in the wordmark
const R = 5.2; // dot radius
const INK = '#0e0e0e';
const WHITE = '#f5f5f5';
const RED = '#d71921';

const f = (n) => Number(n.toFixed(2));
const parts = [];

// Tile with a faint dot grid.
parts.push(`<rect width="${W}" height="${H}" rx="44" fill="${INK}"/>`);
parts.push(`<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="43" fill="none" stroke="#fff" stroke-opacity=".1" stroke-width="2"/>`);
parts.push(`<rect width="${W}" height="${H}" rx="44" fill="url(#grid)"/>`);

// The island: a glowing pill with a dot-matrix waveform and the red live dot.
const mx = 60;
const my = 100;
const mw = 196;
const mh = 66;
parts.push(`<rect x="${mx - 14}" y="${my - 14}" width="${mw + 28}" height="${mh + 28}" rx="${(mh + 28) / 2}" fill="#fff" opacity=".08" filter="url(#glow)"/>`);
parts.push(`<rect x="${mx}" y="${my}" width="${mw}" height="${mh}" rx="${mh / 2}" fill="${WHITE}"/>`);
const heights = [2, 4, 3, 5, 4, 2, 3];
heights.forEach((hgt, i) => {
  const x = mx + 30 + i * 13;
  for (let k = 0; k < hgt; k++) parts.push(`<circle cx="${f(x)}" cy="${f(my + mh / 2 + (k - (hgt - 1) / 2) * 9.5)}" r="3.4" fill="${INK}"/>`);
});
parts.push(`<circle cx="${mx + mw - mh / 2}" cy="${my + mh / 2}" r="15" fill="${RED}"/>`);

// "APRON" in dots.
const word = 'APRON';
let x0 = 300;
const y0 = 74;
for (const ch of word) {
  GLYPHS[ch].forEach((row, r) => {
    [...row].forEach((c, col) => {
      if (c === '#') parts.push(`<circle cx="${f(x0 + col * PITCH + R)}" cy="${f(y0 + r * PITCH + R)}" r="${R}" fill="${WHITE}"/>`);
    });
  });
  x0 += 6 * PITCH;
}
// Nothing's red full stop.
parts.push(`<circle cx="${f(x0 + R)}" cy="${f(y0 + 6 * PITCH + R)}" r="${R}" fill="${RED}"/>`);

// Tagline.
parts.push(
  `<text x="${300}" y="${y0 + 7 * PITCH + 38}" fill="#8a8a8a" font-family="'Space Mono', Consolas, 'Courier New', monospace" font-size="15" letter-spacing="4.2">A DYNAMIC ISLAND FOR WINDOWS</text>`,
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Apron">
<defs>
<pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="8" cy="8" r="1.3" fill="#fff" fill-opacity=".07"/></pattern>
<filter id="glow" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="10"/></filter>
</defs>
${parts.join('\n')}
</svg>
`;

const out = path.join(__dirname, '..', 'assets', 'logo.svg');
fs.writeFileSync(out, svg);
console.log('wrote', out);
