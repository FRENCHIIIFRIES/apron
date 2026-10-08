// Writes assets/logo.svg: an apron (neck strap, bib, waist ties, pocket and Nothing's red
// dot) next to "APRON" in dot-matrix letters, on a black dotted tile. Pure SVG, so it
// stays sharp at any size. Also exports the apron path for other places that need it.
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

const INK = '#0e0e0e';
const WHITE = '#f5f5f5';
const RED = '#d71921';

/**
 * The apron drawn in a 100x100 box: SVG elements as strings. `ink` is the colour behind it
 * (used for the pocket stitching).
 */
function apron(ink = INK) {
  return [
    // neck strap
    `<path d="M40 30 C40 9 60 9 60 30" fill="none" stroke="${WHITE}" stroke-width="4.5" stroke-linecap="round"/>`,
    // waist ties, with their loose ends hanging down
    `<path d="M31 53 C23 53 18 57 14 66 M31 53 C25 55 23 60 23 69 M69 53 C77 53 82 57 86 66 M69 53 C75 55 77 60 77 69" fill="none" stroke="${WHITE}" stroke-width="3.6" stroke-linecap="round"/>`,
    // bib + skirt in one piece: narrow at the top, nipped at the waist, flared at the hem
    `<path d="M37 28 H63 Q65 28 65 31 L66 47 Q66 50 69 51 L70 51 Q72 52 72 55 L77 87 Q78 94 71 94 H29 Q22 94 23 87 L28 55 Q28 52 30 51 L31 51 Q34 50 34 47 L35 31 Q35 28 37 28 Z" fill="${WHITE}"/>`,
    // waist band seam
    `<path d="M30.5 56 H69.5" stroke="${ink}" stroke-width="1.6" stroke-dasharray="2.2 2.2" stroke-linecap="round"/>`,
    // pocket, dot-stitched
    `<rect x="40" y="66" width="20" height="15" rx="3" fill="none" stroke="${ink}" stroke-width="1.6" stroke-dasharray="2.2 2.2" stroke-linecap="round"/>`,
    // the red dot
    `<circle cx="50" cy="39" r="4.6" fill="${RED}"/>`,
  ].join('\n');
}

function logoSvg() {
  const W = 760;
  const H = 240;
  const PITCH = 13;
  const R = 5.2;
  const f = (n) => Number(n.toFixed(2));
  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" rx="44" fill="${INK}"/>`);
  parts.push(`<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="43" fill="none" stroke="#fff" stroke-opacity=".1" stroke-width="2"/>`);
  parts.push(`<rect width="${W}" height="${H}" rx="44" fill="url(#grid)"/>`);
  // the apron, with a soft glow behind it
  parts.push(`<circle cx="160" cy="124" r="80" fill="#fff" opacity=".07" filter="url(#glow)"/>`);
  parts.push(`<g transform="translate(70 30) scale(1.8)">\n${apron()}\n</g>`);
  // "APRON." in dots
  let x = 300;
  const y = 74;
  for (const ch of 'APRON') {
    GLYPHS[ch].forEach((row, r) => {
      [...row].forEach((c, col) => {
        if (c === '#') parts.push(`<circle cx="${f(x + col * PITCH + R)}" cy="${f(y + r * PITCH + R)}" r="${R}" fill="${WHITE}"/>`);
      });
    });
    x += 6 * PITCH;
  }
  parts.push(`<circle cx="${f(x + R)}" cy="${f(y + 6 * PITCH + R)}" r="${R}" fill="${RED}"/>`);
  parts.push(
    `<text x="300" y="${y + 7 * PITCH + 38}" fill="#8a8a8a" font-family="'Space Mono', Consolas, 'Courier New', monospace" font-size="15" letter-spacing="4.2">A DYNAMIC ISLAND FOR WINDOWS</text>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Apron">
<defs>
<pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="8" cy="8" r="1.3" fill="#fff" fill-opacity=".07"/></pattern>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="18"/></filter>
</defs>
${parts.join('\n')}
</svg>
`;
}

if (require.main === module) {
  const out = path.join(__dirname, '..', 'assets', 'logo.svg');
  fs.writeFileSync(out, logoSvg());
  console.log('wrote', out);
}

module.exports = { apron, logoSvg };
