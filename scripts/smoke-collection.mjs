// Collection tab: exists between the two original tabs, owns the "search songs
// on your CDs" box, and the box no longer appears in Add CD -> Burnt CD.
import { chromium } from 'playwright';

// Uses Playwright's own browser; set CHROME_PATH to use a specific Chrome.
const EXE = process.env.CHROME_PATH || undefined;
const BASE = 'http://127.0.0.1:8123';

const browser = await chromium.launch({ executablePath: EXE });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const ok = (c, m) => { console.log((c ? 'ok:   ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };

await page.route('**itunes.apple.com/**', r => r.fulfill({ contentType: 'application/json', body: '{"resultCount":0,"results":[]}' }));
await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });

// Seed: a stacker slot, the dash, a spare, a burnt disc.
await page.evaluate(() => new Promise(res => {
  const mk = (title, artist, isBurnt, tracks, extra = {}) => ({ id: crypto.randomUUID(), title, artist, isBurnt, coverImageUri: null,
    palette: ['#3a4d6b', '#6b3a4d'], features: {}, trackArtists: null, tracks, dateAdded: Date.now(), ...extra });
  const state = { stacker: Array(10).fill(null), dash: null, spares: [] };
  state.stacker[2] = mk('Channel Orange', 'Frank Ocean', false, ['Thinkin Bout You', 'Sweet Life', 'Pyramids']);
  state.dash = mk('Blonde', 'Frank Ocean', false, ['Nikes', 'Ivy']);
  state.spares.push(mk('Rumours', 'Fleetwood Mac', false, ['Dreams', 'Go Your Own Way']));
  state.spares.push(mk('Road Trip', 'Various Artists', true, ['Work', 'Nice For What'], { trackArtists: ['Rihanna', 'Drake'], features: { Work: 'Drake' } }));
  const req = indexedDB.open('brera-stacker', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('state', { keyPath: 'key' }); req.result.createObjectStore('images'); };
  req.onsuccess = () => { const tx = req.result.transaction('state', 'readwrite'); tx.objectStore('state').put({ key: 'app', data: state }); tx.oncomplete = res; };
}));
await page.reload({ waitUntil: 'networkidle' });

// Stage 1: seeding the old single-car shape triggers the one-time upgrade and
// its "Sort your spares" sheet; accept the pre-sort (burnt -> Glovebox, rest -> Boot).
await page.waitForSelector('.sort-sheet', { timeout: 3000 }).then(() => page.locator('#sort-done').click()).catch(() => {});
await page.waitForTimeout(500);

// ---- the tab ----
const tabs = await page.$$eval('.tab', els => els.map(e => e.dataset.tab));
ok(JSON.stringify(tabs) === '["stacker","collection","spares"]', 'three tabs, Collection between the two originals: ' + tabs);
ok((await page.locator('.tab[data-tab="collection"] .tab-label').innerText()) === 'Collection', 'tab is labelled "Collection"');
await page.locator('.tab[data-tab="collection"]').click();
ok(await page.locator('#view-collection').isVisible() && !(await page.locator('#view-spares').isVisible()), 'Collection view shows, Spares hides');
ok((await page.locator('.tab[data-tab="collection"]').getAttribute('aria-selected')) === 'true', 'tab shows as selected');
const ph = await page.locator('#collection-search').getAttribute('placeholder');
ok(ph === 'Search songs on your CDs', 'search bar placeholder: ' + ph);

// ---- empty search: every CD with a status tag ----
const cds = await page.$$eval('#collection-list .card', els => els.map(e => ({ t: e.querySelector('.card-title').textContent.replace('BURNT', '').trim(), s: e.querySelector('.own-where').textContent.trim(), b: !!e.querySelector('.badge-burnt') })));
ok(cds.length === 4, 'empty search lists all 4 owned CDs: ' + JSON.stringify(cds.map(c => c.t)));
const tagOf = t => (cds.find(c => c.t === t) || {}).s;
ok(tagOf('Channel Orange') === 'In Stacker', 'stacker disc tagged "In Stacker"');
// Stage 1: the old Spares pile is split into Glovebox (burnt) and Boot.
ok(tagOf('Rumours') === 'Boot' && tagOf('Road Trip') === 'Glovebox', 'former spares tagged Boot / Glovebox');
ok(tagOf('Blonde') === 'In Dash', 'dash disc tagged "In Dash"');
ok(cds.find(c => c.t === 'Road Trip').b, 'burnt disc keeps its BURNT badge');
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '/collection-empty.png' });

// ---- search ----
const hits = async q => { await page.locator('#collection-search').fill(q); return page.$$eval('#collection-list .own-hit', els => els.map(e => ({ t: e.querySelector('.own-title').textContent.trim(), s: e.querySelector('.own-sub').textContent.trim(), w: e.querySelector('.own-where').textContent.trim() }))); };
let h = await hits('sweet life');
ok(h.length === 1 && h[0].w === 'In Stacker' && h[0].s === 'Channel Orange · Frank Ocean', 'song result: title, album · artist, status: ' + JSON.stringify(h));
h = await hits('dreams'); ok(h.length === 1 && h[0].w === 'Boot', 'finds a song in the Boot (former Spares)');
h = await hits('nikes'); ok(h.length === 1 && h[0].w === 'In Dash', 'finds a song on the Dash');
h = await hits('rihanna'); ok(h.length === 1 && h[0].s === 'Road Trip · Rihanna', 'burnt tracklists are searched, with per-track artist');
h = await hits('drake'); ok(h.length === 2, 'matches featured artists too');
h = await hits('SWEET  life'); ok(h.length === 1, 'case and spacing ignored');
h = await hits('zzzz nothing'); ok(h.length === 0 && (await page.locator('#collection-list').innerText()).includes('Not on any of your CDs'), 'no match -> "Not on any of your CDs"');
ok((await page.locator('#collection-search').evaluate(e => e === document.activeElement)), 'search keeps focus while typing');

// ---- tapping opens the existing detail view ----
await hits('sweet life');
await page.locator('#collection-list .own-hit').first().click();
await page.waitForSelector('.sheet .sheet-title');
ok((await page.locator('.sheet .sheet-title').innerText()).includes('Channel Orange'), 'tapping a song opens that CD\'s detail view');
ok((await page.locator('.sheet .sheet-loc').textContent()) === 'Slot 3', 'detail view knows it is in Slot 3');
await page.locator('.sheet-close').click(); await page.waitForTimeout(900);
await page.locator('#collection-search').fill('');
await page.locator('#collection-list .card', { hasText: 'Rumours' }).click();
await page.waitForSelector('.sheet .sheet-title');
ok((await page.locator('.sheet .sheet-title').innerText()).includes('Rumours') && (await page.locator('.sheet .sheet-loc').textContent()) === 'Boot', 'tapping a CD opens its detail view (Boot)');
await page.locator('.sheet-close').click(); await page.waitForTimeout(900);

// ---- Burnt CD no longer has the search ----
await page.locator('.tab[data-tab="spares"]').click();
await page.locator('#add-cd').click();
await page.locator('[data-mode="burnt"]').click();
await page.waitForSelector('#bt-q');
ok((await page.locator('#own-check, #own-q').count()) === 0 && !(await page.locator('#add-content').innerText()).includes('Already own it'), 'Burnt CD no longer has the "Already own it?" search');
ok(await page.locator('#bt-q').isVisible() && await page.locator('#sp-link').isVisible(), 'Burnt CD still has song search + Spotify import');

ok(errors.length === 0, 'no JS errors' + (errors.length ? ' ' + JSON.stringify(errors) : ''));
await browser.close();
