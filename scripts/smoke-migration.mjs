// Stage 1 end-to-end: upgrading a real single-car collection, "Sort your
// spares", the backup, old-export import, new CDs landing Unassigned, and the
// sample second car. Run against a served copy on :8123.
import { chromium } from 'playwright';

// Uses Playwright's own browser; set CHROME_PATH to use a specific Chrome.
const EXE = process.env.CHROME_PATH || undefined;
const BASE = 'http://127.0.0.1:8123';
const SHOT = process.env.SHOT || '';

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const ok = (c, m) => { console.log((c ? 'ok:   ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const shot = async name => { if (SHOT) await page.screenshot({ path: `${SHOT}/${name}.png` }); };
await page.route('**itunes.apple.com/**', r => r.fulfill({ contentType: 'application/json', body: '{"resultCount":0,"results":[]}' }));

const V1 = () => {
  const mk = (id, title, artist, extra = {}) => ({ id, title, artist, isBurnt: false, coverImageUri: null,
    palette: ['#3a4d6b', '#6b3a4d'], features: {}, trackArtists: null, tracks: ['One', 'Two'], dateAdded: 1, ...extra });
  return {
    stacker: [mk('s1', 'Back to Black', 'Amy Winehouse', { coverImageUri: 'img-1' }), mk('s2', 'Channel Orange', 'Frank Ocean'),
      ...Array(8).fill(null)],
    dash: mk('d1', 'Twenty Five', 'George Michael'),
    spares: [
      mk('p1', 'Road Trip', 'Various Artists', { isBurnt: true, trackArtists: ['Rihanna', 'Drake'], tracks: ['Work', 'Nice For What'] }),
      mk('p2', 'Summer Mix', 'Various Artists', { isBurnt: true }),
      mk('p3', 'Listen Without Prejudice', 'George Michael'),
      mk('p4', 'Rumours', 'Fleetwood Mac'),
    ],
  };
};
const idb = (fn, arg) => page.evaluate(([src, a]) => new Promise((res, rej) => {
  const req = indexedDB.open('brera-stacker', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('state', { keyPath: 'key' }); req.result.createObjectStore('images'); };
  req.onsuccess = () => { try { new Function('db', 'a', 'res', src)(req.result, a, res); } catch (e) { rej(e); } };
  req.onerror = () => rej(req.error);
}), [fn, arg]);
const getRec = key => idb(`const g=db.transaction('state','readonly').objectStore('state').get(a);g.onsuccess=()=>res(g.result||null);`, key);

// ---------- 1) Upgrade an existing single-car collection ----------
await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await idb(`const t=db.transaction(['state','images'],'readwrite');t.objectStore('state').put({key:'app',data:a});
  t.objectStore('images').put(new Blob(['x'],{type:'image/png'}),'img-1');t.oncomplete=()=>res();`, V1());
await page.reload({ waitUntil: 'networkidle' });

await page.waitForSelector('.sort-sheet');
ok(true, '"Sort your spares" opens after the upgrade');
ok((await page.locator('.sort-sheet .modal-title').innerText()) === 'Sort your spares', 'sheet title');
const sel = async title => page.locator('.sort-row', { hasText: title }).locator('button.on').innerText();
ok(await sel('Road Trip') === 'Glovebox' && await sel('Summer Mix') === 'Glovebox', 'burnt CDs pre-set to Glovebox');
ok(await sel('Listen Without Prejudice') === 'Boot' && await sel('Rumours') === 'Boot', 'other spares pre-set to Boot');
await shot('stage1-sort');
await page.locator('.sort-row', { hasText: 'Listen Without Prejudice' }).locator('[data-loc="glovebox"]').click();
ok(await sel('Listen Without Prejudice') === 'Glovebox', 'tapping Glovebox moves it');
await page.locator('#sort-done').click();
await page.waitForTimeout(500);
ok((await page.locator('.sort-sheet').count()) === 0, 'Done closes the sheet');

// stored data + backup
const v2 = (await getRec('app')).data;
const brera = v2.cars[0];
ok(v2.version === 2 && brera.name === 'Brera' && brera.title === 'Brera Stacker', 'stored as v2 with car "Brera"');
ok(Object.keys(v2.discs).length === 7, 'all 7 CDs present after upgrade');
ok(JSON.stringify(brera.glovebox.sort()) === '["p1","p2","p3"]' && JSON.stringify(brera.boot) === '["p4"]', 'glovebox/boot saved as sorted');
ok(!v2.pendingSort, 'sort marked finished');
const backup = await getRec('app-v1-backup');
ok(backup && JSON.stringify(backup.data) === JSON.stringify(V1()), 'untouched original kept as app-v1-backup');
ok(await idb(`const g=db.transaction('images','readonly').objectStore('images').get('img-1');g.onsuccess=()=>res(!!g.result);`), 'cover image kept');

// screens look the same as before
ok((await page.locator('#view-stacker .app-title').innerText()) === 'Brera Stacker', 'Stacker tab: same title');
ok((await page.locator('#stacker-list .card').count()) === 2 && (await page.locator('.card.dash').count()) === 1, 'stacker discs + dash unchanged');
await shot('stage1-stacker');
await page.locator('.tab[data-tab="spares"]').click();
const spares = await page.$$eval('#spares-list .card', els => els.map(e => ({ t: e.querySelector('.card-title').textContent.replace('BURNT', '').trim(), loc: e.querySelector('.loc-tag').textContent })));
ok(spares.length === 4, 'Spares tab lists glovebox + boot (4 CDs)');
ok(spares.find(x => x.t === 'Rumours').loc === 'Boot' && spares.find(x => x.t === 'Road Trip').loc === 'Glovebox', 'each spare tagged Glovebox or Boot');
await shot('stage1-spares');

// reload: no second sort, nothing changes
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);
ok((await page.locator('.sort-sheet').count()) === 0, 'sort sheet does not come back');
ok(JSON.stringify((await getRec('app')).data.discs) === JSON.stringify(v2.discs), 'reload changes nothing');

// eject -> Glovebox
await page.locator('#dash-eject').click();
const afterEject = (await getRec('app')).data.cars[0];
ok(afterEject.dash === null && afterEject.glovebox.includes('d1'), 'Eject puts the dash CD in the Glovebox');

// ---------- 2) New CDs land Unassigned; place one ----------
await page.locator('.tab[data-tab="spares"]').click();
await page.locator('#add-cd').click();
await page.locator('#album-manual').click();
await page.locator('#rv-title').fill('Blonde');
await page.locator('#rv-artist').fill('Frank Ocean');
await page.locator('#rv-tracks [data-role="title"]').first().fill('Nikes');
await page.locator('#rv-confirm').click();
await page.waitForTimeout(500);
ok((await page.locator('#toast').innerText()).includes('Unassigned'), 'toast says the new CD is Unassigned');
ok((await page.locator('#spares-list .card', { hasText: 'Blonde' }).count()) === 0, 'new CD is not put in a car');
await page.locator('.tab[data-tab="collection"]').click();
const blondeCard = page.locator('#collection-list .card', { hasText: 'Blonde' });
ok((await blondeCard.locator('.own-where').innerText()).toLowerCase() === 'unassigned', 'Collection shows it as Unassigned');
await blondeCard.click();
await page.waitForSelector('.place-zone');
ok((await page.locator('.place-label').innerText()).toLowerCase().includes('brera'), 'detail view offers "Put in Brera"');
await page.locator('.place-zone [data-place="boot"]').click();
await page.waitForTimeout(800);
const blondeId = Object.values((await getRec('app')).data.discs).find(d => d.title === 'Blonde').id;
ok((await getRec('app')).data.cars[0].boot.includes(blondeId), 'placing it puts it in the Brera boot');

// ---------- 3) Sample second car (?dev=1) ----------
await page.goto(BASE + '/index.html?dev=1', { waitUntil: 'networkidle' });
await page.locator('.tab[data-tab="spares"]').click();
await page.locator('#dev-add-miata').click();
let st = (await getRec('app')).data;
const miata = st.cars.find(c => c.name === 'Miata');
ok(st.cars.length === 2 && miata && miata.stackerSize === 6, 'sample Miata added with a 6-disc stacker');
ok(miata.stacker.every(Boolean) && miata.dash && miata.glovebox.length === 2 && miata.boot.length === 2, 'Miata stacker full, plus dash, glovebox and boot');
await page.locator('.tab[data-tab="stacker"]').click();
await page.locator('.dev-cars [data-car]', { hasText: 'Miata' }).click();
ok((await page.locator('#view-stacker .app-title').innerText()) === 'Miata Stacker', 'switching shows "Miata Stacker"');
ok((await page.locator('#stacker-list .card').count()) === 6 && (await page.locator('.section-label').first().innerText()).includes('1–6'), 'Miata shows 6 slots');
await shot('stage1-miata');
await page.locator('.tab[data-tab="collection"]').click();
const coll = await page.$$eval('#collection-list .card', els => els.map(e => e.querySelector('.own-where').textContent));
ok(coll.filter(x => x === 'Unassigned').length === 2, 'Collection lists both cars plus 2 Unassigned');
ok(coll.length === 8 + 13, `every CD from both cars is listed (8 Brera + 13 sample = ${coll.length})`);
await page.locator('.tab[data-tab="spares"]').click();
await page.locator('#dev-remove-miata').click();
st = (await getRec('app')).data;
ok(st.cars.length === 1 && Object.values(st.discs).every(d => !d.sample) && Object.keys(st.discs).length === 8, 'removing the sample leaves the real collection untouched');

// ---------- 4) Importing an old single-car export migrates it ----------
const fs = await import('fs');
const file = `${SHOT || '/tmp'}/old-export.json`;
fs.writeFileSync(file, JSON.stringify({ app: 'brera-stacker', version: 1, exportedAt: '2026-10-01T00:00:00Z', state: V1(), images: {} }));
await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await page.locator('.tab[data-tab="spares"]').click();
await page.locator('#import-file').setInputFiles(file);
await page.locator('#cf-yes').click();
await page.waitForSelector('.sort-sheet');
ok(true, 'importing an old backup migrates it and asks to sort spares');
await page.locator('#sort-done').click();
await page.waitForTimeout(400);
st = (await getRec('app')).data;
ok(st.version === 2 && st.cars[0].name === 'Brera' && Object.keys(st.discs).length === 7, 'old backup imported as car "Brera" with all 7 CDs');

ok(errors.length === 0, 'no JS errors' + (errors.length ? ' ' + JSON.stringify(errors) : ''));
await browser.close();
if (!process.exitCode) console.log('\n=== STAGE 1 TESTS PASSED ===');
