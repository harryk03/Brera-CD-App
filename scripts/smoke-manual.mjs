import { chromium } from 'playwright';
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = 'http://127.0.0.1:8123';
const SHOT = '/tmp/claude-0/-home-user-Brera-CD-App/993a40f2-1604-5a22-974d-bc3bf4d7d7d4/scratchpad';

const browser = await chromium.launch({ executablePath: EXE });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
function assert(c, m) { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); }

await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
await page.locator('.tab[data-tab="spares"]').click();
await page.waitForTimeout(200);

// ===== Album manual entry =====
await page.locator('#add-cd').click();
await page.waitForTimeout(400);
assert(await page.locator('#album-manual').isVisible(), 'manual button visible immediately (before any search)');
await page.locator('#album-manual').click();
await page.waitForTimeout(200);
assert(await page.locator('#rv-title').isVisible(), 'blank review opens');
assert((await page.locator('#rv-title').inputValue()) === '', 'title starts empty');
assert((await page.locator('#rv-artist').inputValue()) === '', 'artist starts empty');
assert((await page.locator('#rv-tracks .track-edit-row').count()) === 1, 'one empty track row to start');
assert(await page.locator('#rv-cover .preview, #rv-cover span.preview').first().isVisible(), 'gradient/initials cover placeholder shown');

// live initials update
await page.locator('#rv-title').fill('Channel Orange');
await page.waitForTimeout(100);
const initialsText = (await page.locator('#rv-cover span.preview').innerText()).trim();
assert(initialsText === 'CO', `initials preview updates live (got "${initialsText}")`);

// validation: missing artist
await page.locator('#rv-confirm').click();
await page.waitForTimeout(100);
assert(/required/i.test(await page.locator('#rv-error').innerText()), 'blocks save when artist empty');

// validation: missing track text
await page.locator('#rv-artist').fill('Frank Ocean');
await page.locator('#rv-confirm').click();
await page.waitForTimeout(100);
assert(/at least one track/i.test(await page.locator('#rv-error').innerText()), 'blocks save with no non-empty track');

// fill tracks and save
await page.locator('#rv-tracks .track-edit-row [data-role="title"]').first().fill('Thinkin Bout You');
await page.locator('#rv-add-track').click();
await page.waitForTimeout(100);
await page.locator('#rv-tracks .track-edit-row [data-role="title"]').nth(1).fill('   '); // whitespace-only, should be trimmed out
await page.locator('#rv-add-track').click();
await page.waitForTimeout(100);
await page.locator('#rv-tracks .track-edit-row [data-role="title"]').nth(2).fill('Pyramids');
await page.screenshot({ path: SHOT + '/07-manual-review.png' });
await page.locator('#rv-confirm').click();
await page.waitForTimeout(500);
assert((await page.locator('.modal').count()) === 0, 'sheet closes after manual save');
const titles = await page.locator('#spares-list .card-title').allInnerTexts();
assert(titles.some(t => t.includes('Channel Orange')), 'manual album landed in Spares');

// verify tracks persisted correctly (whitespace row dropped => 2 tracks)
await page.locator('#spares-list .card', { hasText: 'Channel Orange' }).click();
await page.waitForTimeout(700);
assert((await page.locator('.sheet .track').count()) === 2, 'whitespace-only track row was trimmed (2 tracks)');
await page.locator('.sheet-close').click();
await page.waitForTimeout(900);

// duplicate check on manual add
await page.locator('#add-cd').click();
await page.waitForTimeout(300);
await page.locator('#album-manual').click();
await page.waitForTimeout(150);
await page.locator('#rv-title').fill('channel orange');   // case-insensitive
await page.locator('#rv-artist').fill('FRANK OCEAN');
await page.locator('#rv-tracks .track-edit-row [data-role="title"]').first().fill('X');
await page.locator('#rv-confirm').click();
await page.waitForTimeout(150);
assert(/already in your collection/i.test(await page.locator('#rv-error').innerText()), 'duplicate check runs on manual add');
await page.locator('.modal-close').click();
await page.waitForTimeout(400);

// ===== Burnt CD manual song entry =====
await page.locator('#add-cd').click();
await page.waitForTimeout(300);
await page.locator('.segmented button[data-mode="burnt"]').click();
await page.waitForTimeout(200);
await page.locator('#bt-name').fill('Rare Mix');
assert(await page.locator('#bt-manual').isVisible(), 'burnt manual button visible');
await page.locator('#bt-manual').click();
await page.waitForTimeout(150);
assert(await page.locator('#ms-title').isVisible(), 'manual song form opens');
// validation
await page.locator('#ms-add').click();
await page.waitForTimeout(100);
assert(/required/i.test(await page.locator('#ms-error').innerText()), 'manual song blocks when title/artist empty');
// add a song
await page.locator('#ms-title').fill('Obscure Track (feat. Someone)');
await page.locator('#ms-artist').fill('Unknown Artist');
await page.locator('#ms-add').click();
await page.waitForTimeout(150);
assert((await page.locator('#bt-chosen .chosen').count()) === 1, 'manual song appended to tracklist');
assert(/feat\. Someone/i.test(await page.locator('#bt-chosen').innerText()), 'feat parsed from manual song title');
assert(/Unknown Artist/i.test(await page.locator('#bt-chosen').innerText()), 'manual song keeps its own artist');
assert((await page.locator('#ms-title').inputValue()) === '', 'form clears for adding another');
await page.screenshot({ path: SHOT + '/08-burnt-manual.png' });
// confirm burnt disc
await page.locator('#bt-confirm').click();
await page.waitForTimeout(500);
await page.locator('.tab[data-tab="spares"]').click();
await page.waitForTimeout(200);
assert((await page.locator('#spares-list .card', { hasText: 'Rare Mix' }).count()) === 1, 'burnt disc with manual song saved to Spares');

console.log('\nPAGE ERRORS:', errors.length ? errors : 'none');
if (errors.length) process.exitCode = 1;
await browser.close();
