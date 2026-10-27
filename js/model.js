/* ============================================================
   model.js — the multi-car data model (state v2). Pure logic: no
   DOM, no storage. app.js renders it, store.js persists it.

   Shape:
     {
       version: 2,
       selectedCarId,
       discs: { [id]: album },          // every CD you own, stored once
       cars: [{
         id, name, title, subtitle, stackerSize,
         theme: { layout, shape, nums, bg, accent },
         stacker: [discId|null × stackerSize],
         dash: discId|null,
         glovebox: [discId], boot: [discId],
       }],
       pendingSort: [discId] | undefined, // former Spares awaiting "Sort your spares"
     }

   A disc is "Unassigned" when no car references it. That's derived,
   never stored, so a disc can't be in two places or lost between them.
   ============================================================ */

/* Per-car look, from the "Stacker Customize Concepts" design: layout
   (list|block|panel), artwork shape (square|cd), numbers
   (classic|bold|groovy|pixel), accent and background. Applied from
   stage 5; stored from the start so no second migration is needed. */
export const DEFAULT_THEME = { layout: 'list', shape: 'square', nums: 'classic', bg: '#F1EEE7', accent: '#8C1524' };
export const LOC_LABEL = { stacker: 'Stacker', dash: 'Dash', glovebox: 'Glovebox', boot: 'Boot' };

export function isV2(d) {
  return !!(d && d.version === 2 && Array.isArray(d.cars) && d.discs && typeof d.discs === 'object');
}

/** The original single-car shape: { stacker: [album|null], dash, spares: [album] }. */
export function isV1(d) {
  return !!(d && !d.version && (Array.isArray(d.stacker) || Array.isArray(d.spares)));
}

export function newCar(idFn, { name, title, subtitle, stackerSize = 10, theme } = {}) {
  const size = Math.max(1, Math.min(20, Math.round(stackerSize)));
  return {
    id: idFn(),
    name: name || 'My car',
    title: title || `${name || 'My car'} Stacker`,
    subtitle: subtitle ?? `${size}-disc stacker · 1 dash slot`,
    stackerSize: size,
    theme: { ...DEFAULT_THEME, ...(theme || {}) },
    stacker: Array(size).fill(null),
    dash: null,
    glovebox: [],
    boot: [],
  };
}

export function emptyState(idFn) {
  const car = newCar(idFn, { name: 'My car', title: 'My Stacker' });
  return { version: 2, selectedCarId: car.id, discs: {}, cars: [car] };
}

/** Move a v1 collection into a first car called "Brera", losing nothing.
 *  Former Spares go to the Glovebox if burnt, otherwise the Boot, and are
 *  listed in pendingSort so the user can re-sort them once. */
export function migrateV1(v1, idFn) {
  const discs = {};
  const take = album => {
    if (!album || typeof album !== 'object') return null;
    let id = album.id;
    if (!id || discs[id]) id = idFn(); // missing or duplicate id -> fresh one
    discs[id] = { ...album, id };
    return id;
  };
  const oldStacker = Array.isArray(v1.stacker) ? v1.stacker : [];
  const size = Math.max(10, oldStacker.length);
  const car = newCar(idFn, {
    name: 'Brera',
    title: 'Brera Stacker',
    subtitle: `${size}-disc boot stacker · 1 dash slot`,
    stackerSize: size,
  });
  car.stacker = Array.from({ length: size }, (_, i) => take(oldStacker[i]));
  car.dash = take(v1.dash);
  const pendingSort = [];
  for (const album of Array.isArray(v1.spares) ? v1.spares : []) {
    const id = take(album);
    if (!id) continue;
    (discs[id].isBurnt ? car.glovebox : car.boot).push(id);
    pendingSort.push(id);
  }
  const out = { version: 2, selectedCarId: car.id, discs, cars: [car] };
  if (pendingSort.length) out.pendingSort = pendingSort;
  return out;
}

/** Repair anything inconsistent: sizes, dangling ids, a disc referenced
 *  twice (first reference wins), a missing selected car. */
export function normalize(s, idFn) {
  if (!s.discs || typeof s.discs !== 'object') s.discs = {};
  if (!Array.isArray(s.cars) || !s.cars.length) {
    const fresh = emptyState(idFn);
    s.cars = fresh.cars;
  }
  const seen = new Set();
  const keep = id => (id && s.discs[id] && !seen.has(id) ? (seen.add(id), id) : null);
  for (const car of s.cars) {
    car.stackerSize = Math.max(1, Math.min(20, Math.round(car.stackerSize || 10)));
    car.theme = { ...DEFAULT_THEME, ...(car.theme || {}) };
    const st = Array.isArray(car.stacker) ? car.stacker : [];
    car.stacker = Array.from({ length: car.stackerSize }, (_, i) => keep(st[i]));
    car.dash = keep(car.dash);
    car.glovebox = (Array.isArray(car.glovebox) ? car.glovebox : []).map(keep).filter(Boolean);
    car.boot = (Array.isArray(car.boot) ? car.boot : []).map(keep).filter(Boolean);
  }
  if (!s.cars.some(c => c.id === s.selectedCarId)) s.selectedCarId = s.cars[0].id;
  if (Array.isArray(s.pendingSort)) {
    s.pendingSort = s.pendingSort.filter(id => s.discs[id]);
    if (!s.pendingSort.length) delete s.pendingSort;
  }
  s.version = 2;
  return s;
}

/* ---------- reads ---------- */

export function selectedCar(s) {
  return s.cars.find(c => c.id === s.selectedCarId) || s.cars[0];
}
export function carById(s, id) { return s.cars.find(c => c.id === id) || null; }
export function disc(s, id) { return (id && s.discs[id]) || null; }
export function allDiscs(s) { return Object.values(s.discs); }

/** Where a disc is: { car, loc, index } or null when Unassigned. */
export function placeOf(s, id) {
  for (const car of s.cars) {
    const si = car.stacker.indexOf(id);
    if (si !== -1) return { car, loc: 'stacker', index: si };
    if (car.dash === id) return { car, loc: 'dash', index: 0 };
    const gi = car.glovebox.indexOf(id);
    if (gi !== -1) return { car, loc: 'glovebox', index: gi };
    const bi = car.boot.indexOf(id);
    if (bi !== -1) return { car, loc: 'boot', index: bi };
  }
  return null;
}

export function unassignedIds(s) {
  return Object.keys(s.discs).filter(id => !placeOf(s, id));
}

/** Every disc with its place: { album, car|null, loc: stacker|dash|glovebox|boot|unassigned, index }. */
export function allPlaces(s) {
  const out = [];
  for (const car of s.cars) {
    car.stacker.forEach((id, i) => id && out.push({ album: s.discs[id], car, loc: 'stacker', index: i }));
    if (car.dash) out.push({ album: s.discs[car.dash], car, loc: 'dash', index: 0 });
    car.glovebox.forEach((id, i) => out.push({ album: s.discs[id], car, loc: 'glovebox', index: i }));
    car.boot.forEach((id, i) => out.push({ album: s.discs[id], car, loc: 'boot', index: i }));
  }
  for (const id of unassignedIds(s)) out.push({ album: s.discs[id], car: null, loc: 'unassigned', index: 0 });
  return out;
}

/* ---------- writes (each keeps a disc in exactly one place) ---------- */

/** Remove a disc from wherever it is in any car; it becomes Unassigned. */
export function detach(s, id) {
  for (const car of s.cars) {
    car.stacker = car.stacker.map(x => (x === id ? null : x));
    if (car.dash === id) car.dash = null;
    car.glovebox = car.glovebox.filter(x => x !== id);
    car.boot = car.boot.filter(x => x !== id);
  }
}

/** Put a disc into a car location. Single-disc slots (dash, a stacker
 *  slot) return their previous occupant id so the caller can rehome it. */
export function putAt(s, id, car, loc, index = 0) {
  detach(s, id);
  let displaced = null;
  if (loc === 'stacker') { displaced = car.stacker[index]; car.stacker[index] = id; }
  else if (loc === 'dash') { displaced = car.dash; car.dash = id; }
  else if (loc === 'glovebox') car.glovebox.push(id);
  else if (loc === 'boot') car.boot.push(id);
  else if (loc !== 'unassigned') throw new Error('Unknown location ' + loc);
  return displaced && displaced !== id ? displaced : null;
}

/** Swap a disc into a single slot; whatever was there takes the disc's old
 *  spot (or the car's Glovebox if the disc came from outside the car). */
export function exchange(s, id, car, loc, index = 0) {
  const from = placeOf(s, id);
  const displaced = putAt(s, id, car, loc, index);
  if (displaced) {
    if (from && from.car === car && (from.loc === 'glovebox' || from.loc === 'boot')) putAt(s, displaced, car, from.loc);
    else if (from && from.car === car && from.loc === 'stacker') putAt(s, displaced, car, 'stacker', from.index);
    else putAt(s, displaced, car, 'glovebox');
  }
  return displaced;
}

export function addDisc(s, album) {
  s.discs[album.id] = album; // lands Unassigned
  return album.id;
}

export function removeDisc(s, id) {
  const album = s.discs[id];
  detach(s, id);
  delete s.discs[id];
  if (Array.isArray(s.pendingSort)) s.pendingSort = s.pendingSort.filter(x => x !== id);
  return album || null;
}

export function moveInStacker(car, i, j) {
  if (j < 0 || j >= car.stackerSize || i === j) return false;
  [car.stacker[i], car.stacker[j]] = [car.stacker[j], car.stacker[i]];
  return true;
}
