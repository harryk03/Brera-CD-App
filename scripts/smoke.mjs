import { chromium } from 'playwright';

const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = 'http://127.0.0.1:8123';
const SHOT = '/tmp/claude-0/-home-user-Brera-CD-App/993a40f2-1604-5a22-974d-bc3bf4d7d7d4/scratchpad';

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

function assert(cond, msg) { if (!cond) { console.log('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); }

await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// 1) Loads clean, empty state
assert(await page.locator('#view-stacker .app-title').innerText() === 'Brera Stacker', 'title renders');
assert((await page.locator('.slot-empty').count()) === 10, '10 empty stacker slots');
assert(await page.locator('#dash-empty').isVisible(), 'empty dash placeholder');
await page.screenshot({ path: SHOT + '/01-stacker-empty.png' });

// 2) Seed state directly into IndexedDB, then reload (tests persistence layer shape)
await page.evaluate(() => new Promise((resolve, reject) => {
  const mk = (title, artist, isBurnt, tracks, extra = {}) => ({
    id: crypto.randomUUID(), title, artist, isBurnt,
    coverImageUri: null, palette: ['#3a4d6b', '#6b3a4d'],
    features: extra.features || {}, trackArtists: extra.trackArtists || null,
    tracks, dateAdded: Date.now(),
  });
  const state = {
    stacker: [
      mk('OK Computer', 'Radiohead', false, ['Airbag', 'Paranoid Android', 'Karma Police']),
      ...Array(9).fill(null),
    ],
    dash: null,
    spares: [
      mk('Random Access Memories', 'Daft Punk', false,
         ['Give Life Back to Music', 'Get Lucky'],
         { features: { 'Get Lucky': 'Pharrell Williams' } }),
      mk('Summer Drive', 'Various Artists', true,
         ['Song A', 'Song B'],
         { trackArtists: ['Artist One', 'Artist Two'], features: { 'Song A': 'Guest' } }),
    ],
  };
  const req = indexedDB.open('brera-stacker', 1);
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('state', 'readwrite');
    tx.objectStore('state').put({ key: 'app', data: state });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
}));

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// 3) Seeded stacker album renders
assert((await page.locator('#stacker-list .card').count()) === 1, 'one filled stacker card after reload (persistence)');
assert((await page.locator('#stacker-list .card-title').first().innerText()).includes('OK Computer'), 'stacker album title persisted');

// 4) Tracklist opens (container transform) from stacker
await page.locator('#stacker-list .card').first().click();
await page.waitForTimeout(800);
assert(await page.locator('.sheet').isVisible(), 'tracklist sheet opens');
assert((await page.locator('.sheet .track').count()) === 3, 'tracklist shows 3 tracks');
await page.screenshot({ path: SHOT + '/02-tracklist.png' });
// stacker source has no delete zone
assert((await page.locator('.sheet #delete-btn').count()) === 0, 'no delete on stacker tracklist');
await page.locator('.sheet-close').click();
await page.waitForTimeout(800);
assert((await page.locator('.sheet').count()) === 0, 'tracklist closes');

// 5) Spares tab
await page.locator('.tab[data-tab="spares"]').click();
await page.waitForTimeout(300);
// sorted by artist: Daft Punk, then Various Artists
const spTitles = await page.locator('#spares-list .card-title').allInnerTexts();
assert(spTitles.length === 2, 'two spares');
assert(spTitles[0].includes('Random Access Memories'), 'spares sorted by artist (Daft Punk first)');
await page.screenshot({ path: SHOT + '/03-spares.png' });

// 6) Search filters display only
await page.locator('#spare-search').fill('daft');
await page.waitForTimeout(250);
assert((await page.locator('#spares-list .card').count()) === 1, 'search filters to 1');
await page.locator('#spare-search').fill('');
await page.waitForTimeout(250);
assert((await page.locator('#spares-list .card').count()) === 2, 'clearing search restores 2');

// 7) Burnt CD tracklist shows per-track artist + feat
await page.locator('#spares-list .card', { hasText: 'Summer Drive' }).click();
await page.waitForTimeout(800);
assert((await page.locator('.sheet .track-artist').count()) === 2, 'burnt CD shows per-track artists');
assert((await page.locator('.sheet .track-feat').count()) >= 1, 'feat credit shown');
assert((await page.locator('.sheet #delete-btn').count()) === 1, 'delete zone present on spare tracklist');
// two-tap delete arm test (do NOT confirm)
await page.locator('.sheet #delete-btn').click();
await page.waitForTimeout(150);
assert((await page.locator('.sheet #delete-btn.armed').count()) === 1, 'delete arms on first tap');
await page.locator('.sheet-close').click();
await page.waitForTimeout(700);

// 8) Swap a spare into the empty Dash (edge case: nothing to swap back)
await page.locator('#spares-list .card', { hasText: 'Random Access Memories' }).locator('.swap-btn').click();
await page.waitForTimeout(400);
await page.locator('.swap-dest.dash').click();
await page.waitForTimeout(500);
// spares should now be 1, dash filled
assert((await page.locator('#spares-list .card').count()) === 1, 'spare removed from library after swap into empty dash');
await page.locator('.tab[data-tab="stacker"]').click();
await page.waitForTimeout(300);
assert((await page.locator('.card.dash').count()) === 1, 'dash now occupied');
assert((await page.locator('#dash-empty').count()) === 0, 'no null placeholder in dash');

// 9) Eject returns to spares
await page.locator('#dash-eject').click();
await page.waitForTimeout(300);
assert((await page.locator('#dash-empty').count()) === 1, 'dash empty after eject');
await page.locator('.tab[data-tab="spares"]').click();
await page.waitForTimeout(300);
assert((await page.locator('#spares-list .card').count()) === 2, 'ejected disc back in spares');

// 10) Persistence across reload of the swap/eject result
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.locator('.tab[data-tab="spares"]').click();
await page.waitForTimeout(300);
assert((await page.locator('#spares-list .card').count()) === 2, 'state persisted across reload');

// 11) iTunes reachability (network through proxy) — informational
const net = await page.evaluate(async () => {
  try {
    const r = await fetch('https://itunes.apple.com/search?term=daft+punk&entity=album&limit=1');
    if (!r.ok) return 'HTTP ' + r.status;
    const j = await r.json();
    return 'ok:' + (j.results?.length ?? 0);
  } catch (e) { return 'ERR:' + e.message; }
});
console.log('itunes reachability:', net);

console.log('\nCONSOLE ERRORS:', errors.length ? errors : 'none');
if (errors.length) process.exitCode = 1;

await browser.close();
