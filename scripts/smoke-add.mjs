import { chromium } from 'playwright';
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = 'http://127.0.0.1:8123';
const SHOT = '/tmp/claude-0/-home-user-Brera-CD-App/993a40f2-1604-5a22-974d-bc3bf4d7d7d4/scratchpad';

const browser = await chromium.launch({ executablePath: EXE });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
function assert(c, m){ if(!c){console.log('FAIL:',m);process.exitCode=1;} else console.log('ok:',m); }

await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(300);
await page.locator('.tab[data-tab="spares"]').click();
await page.waitForTimeout(200);
await page.locator('#add-cd').click();
await page.waitForTimeout(400);
assert(await page.locator('.modal .segmented').isVisible(), 'add sheet opens with mode toggle');
await page.screenshot({ path: SHOT + '/04-add-album.png' });

// Album search triggers network failure -> specific error, no crash
await page.locator('#album-q').fill('daft punk');
await page.waitForTimeout(1200);
const status = await page.locator('#album-status').innerText();
console.log('album search status text:', JSON.stringify(status));
assert(/network|reach|connection|itunes/i.test(status), 'album search shows specific network error (graceful)');
await page.screenshot({ path: SHOT + '/05-add-error.png' });

// Burnt mode toggle renders
await page.locator('.segmented button[data-mode="burnt"]').click();
await page.waitForTimeout(200);
assert(await page.locator('#bt-name').isVisible(), 'burnt mode renders disc-name field');
assert((await page.locator('#add-content').innerText()).includes('Various Artists'), 'burnt mode auto-fills Various Artists');
await page.screenshot({ path: SHOT + '/06-add-burnt.png' });

await browser.close();
