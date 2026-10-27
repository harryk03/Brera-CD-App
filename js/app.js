/* ============================================================
   app.js — Stacker application (placeholder name; see README).

   Mirrors real cars: each has a stacker, a dash slot, a glovebox and
   a boot, and every CD you own sits in exactly one of those places or
   is Unassigned. The data model lives in model.js; all state is
   persisted to IndexedDB (store.js) and survives restarts.
   ============================================================ */

import { loadRaw, saveBackupOnce, saveState, imageUrl, putImage, deleteImage, getImageBlob } from './store.js';
import * as M from './model.js';
import * as itunes from './itunes.js';
import { NetworkError } from './itunes.js';
import * as spotify from './spotify.js';
import { uuid, initials, makePalette, escapeHtml, debounce, h, toast, dupKey } from './util.js';

let state = null;
const DEV = new URLSearchParams(location.search).has('dev'); // test-only tools

/* Shorthands over the model. */
const car = () => M.selectedCar(state);
const D = id => M.disc(state, id);
/** The selected car's Glovebox + Boot, as { album, loc } (the Spares tab). */
const carSpares = (c = car()) => [
  ...c.glovebox.map(id => ({ album: D(id), loc: 'glovebox' })),
  ...c.boot.map(id => ({ album: D(id), loc: 'boot' })),
].filter(x => x.album);
let currentTab = 'stacker';
let reordering = false;
let spareFilter = '';
let collectionFilter = '';

/* ---------- boot ---------- */

async function boot() {
  state = await loadAppState();
  registerSW();
  wireTabs();
  render();
  if (state.pendingSort) openSortSpares();
  // background artwork fetch, sequential, silent
  backfillArtwork();
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data.type === 'update-ready') {
        showUpdateBanner();
      }
    });
  }
}

function showUpdateBanner() {
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.innerHTML = `<span>Update available</span><button id="update-refresh">Refresh</button>`;
  document.body.appendChild(banner);
  banner.querySelector('#update-refresh').addEventListener('click', () => {
    location.reload();
  });
}

/** Load the stored collection, migrating the original single-car shape into
 *  car "Brera" on first run. The old record is kept as a backup first. */
async function loadAppState() {
  const raw = await loadRaw();
  if (M.isV2(raw)) return M.normalize(raw, uuid);
  if (M.isV1(raw)) {
    const migrated = M.normalize(M.migrateV1(raw, uuid), uuid);
    try {
      await saveBackupOnce(raw);
      await saveState(migrated);
    } catch (e) {
      console.error('migration save failed', e);
      toast('Could not save the upgraded collection — nothing was changed.', true);
    }
    return migrated;
  }
  return M.emptyState(uuid);
}

/* ---------- persistence ---------- */

async function commit() {
  try { await saveState(state); }
  catch (e) { toast('Could not save — storage error.', true); console.error(e); }
}

/* ======================================================================
   RENDERING
   ====================================================================== */

function render() {
  renderStacker();
  renderCollection();
  renderSpares();
}

/* ---------- cover markup + async fill ---------- */

function coverHtml(album, cls = 'cover') {
  const pal = album.palette && album.palette.length === 2
    ? album.palette
    : makePalette((album.title || '') + (album.artist || ''));
  const grad = `linear-gradient(135deg, ${pal[0]}, ${pal[1]})`;
  const imgid = album.coverImageUri ? ` data-imgid="${escapeHtml(album.coverImageUri)}"` : '';
  return `<div class="${cls}"${imgid}>
      <div class="fallback" style="background:${grad}">${escapeHtml(initials(album.title))}</div>
    </div>`;
}

async function fillCovers(root) {
  const nodes = root.querySelectorAll('.cover[data-imgid], .sheet-cover[data-imgid]');
  for (const node of nodes) {
    const id = node.getAttribute('data-imgid');
    const url = await imageUrl(id);
    if (url) {
      // Real image present -> replace fallback (suppresses the diagonal slice).
      node.innerHTML = `<img src="${url}" alt="" />`;
    }
  }
}

/* ---------- Stacker + Dash view ---------- */

function renderStacker() {
  const view = document.getElementById('view-stacker');
  view.classList.toggle('reordering', reordering);

  const c = car();
  const rows = c.stacker.map((id, i) => stackerRow(D(id), i, c.stackerSize)).join('');

  view.innerHTML = `
    <header class="app-header">
      <h1 class="app-title">${escapeHtml(c.title)}</h1>
      <p class="app-subtitle">${escapeHtml(c.subtitle)}</p>
      ${devCarTools()}
    </header>

    <div class="section-label">Stacker &middot; Slots 1–${c.stackerSize}</div>
    <div id="stacker-list">${rows}</div>

    <div class="footer-actions">
      <button class="btn ${reordering ? 'on' : ''}" id="reorder-toggle">
        ${reordering ? 'Done' : 'Reorder'}
      </button>
    </div>

    <div class="section-label">Dash Slot</div>
    <div class="dash-wrap" id="dash-wrap">${dashMarkup()}</div>
  `;

  // wire
  view.querySelector('#reorder-toggle').addEventListener('click', () => {
    reordering = !reordering;
    renderStacker();
  });

  view.querySelectorAll('#stacker-list [data-slot]').forEach(node => {
    const i = Number(node.getAttribute('data-slot'));
    const album = D(c.stacker[i]);
    if (reordering) {
      node.querySelector('.move-up')?.addEventListener('click', e => { e.stopPropagation(); moveSlot(i, -1); });
      node.querySelector('.move-down')?.addEventListener('click', e => { e.stopPropagation(); moveSlot(i, +1); });
    } else if (album) {
      node.addEventListener('click', () => openTracklist(node, album, { source: 'stacker', loc: 'stacker', index: i, carId: c.id }));
    } else {
      node.addEventListener('click', () => openSwapToDestination({ type: 'stacker', index: i }));
    }
  });

  wireDash(view);
  wireDevCarTools(view);
  fillCovers(view);
}

function stackerRow(album, i, size) {
  const num = `<span class="slot-num">${i + 1}</span>`;
  if (!album) {
    return `<div class="slot-empty" data-slot="${i}">
        <div class="plus">+</div>
        <div class="t1">Slot ${i + 1} empty — tap to fill from Spares</div>
      </div>`;
  }
  const controls = reordering ? `
      <div class="row-actions">
        <div class="reorder-controls">
          <button class="icon-btn move-up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
          <button class="icon-btn move-down" ${i === size - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
        </div>
      </div>` : '';
  return `<div class="card" data-slot="${i}">
      ${num}
      ${coverHtml(album)}
      <div class="card-body">
        <div class="card-title">${escapeHtml(album.title)}${album.isBurnt ? '<span class="badge-burnt">BURNT</span>' : ''}</div>
        <div class="card-artist">${escapeHtml(album.artist)}</div>
      </div>
      ${controls}
    </div>`;
}

function dashMarkup() {
  const a = D(car().dash);
  if (!a) {
    return `<div class="dash-empty" id="dash-empty">
        <div class="plus">+</div>
        <div>
          <div class="t1">Nothing in the Dash</div>
          <div class="t2">Tap to choose a CD from Spares.</div>
        </div>
      </div>`;
  }
  return `<div class="card dash" data-dash="1">
      <span class="slot-num">⏵</span>
      ${coverHtml(a)}
      <div class="card-body">
        <div class="card-title">${escapeHtml(a.title)}${a.isBurnt ? '<span class="badge-burnt">BURNT</span>' : ''}</div>
        <div class="card-artist">${escapeHtml(a.artist)}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn round eject" id="dash-eject" aria-label="Eject">⏏</button>
      </div>
    </div>`;
}

function wireDash(view) {
  const empty = view.querySelector('#dash-empty');
  if (empty) {
    empty.addEventListener('click', () => openSwapToDestination({ type: 'dash' }));
    return;
  }
  const card = view.querySelector('[data-dash]');
  if (card) {
    const eject = card.querySelector('#dash-eject');
    eject.addEventListener('click', e => { e.stopPropagation(); ejectDash(); });
    card.addEventListener('click', () => openTracklist(card, D(car().dash), { source: 'dash', loc: 'dash', carId: car().id }));
  }
}

/* ---------- Collection view ---------- */

/** Search every song you own, or (with an empty search) browse every CD with
 *  where it lives. Tapping a CD or a song opens that CD's normal detail view. */
function renderCollection() {
  const view = document.getElementById('view-collection');
  const total = ownedPlaces().length;
  view.innerHTML = `
    <header class="app-header">
      <h1 class="app-title">Collection</h1>
      <p class="app-subtitle">Every CD you own &middot; ${total} CD${total === 1 ? '' : 's'}</p>
    </header>

    <div class="search-wrap">
      <span class="search-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>
      </span>
      <input class="search-input" id="collection-search" type="text" inputmode="search"
             placeholder="Search songs on your CDs" autocapitalize="off" autocorrect="off" spellcheck="false"
             value="${escapeHtml(collectionFilter)}" />
    </div>

    <div id="collection-list"></div>
  `;
  view.querySelector('#collection-search').addEventListener('input', e => {
    collectionFilter = e.target.value;
    drawCollectionList(); // list only, so the keyboard and caret stay put
  });
  drawCollectionList();
}

function drawCollectionList() {
  const list = document.getElementById('collection-list');
  if (!list) return;
  const q = collectionFilter.trim();

  // Searching: songs. Otherwise: every CD, A–Z by artist then title.
  if (q.length >= 2) {
    const hits = searchOwnedSongs(q);
    if (!hits.length) {
      list.innerHTML = `<div class="empty-state">
          <div class="big">Not on any of your CDs</div>
          <div class="small">Add it to a burnt CD from Add CD &rarr; Burnt CD.</div>
        </div>`;
      return;
    }
    list.innerHTML = `<div class="coll-count">${hits.length} song${hits.length === 1 ? '' : 's'} found</div>` +
      hits.map((h, i) => `
        <div class="own-hit" data-hit="${i}">
          <div class="own-body">
            <div class="own-title">${escapeHtml(h.title)}${h.feat ? ` <span class="track-feat" style="display:inline">feat. ${escapeHtml(h.feat)}</span>` : ''}</div>
            <div class="own-sub">${escapeHtml(h.album.title)} · ${escapeHtml(h.artist)}</div>
          </div>
          <span class="own-where">${escapeHtml(h.status)}</span>
        </div>`).join('');
    list.querySelectorAll('[data-hit]').forEach(node => {
      const h = hits[Number(node.dataset.hit)];
      node.addEventListener('click', () => openTracklist(node, h.album, h.ctx));
    });
    return;
  }

  const places = ownedPlaces().sort((a, b) => {
    const ak = `${a.album.artist} ${a.album.title}`.toLowerCase(), bk = `${b.album.artist} ${b.album.title}`.toLowerCase();
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  if (!places.length) {
    list.innerHTML = `<div class="empty-state">
        <div class="big">No CDs yet</div>
        <div class="small">Add a CD from the Spares tab and it will show up here.</div>
      </div>`;
    return;
  }
  list.innerHTML = places.map((p, i) => `
    <div class="card" data-cd="${i}">
      ${coverHtml(p.album)}
      <div class="card-body">
        <div class="card-title">${escapeHtml(p.album.title)}${p.album.isBurnt ? '<span class="badge-burnt">BURNT</span>' : ''}</div>
        <div class="card-artist">${escapeHtml(p.album.artist)}</div>
      </div>
      <span class="own-where">${escapeHtml(p.status)}</span>
    </div>`).join('');
  fillCovers(list);
  list.querySelectorAll('[data-cd]').forEach(node => {
    const p = places[Number(node.dataset.cd)];
    node.addEventListener('click', () => openTracklist(node, p.album, p.ctx));
  });
}

/* ---------- Spares view ---------- */

/** Artist A–Z, then title. Display order only; storage order is untouched. */
function byArtistTitle(a, b) {
  const ai = a.artist.toLowerCase(), bi = b.artist.toLowerCase();
  if (ai !== bi) return ai < bi ? -1 : 1;
  const at = a.title.toLowerCase(), bt = b.title.toLowerCase();
  return at < bt ? -1 : at > bt ? 1 : 0;
}

function renderSpares() {
  const view = document.getElementById('view-spares');
  const spares = carSpares().sort((x, y) => byArtistTitle(x.album, y.album));

  const q = spareFilter.trim().toLowerCase();
  // Filter the DISPLAY only; underlying data is untouched.
  const visible = spares
    .filter(({ album: a }) => !q || a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q));

  let listHtml;
  if (spares.length === 0) {
    listHtml = `<div class="empty-state">
        <div class="big">No spares yet</div>
        <div class="small">CDs in this car’s glovebox and boot show here. New CDs start as Unassigned in Collection.</div>
      </div>`;
  } else if (visible.length === 0) {
    listHtml = `<div class="empty-state">
        <div class="big">No results for “${escapeHtml(spareFilter)}”</div>
        <div class="small">Try a different title or artist.</div>
      </div>`;
  } else {
    listHtml = visible.map(({ album, loc }) => spareRow(album, loc)).join('');
  }

  view.innerHTML = `
    <header class="app-header">
      <h1 class="app-title">Spares</h1>
      <p class="app-subtitle">${escapeHtml(car().name)} glovebox &amp; boot &middot; ${spares.length} CD${spares.length === 1 ? '' : 's'}</p>
    </header>

    <div class="search-wrap">
      <span class="search-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>
      </span>
      <input class="search-input" id="spare-search" type="text" inputmode="search"
             placeholder="Search title or artist" value="${escapeHtml(spareFilter)}" />
    </div>

    <div id="spares-list">${listHtml}</div>

    <div class="footer-actions">
      <button class="btn accent" id="add-cd">+ Add CD</button>
    </div>

    <div class="sync-actions">
      <button class="btn ghost" id="export-btn">⤴ Share collection</button>
      <button class="btn ghost" id="import-btn">⤵ Import</button>
      <input type="file" id="import-file" accept="application/json,.json" hidden />
    </div>
    <p class="sync-note">Send the exported file to another phone to copy your whole collection — CDs, slot positions and covers.</p>
    ${devSampleTools()}
  `;
  wireDevSampleTools(view);

  view.querySelector('#export-btn').addEventListener('click', exportCollection);
  view.querySelector('#import-btn').addEventListener('click', () => view.querySelector('#import-file').click());
  view.querySelector('#import-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) handleImportFile(f);
    e.target.value = ''; // allow re-importing the same file later
  });

  const search = view.querySelector('#spare-search');
  search.addEventListener('input', debounce(e => {
    spareFilter = e.target.value;
    renderSpares();
    // keep focus after re-render
    const s = document.getElementById('spare-search');
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
  }, 130));

  view.querySelector('#add-cd').addEventListener('click', () => openAddSheet());

  view.querySelectorAll('#spares-list [data-spare]').forEach(node => {
    const id = node.getAttribute('data-spare');
    const album = D(id);
    const loc = node.getAttribute('data-loc');
    node.querySelector('.swap-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openSwapFromSpare(album);
    });
    node.addEventListener('click', () => openTracklist(node, album, { source: 'spares', loc, carId: car().id }));
  });

  fillCovers(view);
}

function spareRow(album, loc) {
  return `<div class="card" data-spare="${escapeHtml(album.id)}" data-loc="${loc}">
      ${coverHtml(album)}
      <div class="card-body">
        <div class="card-title">${escapeHtml(album.title)}${album.isBurnt ? '<span class="badge-burnt">BURNT</span>' : ''}</div>
        <div class="card-artist">${escapeHtml(album.artist)}</div>
      </div>
      <div class="row-actions">
        <span class="own-where loc-tag">${M.LOC_LABEL[loc]}</span>
        <button class="icon-btn swap-btn" aria-label="Swap into rotation">⇄</button>
      </div>
    </div>`;
}

/* ======================================================================
   STATE TRANSITIONS
   ====================================================================== */

function moveSlot(i, dir) {
  if (!M.moveInStacker(car(), i, i + dir)) return;
  commit();
  renderStacker();
}

function ejectDash() {
  const c = car();
  if (!c.dash) return;
  M.putAt(state, c.dash, c, 'glovebox'); // Eject goes to the Glovebox
  commit();
  render();
}

/**
 * Core swap. Moves a spare (by id) into the selected car's dash or a stacker
 * slot; whatever was there takes the spare's old place (its glovebox or
 * boot). An empty destination just takes the spare — no placeholder left.
 */
function performSwap(spareId, dest) {
  if (!D(spareId)) return;
  M.exchange(state, spareId, car(), dest.type === 'dash' ? 'dash' : 'stacker', dest.index || 0);
  commit();
  render();
}

/* ======================================================================
   TRACKLIST SHEET — signature container-transform interaction
   ====================================================================== */

const layer = () => document.getElementById('layer');
let activeSheet = null;

/** Keep the tab bar hidden whenever the sheet/modal layer is active. */
function syncLayer() {
  document.body.classList.toggle('sheet-open', layer().classList.contains('active'));
}

function trackHtml(album, i) {
  const title = album.tracks[i] || '';
  const feat = album.features && album.features[title];
  // Burnt CDs carry a per-track artist.
  const perArtist = album.isBurnt && album.trackArtists ? album.trackArtists[i] : null;
  return `<li class="track reveal" data-ti="${i}">
      <span class="track-num">${i + 1}</span>
      <div class="track-main">
        <div class="track-title">${escapeHtml(title)}</div>
        ${feat ? `<div class="track-feat">feat. ${escapeHtml(feat)}</div>` : ''}
        ${perArtist ? `<div class="track-artist">${escapeHtml(perArtist)}</div>` : ''}
      </div>
    </li>`;
}

function locLabel(ctx) {
  const carName = ctx.carId && state.cars.length > 1 ? `${(M.carById(state, ctx.carId) || {}).name} · ` : '';
  if (ctx.loc === 'stacker') return `${carName}Slot ${ctx.index + 1}`;
  if (ctx.loc === 'dash') return `${carName}Dash`;
  if (ctx.loc === 'unassigned') return 'Unassigned';
  return carName + (M.LOC_LABEL[ctx.loc] || 'Spares');
}

function openTracklist(cardEl, album, ctx) {
  if (activeSheet) return;

  const start = cardEl.getBoundingClientRect();
  const TARGET_W = Math.min(window.innerWidth, 460);
  const TARGET_H = Math.round(window.innerHeight * 0.72);
  const targetLeft = Math.round((window.innerWidth - TARGET_W) / 2);
  const targetTop = window.innerHeight - TARGET_H;

  // card's actual background (so the grow never snaps between colors)
  const startBg = getComputedStyle(cardEl).backgroundColor;

  cardEl.classList.add('is-source-open');

  const l = layer();
  l.classList.add('active');
  syncLayer();

  const scrim = h(`<div class="scrim"></div>`);
  l.appendChild(scrim);

  const isSpare = ctx.source === 'spares';
  const tracksHtml = album.tracks.map((_, i) => trackHtml(album, i)).join('');

  // Full content inserted immediately — the sheet's true final height is
  // correct from frame 1; we only use opacity/animation-delay to time reveals.
  const sheet = h(`
    <div class="sheet" style="
      top:${start.top}px; left:${start.left}px;
      width:${start.width}px; height:${start.height}px;
      border-radius:12px; background:${startBg};">
      <button class="sheet-close" aria-label="Close">✕</button>
      <div class="sheet-inner" style="width:${TARGET_W}px;">
        <div class="sheet-grip"></div>
        <div class="sheet-scroll">
          <div class="sheet-head">
            ${coverHtml(album, 'sheet-cover')}
            <div class="sheet-head-text">
              <div class="sheet-title reveal">${escapeHtml(album.title)}${album.isBurnt ? '<span class="badge-burnt">BURNT</span>' : ''}</div>
              <div class="sheet-artist reveal">${escapeHtml(album.artist)}</div>
              <span class="sheet-loc reveal">${locLabel(ctx)}</span>
            </div>
          </div>
          <ul class="tracklist">${tracksHtml}</ul>
          ${ctx.loc === 'unassigned' ? placeZoneHtml() : ''}
          ${isSpare ? deleteZoneHtml() : ''}
        </div>
      </div>
    </div>
  `);
  l.appendChild(sheet);
  activeSheet = { sheet, scrim, cardEl, album, ctx };

  fillCovers(sheet);

  // stagger the reveal (title -> artist -> loc -> tracks cascade)
  const title = sheet.querySelector('.sheet-title');
  const artist = sheet.querySelector('.sheet-artist');
  const loc = sheet.querySelector('.sheet-loc');
  reveal(title, 120);
  reveal(artist, 230);
  reveal(loc, 300);
  const rows = sheet.querySelectorAll('.track');
  rows.forEach((row, i) => reveal(row, 410 + Math.min(i * 38, 520)));

  // next frame -> animate to target (container transform + bg morph)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    scrim.classList.add('show');
    sheet.style.top = targetTop + 'px';
    sheet.style.left = targetLeft + 'px';
    sheet.style.width = TARGET_W + 'px';
    sheet.style.height = TARGET_H + 'px';
    sheet.style.borderRadius = '18px 18px 0 0';
    sheet.style.backgroundColor = 'var(--card)';
  }));

  // interactions
  sheet.querySelector('.sheet-close').addEventListener('click', closeTracklist);
  scrim.addEventListener('click', closeTracklist);
  if (ctx.loc === 'unassigned') wirePlaceZone(sheet, album);
  if (isSpare) wireDeleteZone(sheet, album);
}

function reveal(el, delayMs) {
  if (!el) return;
  el.style.animation = `revealDrop 360ms var(--sheet-ease) ${delayMs}ms both`;
}

function closeTracklist() {
  if (!activeSheet) return;
  const { sheet, scrim, cardEl } = activeSheet;
  activeSheet = null;

  // fade content quickly
  sheet.querySelectorAll('.reveal').forEach(el => { el.style.animation = 'none'; el.style.opacity = '0'; });

  const rect = cardEl.getBoundingClientRect();
  const startBg = getComputedStyle(cardEl).backgroundColor;
  scrim.classList.remove('show');
  sheet.style.top = rect.top + 'px';
  sheet.style.left = rect.left + 'px';
  sheet.style.width = rect.width + 'px';
  sheet.style.height = rect.height + 'px';
  sheet.style.borderRadius = '12px';
  sheet.style.backgroundColor = startBg;

  const done = () => {
    sheet.remove();
    scrim.remove();
    cardEl.classList.remove('is-source-open');
    layer().classList.remove('active');
    syncLayer();
  };
  sheet.addEventListener('transitionend', function te(e) {
    if (e.propertyName === 'height') { sheet.removeEventListener('transitionend', te); done(); }
  });
  setTimeout(done, 700); // safety
}

/* ---------- place zone (Unassigned only) ----------
   Stage 1 keeps this minimal: put the disc in the selected car's Glovebox
   or Boot. Stage 2 adds the full movement rules. */

function placeZoneHtml() {
  const c = car();
  return `<div class="place-zone reveal">
      <div class="place-label">Put in ${escapeHtml(c.name)}</div>
      <div class="place-row">
        <button class="btn" data-place="glovebox">Glovebox</button>
        <button class="btn" data-place="boot">Boot</button>
      </div>
    </div>`;
}

function wirePlaceZone(sheet, album) {
  const zone = sheet.querySelector('.place-zone');
  reveal(zone, 480);
  zone.querySelectorAll('[data-place]').forEach(btn => btn.addEventListener('click', () => {
    const loc = btn.dataset.place;
    closeTracklist();
    M.putAt(state, album.id, car(), loc);
    commit();
    render();
    toast(`“${album.title}” is now in the ${car().name} ${M.LOC_LABEL[loc].toLowerCase()}.`);
  }));
}

/* ---------- delete zone (glovebox, boot and Unassigned) ---------- */

function deleteZoneHtml() {
  return `<div class="delete-zone">
      <button class="delete-btn reveal" id="delete-btn">Delete this CD</button>
    </div>`;
}

function wireDeleteZone(sheet, album) {
  const btn = sheet.querySelector('#delete-btn');
  reveal(btn, 520);
  let armed = false;
  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.classList.add('armed');
      btn.textContent = 'Tap again to confirm delete';
    } else {
      // Close first (reads the source card's rect for the reverse morph)
      // then delete — deleteSpare re-renders and removes that card.
      closeTracklist();
      deleteSpare(album.id);
    }
  });
  // de-arm if the user closes/taps elsewhere
  sheet.addEventListener('click', e => {
    if (armed && !btn.contains(e.target)) {
      armed = false;
      btn.classList.remove('armed');
      btn.textContent = 'Delete this CD';
    }
  }, true);
}

async function deleteSpare(id) {
  const removed = M.removeDisc(state, id);
  if (!removed) return;
  if (removed.coverImageUri) deleteImage(removed.coverImageUri).catch(() => {});
  await commit();
  render();
  toast('CD deleted.');
}

/* ======================================================================
   SWAP PICKERS
   ====================================================================== */

function modalShell(title, opts = {}) {
  const { subtitle = '', showClose = true, onClose = null } = opts;
  const l = layer();
  l.classList.add('active');
  syncLayer();
  const scrim = h(`<div class="scrim"></div>`);
  const modal = h(`
    <div class="modal">
      <div class="modal-head">
        <div class="modal-titles">
          <div class="modal-title">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="modal-sub">${escapeHtml(subtitle)}</div>` : ''}
        </div>
        ${showClose ? `<button class="icon-btn round modal-close" aria-label="Close">✕</button>` : ''}
      </div>
      <div class="modal-body"></div>
    </div>`);
  l.appendChild(scrim);
  l.appendChild(modal);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    scrim.classList.add('show');
    modal.classList.add('show');
  }));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    scrim.classList.remove('show');
    modal.classList.remove('show');
    setTimeout(() => {
      scrim.remove(); modal.remove();
      // Another sheet may have opened while this one closed (e.g. import ->
      // "Sort your spares"); only switch the layer off when none remain.
      if (!activeSheet && !l.querySelector('.modal')) l.classList.remove('active');
      syncLayer();
    }, 360);
    if (onClose) onClose();
  };
  scrim.addEventListener('click', close);
  const cx = modal.querySelector('.modal-close');
  if (cx) cx.addEventListener('click', close);
  return { modal, body: modal.querySelector('.modal-body'), close };
}

/** From a Spare's ⇄ button: choose which slot/dash to swap it into. */
function openSwapFromSpare(spare) {
  const { body, close } = modalShell(`Swap “${spare.title}” into…`);
  const c = car();
  const dests = [];
  for (let i = 0; i < c.stackerSize; i++) {
    const occ = D(c.stacker[i]);
    dests.push(`<div class="swap-dest" data-type="stacker" data-index="${i}">
        <span class="d-num">Slot ${i + 1}</span>
        <div class="d-body">${occ
          ? `<div class="d-occ">${escapeHtml(occ.title)}</div><div class="d-empty" style="font-style:normal;color:var(--text-2)">${escapeHtml(occ.artist)}</div>`
          : `<div class="d-empty">Empty</div>`}</div>
        <span class="r-add">⇄</span>
      </div>`);
  }
  const dOcc = D(c.dash);
  dests.push(`<div class="swap-dest dash" data-type="dash">
      <span class="d-num">Dash</span>
      <div class="d-body">${dOcc
        ? `<div class="d-occ">${escapeHtml(dOcc.title)}</div>`
        : `<div class="d-empty">Empty</div>`}</div>
      <span class="r-add">⇄</span>
    </div>`);

  body.innerHTML = `<p class="hint">Whatever is in the chosen slot moves to where this CD was.</p>${dests.join('')}`;
  body.querySelectorAll('.swap-dest').forEach(node => {
    node.addEventListener('click', () => {
      const type = node.getAttribute('data-type');
      const dest = type === 'dash' ? { type: 'dash' } : { type: 'stacker', index: Number(node.getAttribute('data-index')) };
      performSwap(spare.id, dest);
      close();
      const occ = type === 'dash' ? 'the Dash' : `Slot ${Number(node.getAttribute('data-index')) + 1}`;
      toast(`“${spare.title}” is now in ${occ}.`);
    });
  });
}

/** From an empty Dash / empty Stacker slot: choose which Spare fills it. */
function openSwapToDestination(dest) {
  const label = dest.type === 'dash' ? 'the Dash' : `Slot ${dest.index + 1}`;
  const { body, close } = modalShell(`Fill ${label} from Spares`);
  const spares = carSpares().sort((x, y) => byArtistTitle(x.album, y.album)).map(x => x.album);
  if (spares.length === 0) {
    body.innerHTML = `<div class="empty-state"><div class="big">No spares available</div>
      <div class="small">Add a CD first, then swap it in here.</div></div>`;
    return;
  }
  const rows = spares.map(a => `
    <div class="swap-dest" data-id="${escapeHtml(a.id)}">
      <div class="d-body">
        <div class="d-occ">${escapeHtml(a.title)}${a.isBurnt ? '<span class="badge-burnt">BURNT</span>' : ''}</div>
        <div class="d-empty" style="font-style:normal;color:var(--text-2)">${escapeHtml(a.artist)}</div>
      </div>
      <span class="r-add">＋</span>
    </div>`).join('');
  body.innerHTML = `<p class="hint">Only Spares can fill a slot.</p>${rows}`;
  body.querySelectorAll('.swap-dest').forEach(node => {
    node.addEventListener('click', () => {
      const id = node.getAttribute('data-id');
      const spare = D(id);
      performSwap(id, dest);
      close();
      toast(`“${spare.title}” is now in ${label}.`);
    });
  });
}

/* ======================================================================
   ADD CD
   ====================================================================== */

function duplicateOf(title, artist) {
  const key = dupKey(title, artist);
  return M.allDiscs(state).find(a => dupKey(a.title, a.artist) === key) || null;
}

/** Every CD you own and where it lives. `ctx` is what openTracklist needs to
 *  open the CD's detail view; `status` is the tag shown in the Collection tab. */
function ownedPlaces() {
  const STATUS = { stacker: 'In Stacker', dash: 'In Dash', glovebox: 'Glovebox', boot: 'Boot', unassigned: 'Unassigned' };
  return M.allPlaces(state).map(({ album, car: c, loc, index }) => ({
    album,
    where: loc === 'stacker' ? `Slot ${index + 1}` : loc === 'unassigned' ? 'Unassigned' : M.LOC_LABEL[loc],
    status: STATUS[loc],
    ctx: {
      source: loc === 'stacker' ? 'stacker' : loc === 'dash' ? 'dash' : 'spares',
      loc, index, carId: c ? c.id : null,
    },
  }));
}

/** Search every song on every CD you own (Stacker, Dash, Spares) by title or
 *  artist. Local only — works offline. Each hit says which CD and where it is. */
function searchOwnedSongs(query) {
  const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits = [];
  for (const { album, where, status, ctx } of ownedPlaces()) {
    album.tracks.forEach((title, i) => {
      const artist = (album.trackArtists && album.trackArtists[i]) || album.artist;
      const feat = (album.features && album.features[title]) || '';
      const hay = norm(`${title} ${artist} ${feat}`);
      if (terms.every(t => hay.includes(t))) hits.push({ title, artist, feat, album, where, status, ctx });
    });
  }
  return hits;
}

function openAddSheet() {
  const { body, close } = modalShell('Add a CD', {
    subtitle: 'Search to auto-fill the tracklist, then edit anything before adding.',
    showClose: false,
  });
  body.innerHTML = `
    <div class="segmented" id="add-mode">
      <button data-mode="album" class="on">Album</button>
      <button data-mode="burnt">Burnt CD</button>
    </div>
    <div id="add-content"></div>
  `;
  const content = body.querySelector('#add-content');
  const seg = body.querySelector('#add-mode');
  const setMode = mode => {
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    if (mode === 'album') renderAlbumMode(content, close);
    else renderBurntMode(content, close);
  };
  seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  setMode('album');
}

/* ---------- Mode A: Album ---------- */

function renderAlbumMode(root, close) {
  root.innerHTML = `
    <div id="album-search-view">
      <div class="field">
        <label>Search album</label>
        <div class="search-row">
          <input type="text" id="album-q" placeholder="Album or artist name" />
          <button class="btn dark" id="album-search-btn">Search</button>
        </div>
      </div>
      <div id="album-status" class="hint"></div>
      <ul class="result-list" id="album-results"></ul>
      <button class="dashed-btn" id="album-manual">Can’t find it? Add it manually</button>
      <div class="modal-cancel-row"><button class="btn outline-accent" id="album-cancel">Cancel</button></div>
    </div>
    <div id="album-review" hidden></div>
  `;
  const searchView = root.querySelector('#album-search-view');
  const review = root.querySelector('#album-review');
  const q = root.querySelector('#album-q');
  const status = root.querySelector('#album-status');
  const results = root.querySelector('#album-results');

  const showReview = (model) => {
    searchView.hidden = true;
    review.hidden = false;
    renderAlbumReview(review, model, close, backToSearch);
  };
  const backToSearch = () => {
    review.hidden = true;
    review.innerHTML = '';
    searchView.hidden = false;
  };

  root.querySelector('#album-cancel').addEventListener('click', close);

  // Manual entry: iTunes doesn't cover everything (e.g. Channel Orange).
  // Opens the same review screen, fully blank, no iTunes dependency.
  root.querySelector('#album-manual').addEventListener('click', () => {
    showReview({
      title: '', artist: '',
      artworkUrl: null, uploadedBlob: null,
      tracks: [{ title: '', feat: null }], // one empty row to start
      isBurnt: false,
    });
  });

  const doSearch = async () => {
    const term = q.value.trim();
    results.innerHTML = '';
    status.className = 'hint';
    if (term.length < 2) { status.textContent = term ? 'Type a little more to search.' : ''; return; }
    status.innerHTML = `<span class="spinner"></span> Searching…`;
    try {
      const albums = await itunes.searchAlbums(term);
      status.textContent = albums.length ? '' : 'No albums found — try “Add it manually” below.';
      results.innerHTML = albums.map((a, i) => `
        <li class="result" data-i="${i}">
          <img src="${a.artwork || ''}" alt="" onerror="this.style.visibility='hidden'"/>
          <div class="r-body"><div class="r-title">${escapeHtml(a.title)}</div>
            <div class="r-sub">${escapeHtml(a.artist)}${a.year ? ' · ' + a.year : ''}</div></div>
          <span class="r-add">+</span>
        </li>`).join('');
      results.querySelectorAll('.result').forEach(node => {
        node.addEventListener('click', () => selectAlbum(albums[Number(node.dataset.i)], status, showReview));
      });
    } catch (e) {
      status.className = 'hint err';
      status.textContent = errMsg(e);
    }
  };
  const run = debounce(doSearch, 350);
  q.addEventListener('input', () => { status.className = 'hint'; run(); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  root.querySelector('#album-search-btn').addEventListener('click', doSearch);
  q.focus();
}

async function selectAlbum(album, status, showReview) {
  status.className = 'hint';
  status.innerHTML = `<span class="spinner"></span> Loading tracklist…`;
  let tracks;
  try {
    tracks = await itunes.lookupAlbumTracks(album.collectionId);
  } catch (e) {
    status.className = 'hint err';
    status.textContent = errMsg(e);
    return;
  }
  status.textContent = '';

  // parse feat out of titles
  const parsed = tracks.map(t => itunes.parseFeat(t.rawTitle));
  showReview({
    title: album.title,
    artist: album.artist,
    artworkUrl: itunes.upscaleArtwork(album.artwork, 600),
    uploadedBlob: null,
    tracks: parsed.map(p => ({ title: p.title, feat: p.feat })),
    isBurnt: false,
  });
}

/** Review cover thumbnail: uploaded photo, fetched artwork, or (for manual
 *  entries with neither) the shared gradient + initials + diagonal-slice
 *  fallback, driven live off the typed title/artist. */
function reviewCoverHtml(model) {
  if (model.uploadedBlob) return `<span class="review-cover"><img src="${URL.createObjectURL(model.uploadedBlob)}" alt=""/></span>`;
  if (model.artworkUrl) return `<span class="review-cover"><img src="${model.artworkUrl}" alt=""/></span>`;
  const pal = makePalette((model.title || '') + (model.artist || ''));
  return `<span class="review-cover" style="background:linear-gradient(135deg,${pal[0]},${pal[1]})">${escapeHtml(initials(model.title || ''))}<span class="slice"></span></span>`;
}

/** Pointer-based drag-to-reorder for the review tracklist.
 *  Uses Pointer Events (not HTML5 drag-and-drop) so it works with touch on
 *  iOS/Android. The dragged row lifts out of flow and follows the finger while
 *  a placeholder shows where it will land; on drop we reorder `model.tracks`
 *  and redraw, which renumbers everything. Reordering never changes the entry
 *  type — it stays a standard album, never flagged burnt/custom. */
function enableTrackReorder(list, model, redraw) {
  if (!list) return;
  list.style.position = 'relative';
  list.querySelectorAll('.te-drag').forEach(handle => {
    handle.addEventListener('pointerdown', e => startTrackDrag(e, handle, list, model, redraw));
  });
}

function startTrackDrag(downEv, handle, list, model, redraw) {
  if (downEv.pointerType === 'mouse' && downEv.button !== 0) return;
  downEv.preventDefault();

  const row = handle.closest('.track-edit-row');
  const fromIndex = [...list.querySelectorAll('.track-edit-row')].indexOf(row);
  if (fromIndex < 0) return;

  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const grabOffsetY = downEv.clientY - rowRect.top;

  // Placeholder holds the row's slot while it floats.
  const ph = document.createElement('div');
  ph.className = 'te-placeholder';
  ph.style.height = rowRect.height + 'px';
  row.parentNode.insertBefore(ph, row);

  // Lift the row out of flow.
  row.classList.add('dragging');
  row.style.position = 'absolute';
  row.style.left = (rowRect.left - listRect.left) + 'px';
  row.style.width = rowRect.width + 'px';
  row.style.margin = '0';
  row.style.zIndex = '30';

  const setTop = clientY => {
    const lr = list.getBoundingClientRect(); // re-measure so it tracks page scroll
    row.style.top = (clientY - grabOffsetY - lr.top) + 'px';
  };
  setTop(downEv.clientY);

  try { handle.setPointerCapture(downEv.pointerId); } catch (_) {}

  const onMove = ev => {
    setTop(ev.clientY);
    const y = ev.clientY;
    const others = [...list.querySelectorAll('.track-edit-row')].filter(r => r !== row);
    let placed = false;
    for (const r of others) {
      const rc = r.getBoundingClientRect();
      if (y < rc.top + rc.height / 2) { list.insertBefore(ph, r); placed = true; break; }
    }
    if (!placed) list.appendChild(ph);
  };

  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    try { handle.releasePointerCapture(downEv.pointerId); } catch (_) {}

    // Target index = number of remaining rows sitting before the placeholder.
    let insertAt = 0;
    for (const n of list.children) {
      if (n === ph) break;
      if (n !== row && n.classList && n.classList.contains('track-edit-row')) insertAt++;
    }

    row.classList.remove('dragging');
    row.removeAttribute('style');
    ph.remove();

    if (insertAt !== fromIndex) {
      const [moved] = model.tracks.splice(fromIndex, 1);
      model.tracks.splice(insertAt, 0, moved);
    }
    redraw();
  };

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

function renderAlbumReview(root, model, close, onBack) {
  const draw = () => {
    root.innerHTML = `
      <div class="review-head">
        <span id="rv-cover-wrap">${reviewCoverHtml(model)}</span>
        <div class="review-fields">
          <input type="text" id="rv-title" placeholder="Album title" autocapitalize="words" value="${escapeHtml(model.title)}"/>
          <input type="text" id="rv-artist" placeholder="Artist" autocapitalize="words" value="${escapeHtml(model.artist)}"/>
        </div>
      </div>
      <div class="review-photo">
        <div class="review-photo-label">Use your own photo instead of the fetched artwork</div>
        <input type="file" id="rv-file" accept="image/*"/>
      </div>
      <div class="section-label" style="margin-left:0">Tracklist — edit if needed</div>
      <div id="rv-tracks">
        ${model.tracks.map((t, i) => {
          // feat === null -> no featured artist (offer a "+ artist" button).
          // feat is a string (incl. "") -> the featured-artist field is shown.
          const hasFeat = t.feat !== null && t.feat !== undefined;
          return `
          <div class="track-edit-row" data-i="${i}">
            <span class="te-drag" data-role="drag" aria-label="Drag to reorder" title="Drag to reorder">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 6h10M5 10h10M5 14h10"/></svg>
            </span>
            <span class="te-num">${i + 1}</span>
            <div class="te-main">
              <input type="text" value="${escapeHtml(t.title)}" data-role="title" placeholder="Track ${i + 1}" autocapitalize="words"/>
              ${hasFeat ? `
                <div class="te-feat-row">
                  <span class="te-feat-label">feat.</span>
                  <input type="text" class="te-feat" data-role="feat" value="${escapeHtml(t.feat)}" placeholder="Featured artist" autocapitalize="words"/>
                  <button class="te-feat-remove" data-role="feat-remove" aria-label="Remove featured artist">✕</button>
                </div>` : ''}
            </div>
            <div class="te-actions">
              ${hasFeat ? '' : `<button class="te-featbtn" data-role="feat-add">+ artist</button>`}
              <button class="icon-btn te-del" data-role="del" aria-label="Remove track">✕</button>
            </div>
          </div>`;
        }).join('')}
      </div>
      <button class="dashed-btn" id="rv-add-track">+ Add Custom Track</button>
      <div id="rv-error" class="hint"></div>
      <button class="btn dark block" id="rv-confirm" style="margin-top:14px">Add to Spares</button>
      <button class="linkback" id="rv-back">← Back to search</button>`;

    // With no fetched artwork, the live initials preview is the only visual
    // feedback available, so refresh it as the user types.
    const refreshCover = () => {
      if (model.uploadedBlob || model.artworkUrl) return;
      root.querySelector('#rv-cover-wrap').innerHTML = reviewCoverHtml(model);
    };
    root.querySelector('#rv-title').addEventListener('input', e => { model.title = e.target.value; refreshCover(); });
    root.querySelector('#rv-artist').addEventListener('input', e => { model.artist = e.target.value; refreshCover(); });
    root.querySelectorAll('#rv-tracks .track-edit-row').forEach(rowEl => {
      const i = Number(rowEl.dataset.i);
      rowEl.querySelector('[data-role="title"]').addEventListener('input', e => model.tracks[i].title = e.target.value);
      rowEl.querySelector('[data-role="del"]').addEventListener('click', () => { model.tracks.splice(i, 1); draw(); });
      rowEl.querySelector('[data-role="feat-add"]')?.addEventListener('click', () => {
        model.tracks[i].feat = '';
        draw();
        root.querySelector(`#rv-tracks .track-edit-row[data-i="${i}"] .te-feat`)?.focus();
      });
      rowEl.querySelector('[data-role="feat"]')?.addEventListener('input', e => model.tracks[i].feat = e.target.value);
      rowEl.querySelector('[data-role="feat-remove"]')?.addEventListener('click', () => { model.tracks[i].feat = null; draw(); });
    });
    root.querySelector('#rv-add-track').addEventListener('click', () => {
      model.tracks.push({ title: '', feat: null });
      draw();
      // Focus the freshly added row so the user can type straight away.
      const rows = root.querySelectorAll('#rv-tracks .track-edit-row [data-role="title"]');
      rows[rows.length - 1]?.focus();
    });
    enableTrackReorder(root.querySelector('#rv-tracks'), model, draw);
    root.querySelector('#rv-file').addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) { model.uploadedBlob = f; draw(); }
    });
    root.querySelector('#rv-confirm').addEventListener('click', () => confirmAlbum(model, root.querySelector('#rv-error'), close));
    root.querySelector('#rv-back').addEventListener('click', () => onBack && onBack());
  };
  draw();
}

async function confirmAlbum(model, errEl, close) {
  const title = model.title.trim();
  const artist = model.artist.trim();
  if (!title || !artist) { errEl.className = 'hint err'; errEl.textContent = 'Title and artist are required.'; return; }
  const tracks = model.tracks.map(t => t.title.trim()).filter(Boolean);
  if (tracks.length === 0) { errEl.className = 'hint err'; errEl.textContent = 'Add at least one track.'; return; }
  const dup = duplicateOf(title, artist);
  if (dup) {
    errEl.className = 'hint err';
    errEl.textContent = `Already in your collection: “${dup.title}” by ${dup.artist}.`;
    return;
  }
  const features = {};
  model.tracks.forEach(t => {
    const f = t.feat && t.feat.trim();
    if (t.title.trim() && f) features[t.title.trim()] = f;
  });

  const album = newAlbum({ title, artist, isBurnt: false, tracks, features, trackArtists: null });
  await attachCover(album, model.uploadedBlob, model.artworkUrl);
  addToSpares(album);
  close();
  toast(`“${title}” added — it’s Unassigned in Collection until you place it.`);
}

/* ---------- Mode B: Burnt CD ---------- */

function renderBurntMode(root, close) {
  const model = { title: '', tracks: [] /* {title, feat, artist} */, uploadedBlob: null };
  root.innerHTML = `
    <div class="field"><label>Disc name</label><input type="text" id="bt-name" placeholder="e.g. Summer Drive 2026" autocapitalize="words"/></div>
    <div class="hint">Artist: <strong>Various Artists</strong></div>
    <div class="sp-import" id="sp-import">
      <div class="sp-head"><span class="sp-dot"></span>Import from Spotify</div>
      <div id="sp-body"></div>
    </div>
    <div class="field" style="margin-top:10px">
      <label>Search songs</label>
      <div class="search-row">
        <input type="text" id="bt-q" placeholder="Any song, any artist"/>
        <button class="btn dark" id="bt-search-btn">Search</button>
      </div>
    </div>
    <div id="bt-status" class="hint"></div>
    <ul class="result-list" id="bt-results"></ul>
    <button class="dashed-btn" id="bt-manual">Can’t find this song? Add it manually</button>
    <div id="bt-manual-form"></div>
    <div class="section-label" style="margin-left:0">On this disc</div>
    <ul class="chosen-list" id="bt-chosen"></ul>
    <div class="review-photo" style="margin-top:12px">
      <div class="review-photo-label">Add a cover photo (optional)</div>
      <input type="file" id="bt-file" accept="image/*"/>
      <img class="preview" id="bt-preview" style="display:none;margin-left:0;margin-top:8px" alt=""/>
    </div>
    <div id="bt-error" class="hint"></div>
    <button class="btn dark block" id="bt-confirm" style="margin-top:14px">Add to Spares</button>
    <div class="modal-cancel-row"><button class="btn outline-accent" id="bt-cancel">Cancel</button></div>
  `;
  root.querySelector('#bt-cancel').addEventListener('click', close);

  root.querySelector('#bt-name').addEventListener('input', e => model.title = e.target.value);
  root.querySelector('#bt-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) { model.uploadedBlob = f; const p = root.querySelector('#bt-preview'); p.src = URL.createObjectURL(f); p.style.display = 'inline-block'; }
  });

  const q = root.querySelector('#bt-q');
  const status = root.querySelector('#bt-status');
  const results = root.querySelector('#bt-results');
  const drawChosen = () => {
    const c = root.querySelector('#bt-chosen');
    if (model.tracks.length === 0) { c.innerHTML = `<div class="hint">No songs yet — search and tap to add.</div>`; return; }
    c.innerHTML = model.tracks.map((t, i) => `
      <li class="chosen" data-i="${i}">
        <span class="c-num">${i + 1}</span>
        <div class="c-body"><div class="c-title">${escapeHtml(t.title)}${t.feat ? ` <span class="track-feat" style="display:inline">feat. ${escapeHtml(t.feat)}</span>` : ''}</div>
          <div class="c-sub">${escapeHtml(t.artist)}</div></div>
        <span class="c-x" aria-label="Remove">✕</span>
      </li>`).join('');
    c.querySelectorAll('.chosen').forEach(node => {
      node.querySelector('.c-x').addEventListener('click', () => { model.tracks.splice(Number(node.dataset.i), 1); drawChosen(); });
    });
  };
  drawChosen();

  /* ---- Spotify playlist import ----
     Paste a public playlist link and every track lands in `model.tracks` in
     the same {title, feat, artist} shape as a searched or manually typed
     song, so the normal confirm path saves it as a burnt disc unchanged.
     No sign-in or setup: js/spotify.js reads the playlist through the
     proxy in worker/. */
  const spBody = root.querySelector('#sp-body');
  spBody.innerHTML = `
    <div class="search-row">
      <input type="url" id="sp-link" placeholder="Paste a playlist link" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false"/>
      <button class="btn dark" id="sp-go">Import</button>
    </div>
    <div id="sp-status" class="hint"></div>
    <div class="sp-foot">Public playlists only · no Spotify sign-in needed.</div>`;
  const linkEl = spBody.querySelector('#sp-link');
  const st = spBody.querySelector('#sp-status');

  const doImport = async link => {
    const id = spotify.parsePlaylistId(link);
    if (!id) { st.className = 'hint err'; st.textContent = 'That doesn’t look like a Spotify playlist link.'; return; }
    st.className = 'hint';
    st.innerHTML = `<span class="spinner"></span> Fetching playlist…`;
    try {
      const pl = await spotify.fetchPlaylist(id, (done, total) => {
        st.innerHTML = `<span class="spinner"></span> Fetching ${done} of ${total} tracks…`;
      });
      const have = new Set(model.tracks.map(t => dupKey(t.title, t.artist)));
      let added = 0;
      for (const t of pl.tracks) {
        // Same parsing as a typed song: "(feat. X)" in the title wins;
        // otherwise any extra Spotify artists become the feat.
        const { title, feat: titleFeat } = itunes.parseFeat(t.rawTitle);
        const artist = t.artists[0] || 'Unknown Artist';
        const feat = titleFeat || (t.artists.length > 1 ? t.artists.slice(1).join(', ') : null);
        const key = dupKey(title, artist);
        if (have.has(key)) continue; // re-importing the same playlist won't double up
        have.add(key);
        model.tracks.push({ title, feat, artist });
        added++;
      }
      if (!model.title.trim()) {
        model.title = pl.name;
        root.querySelector('#bt-name').value = pl.name;
      }
      drawChosen();
      linkEl.value = '';
      st.className = 'hint';
      st.textContent = added
        ? `Imported ${added} track${added === 1 ? '' : 's'} from “${pl.name}”.`
        : (pl.tracks.length ? 'Those tracks are already on this disc.' : 'That playlist has no importable tracks.');
      if (navigator.vibrate) navigator.vibrate(18);
      if (added) toast(`Imported ${added} track${added === 1 ? '' : 's'}.`);
    } catch (e) {
      st.className = 'hint err';
      st.textContent = errMsg(e);
    }
  };

  spBody.querySelector('#sp-go').addEventListener('click', () => doImport(linkEl.value));
  linkEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doImport(linkEl.value); } });
  // Pasting a link is the whole gesture — import straight away.
  linkEl.addEventListener('paste', () => setTimeout(() => { if (spotify.parsePlaylistId(linkEl.value)) doImport(linkEl.value); }, 0));

  // Manual song entry — for tracks iTunes' catalogue doesn't return.
  const manualBtn = root.querySelector('#bt-manual');
  const manualForm = root.querySelector('#bt-manual-form');
  manualBtn.addEventListener('click', () => {
    if (manualForm.innerHTML) { manualForm.innerHTML = ''; return; } // toggle off
    manualForm.innerHTML = `
      <div class="field" style="margin-top:8px"><label>Song title</label><input type="text" id="ms-title" placeholder="Song title" autocapitalize="words"/></div>
      <div class="field"><label>Artist</label><input type="text" id="ms-artist" placeholder="Artist" autocapitalize="words"/></div>
      <div id="ms-error" class="hint"></div>
      <div class="footer-actions" style="margin-top:0">
        <button class="btn ghost" id="ms-cancel">Cancel</button>
        <button class="btn dark" id="ms-add">Add song</button>
      </div>`;
    const tEl = manualForm.querySelector('#ms-title');
    const aEl = manualForm.querySelector('#ms-artist');
    const errEl = manualForm.querySelector('#ms-error');
    tEl.focus();
    manualForm.querySelector('#ms-cancel').addEventListener('click', () => { manualForm.innerHTML = ''; });
    manualForm.querySelector('#ms-add').addEventListener('click', () => {
      const rawTitle = tEl.value.trim();
      const artist = aEl.value.trim();
      if (!rawTitle || !artist) { errEl.className = 'hint err'; errEl.textContent = 'Song title and artist are both required.'; return; }
      const { title, feat } = itunes.parseFeat(rawTitle);
      model.tracks.push({ title, feat, artist }); // appended like a search result
      drawChosen();
      // keep the form open for adding more; clear inputs
      tEl.value = ''; aEl.value = ''; errEl.textContent = ''; tEl.focus();
    });
  });

  const run = debounce(async () => {
    const term = q.value.trim();
    results.innerHTML = '';
    if (term.length < 2) { status.textContent = ''; return; }
    status.className = 'hint';
    status.innerHTML = `<span class="spinner"></span> Searching…`;
    try {
      const songs = await itunes.searchSongs(term);
      status.textContent = songs.length ? '' : 'No songs found.';
      results.innerHTML = songs.map((s, i) => `
        <li class="result" data-i="${i}">
          <img src="${s.artwork || ''}" alt="" onerror="this.style.visibility='hidden'"/>
          <div class="r-body"><div class="r-title">${escapeHtml(itunes.parseFeat(s.rawTitle).title)}</div>
            <div class="r-sub">${escapeHtml(s.artist)}${s.album ? ' · ' + escapeHtml(s.album) : ''}</div></div>
          <span class="r-add">+</span>
        </li>`).join('');
      results.querySelectorAll('.result').forEach(node => {
        node.addEventListener('click', () => {
          const s = songs[Number(node.dataset.i)];
          const { title, feat } = itunes.parseFeat(s.rawTitle);
          model.tracks.push({ title, feat, artist: s.artist });
          drawChosen();
          // Reset the search so the pick clearly registered (prevents the
          // "did it add?" double-tapping). Toast + haptic confirm it.
          q.value = '';
          results.innerHTML = '';
          status.className = 'hint';
          status.textContent = '';
          if (navigator.vibrate) navigator.vibrate(18);
          toast(`Added “${title}”.`);
          q.focus();
        });
      });
    } catch (e) {
      status.className = 'hint err';
      status.textContent = errMsg(e);
    }
  }, 350);
  q.addEventListener('input', () => { status.className = 'hint'; run(); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  root.querySelector('#bt-search-btn').addEventListener('click', () => run());

  root.querySelector('#bt-confirm').addEventListener('click', async () => {
    const errEl = root.querySelector('#bt-error');
    const title = model.title.trim();
    if (!title) { errEl.className = 'hint err'; errEl.textContent = 'Give the disc a name.'; return; }
    if (model.tracks.length === 0) { errEl.className = 'hint err'; errEl.textContent = 'Add at least one song.'; return; }
    const dup = duplicateOf(title, 'Various Artists');
    if (dup) { errEl.className = 'hint err'; errEl.textContent = `Already have a burnt disc named “${dup.title}”.`; return; }

    const tracks = model.tracks.map(t => t.title);
    const trackArtists = model.tracks.map(t => t.artist);
    const features = {};
    model.tracks.forEach(t => { if (t.feat) features[t.title] = t.feat; });

    const album = newAlbum({ title, artist: 'Various Artists', isBurnt: true, tracks, features, trackArtists });
    await attachCover(album, model.uploadedBlob, null);
    addToSpares(album);
    close();
    toast(`“${title}” added — it’s Unassigned in Collection until you place it.`);
  });
}

/* ---------- add helpers ---------- */

function newAlbum({ title, artist, isBurnt, tracks, features, trackArtists }) {
  return {
    id: uuid(),
    title, artist, isBurnt,
    coverImageUri: null,
    palette: makePalette(title + artist),
    features: features || {},
    trackArtists: trackArtists || null,
    tracks: tracks || [],
    dateAdded: Date.now(),
  };
}

async function attachCover(album, uploadedBlob, artworkUrl) {
  try {
    let blob = uploadedBlob || null;
    if (!blob && artworkUrl) blob = await itunes.fetchImageBlob(artworkUrl);
    if (blob) {
      const imgId = uuid();
      await putImage(imgId, blob);
      album.coverImageUri = imgId;
    }
  } catch (e) {
    // Offline / download failed — keep the gradient fallback; artwork
    // will be backfilled automatically on a later load with signal.
    console.warn('cover attach failed', e);
  }
}

/** New CDs land Unassigned (in Collection) until you choose where they go. */
function addToSpares(album) {
  M.addDisc(state, album);
  commit();
  render();
}

function errMsg(e) {
  if (e instanceof NetworkError) return e.message;
  return 'Something went wrong. Try again.';
}

/* ======================================================================
   SHARE / BACKUP — export & import the whole collection as one file.

   There is no backend; this is how two phones (e.g. shared car) stay in
   sync. Export bundles the AppState AND every cover image (as base64) so
   the file is self-contained and works offline. Import replaces the whole
   collection on this device (confirmed first, since it's destructive).
   ====================================================================== */

const EXPORT_TAG = 'brera-stacker';

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

async function exportCollection() {
  try {
    // collect every referenced cover image
    const ids = new Set();
    M.allDiscs(state).forEach(a => {
      if (a.coverImageUri) ids.add(a.coverImageUri);
    });
    const images = {};
    for (const id of ids) {
      const blob = await getImageBlob(id);
      if (blob) images[id] = await blobToDataURL(blob);
    }
    const payload = { app: EXPORT_TAG, version: 2, exportedAt: new Date().toISOString(), state, images };
    const json = JSON.stringify(payload);
    const fname = `brera-stacker-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], fname, { type: 'application/json' });

    // Prefer the native share sheet on mobile (send straight to Messages/AirDrop).
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Brera Stacker collection' });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // user cancelled the share sheet
        // otherwise fall through to a download
      }
    }
    // Fallback: download the file.
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = fname; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('Collection saved to a file — send it to the other phone.');
  } catch (e) {
    console.error(e);
    toast('Could not export the collection.', true);
  }
}

async function handleImportFile(file) {
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    toast('That file isn’t readable — is it a Brera backup?', true);
    return;
  }
  if (!payload || payload.app !== EXPORT_TAG || !(M.isV1(payload.state) || M.isV2(payload.state))) {
    toast('That file isn’t a Brera Stacker backup.', true);
    return;
  }
  // Old single-car backups are migrated on the way in, exactly like on first run.
  const incoming = M.isV2(payload.state)
    ? M.normalize(payload.state, uuid)
    : M.normalize(M.migrateV1(payload.state, uuid), uuid);
  const count = Object.keys(incoming.discs).length;
  const when = payload.exportedAt ? new Date(payload.exportedAt).toLocaleDateString() : 'an unknown date';

  confirmSheet({
    title: 'Import collection?',
    message: `This replaces everything on this phone with ${count} CD${count === 1 ? '' : 's'} from the backup (exported ${when}). Your current collection here will be overwritten.`,
    confirmLabel: 'Replace my collection',
    onConfirm: async () => {
      try {
        if (payload.images) {
          for (const [id, dataUrl] of Object.entries(payload.images)) {
            const blob = await dataURLToBlob(dataUrl);
            await putImage(id, blob);
          }
        }
        state = incoming;
        await saveState(state);
        render();
        if (state.pendingSort) openSortSpares();
        toast(`Imported ${count} CD${count === 1 ? '' : 's'}.`);
        backfillArtwork(); // fetch any covers the file didn't include
      } catch (e) {
        console.error(e);
        toast('Import failed partway — please try the file again.', true);
      }
    },
  });
}

/** Small on-brand confirm bottom-sheet (used for destructive import). */
function confirmSheet({ title, message, confirmLabel, onConfirm }) {
  const { body, close } = modalShell(title, { showClose: true });
  body.innerHTML = `
    <p class="hint" style="font-size:14px;line-height:1.45">${escapeHtml(message)}</p>
    <button class="btn accent block" id="cf-yes" style="margin-top:8px">${escapeHtml(confirmLabel)}</button>
    <div class="modal-cancel-row"><button class="btn outline-accent" id="cf-no">Cancel</button></div>
  `;
  body.querySelector('#cf-no').addEventListener('click', close);
  body.querySelector('#cf-yes').addEventListener('click', () => { close(); onConfirm(); });
}

/* ======================================================================
   SORT YOUR SPARES — one time, after upgrading from the single-car app.

   The old Spares pile is split by where each CD physically is. Migration
   pre-sorts (burnt CDs -> Glovebox, the rest -> Boot); this sheet lets the
   user correct that. Each tap applies straight away, so closing the sheet
   any way keeps what's shown and finishes the sort.
   ====================================================================== */

function openSortSpares() {
  const ids = (state.pendingSort || []).filter(id => D(id));
  if (!ids.length) { delete state.pendingSort; commit(); return; }
  const c = car();
  const { modal, body, close } = modalShell('Sort your spares', {
    subtitle: `Spares are now split by where each CD is in the ${c.name}. Check each one, then tap Done.`,
    onClose: () => { delete state.pendingSort; commit(); render(); },
  });
  modal.classList.add('sort-sheet');
  const current = id => (M.placeOf(state, id) || { loc: 'unassigned' }).loc;
  const OPTS = [['glovebox', 'Glovebox'], ['boot', 'Boot'], ['unassigned', 'Unassigned']];
  const draw = () => {
    body.innerHTML = `
      <div class="sort-list">
        ${ids.map(id => {
          const a = D(id), loc = current(id);
          return `<div class="sort-row" data-id="${escapeHtml(id)}">
            <div class="sort-text">
              <div class="sort-title">${escapeHtml(a.title)}${a.isBurnt ? '<span class="badge-burnt">BURNT</span>' : ''}</div>
              <div class="sort-artist">${escapeHtml(a.artist)}</div>
            </div>
            <div class="segmented sort-seg" role="group" aria-label="Where is ${escapeHtml(a.title)}?">
              ${OPTS.map(([k, label]) => `<button data-loc="${k}" class="${loc === k ? 'on' : ''}" aria-pressed="${loc === k}">${label}</button>`).join('')}
            </div>
          </div>`;
        }).join('')}
      </div>
      <button class="btn dark block" id="sort-done" style="margin-top:14px">Done</button>`;
    body.querySelectorAll('.sort-row').forEach(row => {
      row.querySelectorAll('[data-loc]').forEach(btn => btn.addEventListener('click', () => {
        const id = row.dataset.id, loc = btn.dataset.loc;
        if (loc === 'unassigned') M.detach(state, id);
        else M.putAt(state, id, c, loc);
        commit();
        draw();
      }));
    });
    body.querySelector('#sort-done').addEventListener('click', close);
  };
  draw();
}

/* ======================================================================
   DEV TOOLS — only with ?dev=1 in the URL. A sample second car to test
   multi-car before the real car switcher exists (stage 3). Everything it
   creates is flagged `sample` so it can be removed cleanly.
   ====================================================================== */

function sampleAlbum(title, artist, tracks, extra = {}) {
  return { id: uuid(), title, artist, isBurnt: false, coverImageUri: null, palette: makePalette(title + artist),
    features: {}, trackArtists: null, tracks, dateAdded: Date.now(), sample: true, ...extra };
}

function addSampleMiata() {
  if (state.cars.some(c => c.sample)) { toast('The sample Miata is already added.'); return; }
  const miata = M.newCar(uuid, {
    name: 'Miata', title: 'Miata Stacker', subtitle: '6-disc stacker · 1 dash slot', stackerSize: 6,
    theme: { layout: 'block', shape: 'cd', nums: 'pixel', bg: '#141414', accent: '#1F5FBF' },
  });
  miata.sample = true;
  const add = a => M.addDisc(state, a);
  const stacker = [
    sampleAlbum('Nevermind', 'Nirvana', ['Smells Like Teen Spirit', 'In Bloom', 'Come as You Are', 'Lithium']),
    sampleAlbum('Discovery', 'Daft Punk', ['One More Time', 'Aerodynamic', 'Digital Love', 'Harder, Better, Faster, Stronger']),
    sampleAlbum('Currents', 'Tame Impala', ['Let It Happen', 'The Less I Know the Better', 'Eventually']),
    sampleAlbum('AM', 'Arctic Monkeys', ['Do I Wanna Know?', 'R U Mine?', 'Arabella']),
    sampleAlbum('Thriller', 'Michael Jackson', ['Thriller', 'Beat It', 'Billie Jean']),
    sampleAlbum('Parklife', 'Blur', ['Girls & Boys', 'Parklife', 'End of a Century']),
  ];
  stacker.forEach((a, i) => { add(a); miata.stacker[i] = a.id; });
  const dash = sampleAlbum('Back in Black', 'AC/DC', ['Hells Bells', 'Back in Black', 'You Shook Me All Night Long']);
  add(dash); miata.dash = dash.id;
  const glove = [
    sampleAlbum('Is This It', 'The Strokes', ['Someday', 'Last Nite', 'Hard to Explain']),
    sampleAlbum('Miata Summer Mix', 'Various Artists', ['Mr. Brightside', 'Midnight City', 'Electric Feel'],
      { isBurnt: true, trackArtists: ['The Killers', 'M83', 'MGMT'] }),
  ];
  glove.forEach(a => { add(a); miata.glovebox.push(a.id); });
  const boot = [
    sampleAlbum('The Joshua Tree', 'U2', ['Where the Streets Have No Name', 'With or Without You']),
    sampleAlbum('Rumours', 'Fleetwood Mac', ['Dreams', 'Go Your Own Way', 'The Chain']),
  ];
  boot.forEach(a => { add(a); miata.boot.push(a.id); });
  // Two loose CDs owned but in no car.
  add(sampleAlbum('Abbey Road', 'The Beatles', ['Come Together', 'Something', 'Here Comes the Sun']));
  add(sampleAlbum('Kind of Blue', 'Miles Davis', ['So What', 'Freddie Freeloader', 'Blue in Green']));
  state.cars.push(miata);
  commit();
  render();
  toast('Sample Miata added — 6-disc stacker, plus 2 Unassigned CDs.');
}

function removeSampleMiata() {
  for (const a of M.allDiscs(state)) if (a.sample) M.removeDisc(state, a.id);
  state.cars = state.cars.filter(c => !c.sample);
  M.normalize(state, uuid);
  commit();
  render();
  toast('Sample car and its CDs removed.');
}

function devSampleTools() {
  if (!DEV) return '';
  const has = state.cars.some(c => c.sample);
  return `<div class="dev-tools">
      <div class="dev-label">Test tools (?dev=1)</div>
      <div class="dev-row">
        <button class="btn ghost" id="dev-add-miata" ${has ? 'disabled' : ''}>Add sample Miata</button>
        <button class="btn ghost" id="dev-remove-miata" ${has ? '' : 'disabled'}>Remove sample car</button>
      </div>
    </div>`;
}

function wireDevSampleTools(view) {
  view.querySelector('#dev-add-miata')?.addEventListener('click', addSampleMiata);
  view.querySelector('#dev-remove-miata')?.addEventListener('click', removeSampleMiata);
}

/** Stand-in car switch until the real switcher (stage 3). */
function devCarTools() {
  if (!DEV || state.cars.length < 2) return '';
  return `<div class="dev-cars" role="group" aria-label="Car (test)">
      ${state.cars.map(c => `<button class="btn ghost ${c.id === state.selectedCarId ? 'on' : ''}" data-car="${escapeHtml(c.id)}">${escapeHtml(c.name)}</button>`).join('')}
    </div>`;
}

function wireDevCarTools(view) {
  view.querySelectorAll('[data-car]').forEach(btn => btn.addEventListener('click', () => {
    state.selectedCarId = btn.dataset.car;
    reordering = false;
    commit();
    render();
  }));
}

/* ======================================================================
   BACKGROUND ARTWORK BACKFILL — sequential, silent
   ====================================================================== */

async function backfillArtwork() {
  const missing = M.allDiscs(state).filter(a => !a.coverImageUri);
  for (const album of missing) {
    try {
      const url = await itunes.findArtwork(album.artist, album.title);
      if (url) {
        const blob = await itunes.fetchImageBlob(url);
        const imgId = uuid();
        await putImage(imgId, blob);
        // never overwrite a real image acquired since (upload/fetch)
        if (!album.coverImageUri) {
          album.coverImageUri = imgId;
          await commit();
          render();
        } else {
          deleteImage(imgId).catch(() => {});
        }
      }
    } catch (e) {
      // Fail silently. If offline, stop the whole run — retry next load.
      if (e instanceof NetworkError && e.kind === 'offline') break;
    }
  }
}

/* ======================================================================
   TABS
   ====================================================================== */

function wireTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

function switchTab(name) {
  if (name === currentTab) return;
  currentTab = name;
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.getElementById('view-stacker').hidden = name !== 'stacker';
  document.getElementById('view-collection').hidden = name !== 'collection';
  document.getElementById('view-spares').hidden = name !== 'spares';
  window.scrollTo(0, 0);
}

window.addEventListener('online', () => { toast('Back online.'); backfillArtwork(); });
window.addEventListener('offline', () => toast('Offline — lookups paused. Everything else still works.', false, 3800));

boot();
