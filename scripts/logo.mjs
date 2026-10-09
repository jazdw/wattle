#!/usr/bin/env node
/**
 * Generates public/logo.svg (app icons, sidebar, login) and the simpler
 * public/favicon.svg (browser tab): a sprig of golden wattle (Acacia pycnantha),
 * Australia's floral emblem — fluffy golden flower heads on a curving stem with
 * sickle-shaped phyllodes, on a deep eucalypt tile.
 *
 * Each flower head is a soft golden sphere ringed by tiny stamen tips, so it
 * reads as a puffball at large sizes and as a clean gold dot at 16px. Random
 * placement is seeded, so the output is stable.
 *
 *   node scripts/logo.mjs && npm run icons
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let seed = 20261009;
function random() {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}
const fixed = (value) => Math.round(value * 100) / 100;

/** A flower head: shadow, body, stamen fringe, highlights. `detail` = 0 (tab icon) or 1. */
function flower(cx, cy, r, detail = 1) {
  const parts = [];
  parts.push(`<circle cx="${fixed(cx + r * 0.12)}" cy="${fixed(cy + r * 0.16)}" r="${fixed(r * 1.02)}" fill="#0b1f1a" opacity="0.35"/>`);
  parts.push(`<circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="${fixed(r * 0.94)}" fill="url(#head)"/>`);
  // Stamen tips around the rim, denser and brighter toward the light (upper left).
  const count = detail ? Math.round(16 + r * 6) : Math.round(10 + r * 1.5);
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 + random() * 0.4;
    const distance = r * (0.86 + random() * 0.2);
    const lit = Math.cos(angle + Math.PI * 0.75) > 0;
    const color = lit ? (random() > 0.5 ? '#ffe36e' : '#ffd23f') : random() > 0.5 ? '#f2b705' : '#e3a400';
    parts.push(
      `<circle cx="${fixed(cx + Math.cos(angle) * distance)}" cy="${fixed(cy + Math.sin(angle) * distance)}" r="${fixed(r * (detail ? 0.1 + random() * 0.05 : 0.17))}" fill="${color}"/>`,
    );
  }
  // Speckled texture inside the head.
  for (let index = 0; index < (detail ? Math.round(r * 3) : 0); index += 1) {
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * r * 0.7;
    parts.push(
      `<circle cx="${fixed(cx + Math.cos(angle) * distance)}" cy="${fixed(cy + Math.sin(angle) * distance)}" r="${fixed(r * 0.07)}" fill="#fff3b0" opacity="${fixed(0.35 + random() * 0.4)}"/>`,
    );
  }
  return parts.join('');
}

/** A sickle-shaped phyllode from `base` toward `tip`, bowed by `bend` (signed). */
function phyllode(base, tip, width, bend) {
  const [x1, y1] = base;
  const [x2, y2] = tip;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const nx = -dy / length;
  const ny = dx / length;
  // Midrib curve control point, bowed sideways.
  const mx = x1 + dx * 0.5 + nx * bend;
  const my = y1 + dy * 0.5 + ny * bend;
  const edge = (side) => [mx + nx * width * side, my + ny * width * side];
  const [ax, ay] = edge(1);
  const [bx, by] = edge(-1);
  return [
    `<path d="M${fixed(x1)} ${fixed(y1)} Q${fixed(ax)} ${fixed(ay)} ${fixed(x2)} ${fixed(y2)} Q${fixed(bx)} ${fixed(by)} ${fixed(x1)} ${fixed(y1)}Z" fill="url(#leaf)"/>`,
    `<path d="M${fixed(x1)} ${fixed(y1)} Q${fixed(mx)} ${fixed(my)} ${fixed(x2)} ${fixed(y2)}" fill="none" stroke="#b9d39a" stroke-width="0.45" stroke-linecap="round" opacity="0.7"/>`,
  ].join('');
}

const detailed = {
  title: 'Wattle Wealth',
  detail: 1,
  leaves: [
    [[22, 45], [3, 52], 5.2, -4],
    [[32, 32], [52, 43], 5, 5],
    [[44, 19], [61, 32], 4, 3.5],
  ],
  stem: 'M11 57 C 19 47, 27 37, 36 28 S 49 13, 55 8',
  stalks: [
    'M30.5 34 C 28 30, 24 26, 19 24',
    'M36 28 C 34 22, 31 17, 27 13',
    'M43 21 C 46 20, 50 20, 54 22',
    'M24 41 C 21 39, 17 38, 13 38',
  ],
  // [cx, cy, r] — the larger heads sit at the stalk tips, buds toward the ends.
  heads: [
    [18.5, 23.5, 5.4],
    [26.5, 12.5, 5.6],
    [37.5, 20.5, 4.6],
    [48.5, 11, 5],
    [55, 22.5, 4.2],
    [12.5, 37.5, 4.4],
    [27, 32.5, 3.6],
    [56.5, 7, 2.4],
    [33, 9.5, 2.2],
    [9, 29.5, 2],
  ],
};

/** Browser-tab version: four big heads that stay legible at 16px. */
const simple = {
  title: 'Wattle Wealth',
  detail: 0,
  leaves: [[[24, 44], [4, 54], 6.5, -4]],
  stem: 'M12 56 C 22 44, 32 32, 52 12',
  stalks: ['M27 41 C 24 36, 22 31, 21 27', 'M40 26 C 44 27, 48 29, 50 33'],
  heads: [
    [20, 21, 8.6],
    [40, 14, 8.6],
    [32, 34, 7.2],
    [51, 34, 6.6],
  ],
};

function render({ leaves, stem, stalks, heads, detail, title }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Wattle Wealth">
<title>${title}</title>
<defs>
<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#25493f"/><stop offset="1" stop-color="#142c25"/></linearGradient>
<radialGradient id="glow" cx="0.55" cy="0.35" r="0.6"><stop offset="0" stop-color="#f2b705" stop-opacity="0.22"/><stop offset="1" stop-color="#f2b705" stop-opacity="0"/></radialGradient>
<radialGradient id="head" cx="0.38" cy="0.32" r="0.75"><stop offset="0" stop-color="#fff0a0"/><stop offset="0.45" stop-color="#ffcf1f"/><stop offset="1" stop-color="#d79600"/></radialGradient>
<linearGradient id="leaf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7fb06f"/><stop offset="1" stop-color="#3f7552"/></linearGradient>
</defs>
<rect width="64" height="64" rx="14" fill="url(#tile)"/>
<rect width="64" height="64" rx="14" fill="url(#glow)"/>
<!--art-->
${leaves.map(([base, tip, width, bend]) => phyllode(base, tip, width, bend)).join('\n')}
<path d="${stem}" fill="none" stroke="#8c7a3c" stroke-width="${detail ? 2 : 3}" stroke-linecap="round"/>
${stalks.map((d) => `<path d="${d}" fill="none" stroke="#8c7a3c" stroke-width="${detail ? 1.2 : 2.2}" stroke-linecap="round"/>`).join('\n')}
${heads.map(([cx, cy, r]) => flower(cx, cy, r, detail)).join('\n')}
<!--/art-->
</svg>
`;
}

for (const [file, spec] of [
  ['public/logo.svg', detailed],
  ['public/favicon.svg', simple],
]) {
  const svg = render(spec);
  writeFileSync(resolve(root, file), svg);
  console.log(`wrote ${file} (${(svg.length / 1024).toFixed(1)} KB)`);
}
