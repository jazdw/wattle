/**
 * Rasterises public/logo.svg into the PWA / home-screen PNG icons.
 * Run with: npm run icons
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(resolve(root, 'public/logo.svg'), 'utf8');
const outDir = resolve(root, 'public/icons');
mkdirSync(outDir, { recursive: true });

// Maskable icons need the artwork inside the central 80% safe zone, on a
// full-bleed background.
// full-bleed background. scripts/logo.mjs marks the artwork with comments.
if (!svg.includes('<!--art-->')) throw new Error('favicon.svg lacks <!--art--> markers; regenerate it with scripts/logo.mjs');
const maskable = svg
  .replaceAll(' rx="14"', '')
  .replace('<!--art-->', '<g transform="translate(6.4 6.4) scale(0.8)">')
  .replace('<!--/art-->', '</g>');

const outputs = [
  ['icon-192.png', svg, 192],
  ['icon-512.png', svg, 512],
  ['apple-touch-icon.png', maskable, 180],
  ['icon-maskable-512.png', maskable, 512],
];

for (const [name, source, size] of outputs) {
  const png = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(resolve(outDir, name), png);
  console.log(`wrote public/icons/${name}`);
}
