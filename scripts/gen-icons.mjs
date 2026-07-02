import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '..', 'icons');

// Source badge (monochrome Alfa Romeo roundel on a white, landscape canvas).
// We auto-detect the badge's bounding box, crop to a centred square, and bake
// it onto the app's cream background with a "multiply" composite so the white
// drops out and the dark line-art is kept. (All done here at generation time
// to produce flat PNGs — no runtime blend on mobile.)
const badge = readFileSync(join(iconsDir, 'alfa-badge-source.png'));
const dataUrl = 'data:image/png;base64,' + badge.toString('base64');

const CREAM = '#F1EEE7';

// size -> scale% of the tile the badge should occupy
const TARGETS = [
  { name: 'icon-192.png', size: 192, scale: 0.86 },
  { name: 'icon-512.png', size: 512, scale: 0.86 },
  { name: 'icon-180.png', size: 180, scale: 0.86 },
  { name: 'icon-maskable-512.png', size: 512, scale: 0.66 }, // safe zone
];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();

const results = await page.evaluate(async ({ dataUrl, cream, targets }) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });

  // --- detect ink bounding box ---
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  const { data, width, height } = cx.getImageData(0, 0, c.width, c.height);
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (a > 20 && lum < 180) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const bw = maxX - minX, bh = maxY - minY;
  const ccx = minX + bw / 2, ccy = minY + bh / 2;
  const side = Math.max(bw, bh) * 1.06; // small padding
  const sx = ccx - side / 2, sy = ccy - side / 2;

  const out = {};
  for (const t of targets) {
    const tile = document.createElement('canvas');
    tile.width = t.size; tile.height = t.size;
    const g = tile.getContext('2d');
    g.fillStyle = cream;
    g.fillRect(0, 0, t.size, t.size);
    g.globalCompositeOperation = 'multiply'; // white -> cream, dark stays
    const draw = t.size * t.scale;
    const off = (t.size - draw) / 2;
    g.drawImage(img, sx, sy, side, side, off, off, draw, draw);
    g.globalCompositeOperation = 'source-over';
    out[t.name] = tile.toDataURL('image/png');
  }
  return out;
}, { dataUrl, cream: CREAM, targets: TARGETS });

for (const [name, url] of Object.entries(results)) {
  const b64 = url.split(',')[1];
  writeFileSync(join(iconsDir, name), Buffer.from(b64, 'base64'));
  console.log('wrote', name);
}

await browser.close();
