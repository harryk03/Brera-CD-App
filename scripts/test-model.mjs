// Unit tests for js/model.js — migration and the one-place-per-disc rule.
// Run: node scripts/test-model.mjs   (no browser needed)
import * as M from '../js/model.js';

let n = 0;
const idFn = () => 'gen-' + (++n);
const ok = (c, m) => { console.log((c ? 'ok:   ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const mk = (id, title, artist, extra = {}) => ({ id, title, artist, isBurnt: false, coverImageUri: null,
  palette: ['#111111', '#222222'], features: {}, trackArtists: null, tracks: ['A', 'B'], dateAdded: 1, ...extra });

/** Every disc id appears in at most one car location, across all cars. */
function onePlaceEach(s) {
  const seen = new Map();
  for (const c of s.cars) for (const id of [...c.stacker, c.dash, ...c.glovebox, ...c.boot].filter(Boolean)) {
    if (seen.has(id)) return false;
    seen.set(id, true);
  }
  return true;
}

// ---------- migration ----------
const v1 = {
  stacker: [mk('s1', 'Back to Black', 'Amy Winehouse', { coverImageUri: 'img-1', features: { Rehab: 'X' } }),
    null, mk('s3', 'Channel Orange', 'Frank Ocean'), ...Array(7).fill(null)],
  dash: mk('d1', 'Twenty Five', 'George Michael'),
  spares: [
    mk('p1', 'Road Trip', 'Various Artists', { isBurnt: true, trackArtists: ['Rihanna', 'Drake'] }),
    mk('p2', 'Summer Mix', 'Various Artists', { isBurnt: true }),
    mk('p3', 'Listen Without Prejudice', 'George Michael'),
    mk('p4', 'Rumours', 'Fleetwood Mac'),
  ],
};
const before = JSON.stringify(v1);
ok(M.isV1(v1) && !M.isV2(v1), 'old shape detected as v1');
const s = M.normalize(M.migrateV1(v1, idFn), idFn);
ok(JSON.stringify(v1) === before, 'migration does not mutate the original record');
ok(M.isV2(s) && s.cars.length === 1, 'one car after migration');
const brera = s.cars[0];
ok(brera.name === 'Brera' && brera.title === 'Brera Stacker' && brera.stackerSize === 10, 'first car is "Brera", 10 slots');
ok(s.selectedCarId === brera.id, 'Brera is selected');
ok(Object.keys(s.discs).length === 7, 'all 7 CDs kept');
ok(brera.stacker[0] === 's1' && brera.stacker[1] === null && brera.stacker[2] === 's3', 'stacker slots keep their positions (incl. the gap)');
ok(brera.dash === 'd1', 'dash kept');
ok(JSON.stringify(brera.glovebox) === '["p1","p2"]', 'burnt spares pre-sorted to Glovebox');
ok(JSON.stringify(brera.boot) === '["p3","p4"]', 'other spares pre-sorted to Boot');
ok(JSON.stringify(s.pendingSort) === '["p1","p2","p3","p4"]', 'every former spare queued for "Sort your spares"');
ok(M.unassignedIds(s).length === 0, 'nothing Unassigned after migration');
ok(s.discs.s1.coverImageUri === 'img-1' && s.discs.s1.features.Rehab === 'X', 'cover + feat credits preserved');
ok(JSON.stringify(s.discs.p1.trackArtists) === '["Rihanna","Drake"]', 'burnt per-track artists preserved');
ok(JSON.stringify(brera.theme) === JSON.stringify(M.DEFAULT_THEME), 'default cream look stored on the car');
ok(onePlaceEach(s), 'no disc in two places');

// duplicate / missing ids in old data get fresh ids, nothing dropped
const dupe = M.migrateV1({ stacker: [mk('x', 'A', 'B')], dash: null, spares: [mk('x', 'C', 'D'), { ...mk('', 'E', 'F'), id: undefined }] }, idFn);
ok(Object.keys(dupe.discs).length === 3, 'duplicate and missing ids repaired, no CD lost');
// no spares -> no sort step
ok(!M.migrateV1({ stacker: [], dash: null, spares: [] }, idFn).pendingSort, 'no sort step when there were no spares');

// ---------- moves keep one place per disc ----------
M.putAt(s, 'p3', brera, 'glovebox');
ok(brera.glovebox.includes('p3') && !brera.boot.includes('p3'), 'putAt moves boot -> glovebox');
const displaced = M.putAt(s, 'p3', brera, 'dash');
ok(brera.dash === 'p3' && displaced === 'd1' && !brera.glovebox.includes('p3'), 'putAt into dash returns the old occupant');
M.putAt(s, displaced, brera, 'glovebox');
ok(onePlaceEach(s), 'still one place each');

// exchange: spare from boot into an occupied stacker slot -> occupant takes the boot spot
M.exchange(s, 'p4', brera, 'stacker', 0);
ok(brera.stacker[0] === 'p4' && brera.boot.includes('s1'), 'exchange: stacker occupant goes to where the spare was');
M.exchange(s, 'p1', brera, 'stacker', 1);
ok(brera.stacker[1] === 'p1' && !brera.glovebox.includes('p1'), 'exchange into an empty slot leaves no placeholder');
ok(onePlaceEach(s), 'still one place each after exchanges');

// detach -> Unassigned; removeDisc deletes everywhere
M.detach(s, 'p2');
ok(M.placeOf(s, 'p2') === null && M.unassignedIds(s).includes('p2'), 'detach makes a disc Unassigned');
const removed = M.removeDisc(s, 's3');
ok(removed && removed.title === 'Channel Orange' && !s.discs.s3 && !brera.stacker.includes('s3'), 'removeDisc deletes it everywhere');

// new discs land Unassigned
M.addDisc(s, mk('new1', 'Blonde', 'Frank Ocean'));
ok(M.placeOf(s, 'new1') === null, 'a new CD is Unassigned');

// reorder within the stacker respects its size
const c6 = M.newCar(idFn, { name: 'Miata', stackerSize: 6 });
ok(c6.stacker.length === 6 && c6.title === 'Miata Stacker', 'a 6-slot car');
ok(!M.moveInStacker(c6, 5, 6) && M.moveInStacker(c6, 4, 5), 'cannot move past the last slot');

// ---------- normalize repairs bad data ----------
const bad = { version: 2, selectedCarId: 'gone', discs: { a: mk('a', 'A', 'A'), b: mk('b', 'B', 'B') },
  cars: [{ id: 'c1', name: 'One', stackerSize: 3, stacker: ['a', 'missing'], dash: 'a', glovebox: ['b', 'b'], boot: null }] };
M.normalize(bad, idFn);
const c1 = bad.cars[0];
ok(c1.stacker.length === 3 && c1.stacker[0] === 'a' && c1.stacker[1] === null, 'stacker resized; dangling id dropped');
ok(c1.dash === null, 'a disc referenced twice keeps only its first place');
ok(JSON.stringify(c1.glovebox) === '["b"]' && JSON.stringify(c1.boot) === '[]', 'duplicates and a null list repaired');
ok(bad.selectedCarId === 'c1', 'missing selected car falls back to the first car');

if (!process.exitCode) console.log('\n=== MODEL TESTS PASSED ===');
