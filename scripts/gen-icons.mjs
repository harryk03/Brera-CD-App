import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const iconsDir = join(root, 'icons');

const baseSvg = readFileSync(join(iconsDir, 'icon.svg'), 'utf8');

// Maskable variant: same art, inset ~12% so the safe zone survives masking.
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#F1EEE7"/>
  <g transform="translate(256 256) scale(0.76) translate(-256 -256)">
    ${baseSvg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}
  </g>
</svg>`;

async function renderSvgToPng(browser, svg, size, outPath) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  await page.setContent(
    `<!doctype html><html><body style="margin:0;padding:0">
      <img src="${dataUrl}" style="width:${size}px;height:${size}px;display:block"/>
     </body></html>`
  );
  await page.waitForLoadState('networkidle');
  const buf = await page.locator('img').screenshot({ omitBackground: false });
  writeFileSync(outPath, buf);
  await page.close();
  console.log('wrote', outPath);
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
await renderSvgToPng(browser, baseSvg, 192, join(iconsDir, 'icon-192.png'));
await renderSvgToPng(browser, baseSvg, 512, join(iconsDir, 'icon-512.png'));
await renderSvgToPng(browser, baseSvg, 180, join(iconsDir, 'icon-180.png'));
await renderSvgToPng(browser, maskableSvg, 512, join(iconsDir, 'icon-maskable-512.png'));
await browser.close();
