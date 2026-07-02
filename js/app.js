/* ============================================================
   app.js — Brera Stacker application.

   Mirrors a real physical constraint: 10 rear-boot stacker slots
   + 1 hot-swap dash slot, plus a library of spare CDs. All state
   is persisted to IndexedDB (store.js) and survives restarts.
   ============================================================ */

import { loadState, saveState, imageUrl, putImage, deleteImage } from './store.js';
import * as itunes from './itunes.js';
import { NetworkError } from './itunes.js';
import { uuid, initials, makePalette, escapeHtml, debounce, h, toast, dupKey } from './util.js';

let state = null;
let currentTab = 'stacker';
let reordering = false;
let spareFilter = '';

/* ---------- boot ---------- */

async function boot() {
  state = await loadState();
  registerSW();
  wireTabs();
  render();
  // background artwork fetch, sequential, silent
  backfillArtwork();
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
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

  const rows = state.stacker.map((album, i) => stackerRow(album, i)).join('');

  view.innerHTML = `
    <header class="app-header">
      <h1 class="app-title">Brera Stacker</h1>
      <p class="app-subtitle">10-disc boot stacker &middot; 1 dash slot</p>
    </header>

    <div class="section-label">Stacker &middot; Slots 1–10</div>
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
    const album = state.stacker[i];
    if (reordering) {
      node.querySelector('.move-up')?.addEventListener('click', e => { e.stopPropagation(); moveSlot(i, -1); });
      node.querySelector('.move-down')?.addEventListener('click', e => { e.stopPropagation(); moveSlot(i, +1); });
    } else if (album) {
      node.addEventListener('click', () => openTracklist(node, album, { source: 'stacker', index: i }));
    } else {
      node.addEventListener('click', () => openSwapToDestination({ type: 'stacker', index: i }));
    }
  });

  wireDash(view);
  fillCovers(view);
}

function stackerRow(album, i) {
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
          <button class="icon-btn move-down" ${i === 9 ? 'disabled' : ''} aria-label="Move down">▼</button>
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
  if (!state.dash) {
    return `<div class="dash-empty" id="dash-empty">
        <div class="plus">+</div>
        <div>
          <div class="t1">Nothing in the Dash</div>
          <div class="t2">Tap to choose a CD from Spares.</div>
        </div>
      </div>`;
  }
  const a = state.dash;
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
    card.addEventListener('click', () => openTracklist(card, state.dash, { source: 'dash' }));
  }
}

/* ---------- Spares view ---------- */

function sortSpares() {
  state.spares.sort((a, b) => {
    const ai = a.artist.toLowerCase(), bi = b.artist.toLowerCase();
    if (ai !== bi) return ai < bi ? -1 : 1;
    const at = a.title.toLowerCase(), bt = b.title.toLowerCase();
    return at < bt ? -1 : at > bt ? 1 : 0;
  });
}

function renderSpares() {
  const view = document.getElementById('view-spares');
  sortSpares();

  const q = spareFilter.trim().toLowerCase();
  // Filter the DISPLAY only; underlying sorted data is untouched.
  const visible = state.spares
    .map((a, idx) => ({ a, idx }))
    .filter(({ a }) => !q || a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q));

  let listHtml;
  if (state.spares.length === 0) {
    listHtml = `<div class="empty-state">
        <div class="big">No spares yet</div>
        <div class="small">Add a CD with the button below — it lands here, ready to swap into rotation.</div>
      </div>`;
  } else if (visible.length === 0) {
    listHtml = `<div class="empty-state">
        <div class="big">No results for “${escapeHtml(spareFilter)}”</div>
        <div class="small">Try a different title or artist.</div>
      </div>`;
  } else {
    listHtml = visible.map(({ a, idx }) => spareRow(a, idx)).join('');
  }

  view.innerHTML = `
    <header class="app-header">
      <h1 class="app-title">Spares</h1>
      <p class="app-subtitle">Owned, not currently in the car &middot; ${state.spares.length} CD${state.spares.length === 1 ? '' : 's'}</p>
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
  `;

  const search = view.querySelector('#spare-search');
  search.addEventListener('input', debounce(e => {
    spareFilter = e.target.value;
    renderSpares();
    // keep focus after re-render
    const s = document.getElementById('spare-search');
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
  }, 130));

  view.querySelector('#add-cd').addEventListener('click', openAddSheet);

  view.querySelectorAll('#spares-list [data-spare]').forEach(node => {
    const id = node.getAttribute('data-spare');
    const album = state.spares.find(s => s.id === id);
    node.querySelector('.swap-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openSwapFromSpare(album);
    });
    node.addEventListener('click', () => openTracklist(node, album, { source: 'spares' }));
  });

  fillCovers(view);
}

function spareRow(album) {
  return `<div class="card" data-spare="${escapeHtml(album.id)}">
      ${coverHtml(album)}
      <div class="card-body">
        <div class="card-title">${escapeHtml(album.title)}${album.isBurnt ? '<span class="badge-burnt">BURNT</span>' : ''}</div>
        <div class="card-artist">${escapeHtml(album.artist)}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn swap-btn" aria-label="Swap into rotation">⇄</button>
      </div>
    </div>`;
}

/* ======================================================================
   STATE TRANSITIONS
   ====================================================================== */

function moveSlot(i, dir) {
  const j = i + dir;
  if (j < 0 || j > 9) return;
  const arr = state.stacker;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  commit();
  renderStacker();
}

function ejectDash() {
  if (!state.dash) return;
  const disc = state.dash;
  state.dash = null;
  state.spares.push(disc); // returns to Spares
  commit();
  render();
}

/**
 * Core swap. Moves a spare (by id) into a destination slot; whatever
 * occupied the destination returns to Spares. If the destination was
 * empty there is nothing to return — the spare is simply removed from
 * Spares (never replaced with a null placeholder).
 */
function performSwap(spareId, dest) {
  const si = state.spares.findIndex(s => s.id === spareId);
  if (si === -1) return;
  const spare = state.spares[si];

  let occupant = null;
  if (dest.type === 'dash') {
    occupant = state.dash;          // may be null (empty dash edge case)
    state.dash = spare;
  } else {
    occupant = state.stacker[dest.index]; // may be null (empty slot)
    state.stacker[dest.index] = spare;
  }

  // Remove the spare from the library outright.
  state.spares.splice(si, 1);

  // Return the previous occupant, if any, to the library.
  if (occupant) state.spares.push(occupant);

  commit();
  render();
}

/* ======================================================================
   TRACKLIST SHEET — signature container-transform interaction
   ====================================================================== */

const layer = () => document.getElementById('layer');
let activeSheet = null;

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
  if (ctx.source === 'stacker') return `Slot ${ctx.index + 1}`;
  if (ctx.source === 'dash') return 'Dash';
  return 'Spares';
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
  };
  sheet.addEventListener('transitionend', function te(e) {
    if (e.propertyName === 'height') { sheet.removeEventListener('transitionend', te); done(); }
  });
  setTimeout(done, 700); // safety
}

/* ---------- delete zone (spares only) ---------- */

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
  const idx = state.spares.findIndex(s => s.id === id);
  if (idx === -1) return;
  const [removed] = state.spares.splice(idx, 1);
  if (removed.coverImageUri) deleteImage(removed.coverImageUri).catch(() => {});
  await commit();
  render();
  toast('CD deleted.');
}

/* ======================================================================
   SWAP PICKERS
   ====================================================================== */

function modalShell(title) {
  const l = layer();
  l.classList.add('active');
  const scrim = h(`<div class="scrim"></div>`);
  const modal = h(`
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">${escapeHtml(title)}</div>
        <button class="icon-btn round modal-close" aria-label="Close">✕</button>
      </div>
      <div class="modal-body"></div>
    </div>`);
  l.appendChild(scrim);
  l.appendChild(modal);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    scrim.classList.add('show');
    modal.classList.add('show');
  }));
  const close = () => {
    scrim.classList.remove('show');
    modal.classList.remove('show');
    setTimeout(() => { scrim.remove(); modal.remove(); if (!activeSheet) l.classList.remove('active'); }, 360);
  };
  scrim.addEventListener('click', close);
  modal.querySelector('.modal-close').addEventListener('click', close);
  return { modal, body: modal.querySelector('.modal-body'), close };
}

/** From a Spare's ⇄ button: choose which slot/dash to swap it into. */
function openSwapFromSpare(spare) {
  const { body, close } = modalShell(`Swap “${spare.title}” into…`);
  const dests = [];
  for (let i = 0; i < 10; i++) {
    const occ = state.stacker[i];
    dests.push(`<div class="swap-dest" data-type="stacker" data-index="${i}">
        <span class="d-num">Slot ${i + 1}</span>
        <div class="d-body">${occ
          ? `<div class="d-occ">${escapeHtml(occ.title)}</div><div class="d-empty" style="font-style:normal;color:var(--text-2)">${escapeHtml(occ.artist)}</div>`
          : `<div class="d-empty">Empty</div>`}</div>
        <span class="r-add">⇄</span>
      </div>`);
  }
  const dOcc = state.dash;
  dests.push(`<div class="swap-dest dash" data-type="dash">
      <span class="d-num">Dash</span>
      <div class="d-body">${dOcc
        ? `<div class="d-occ">${escapeHtml(dOcc.title)}</div>`
        : `<div class="d-empty">Empty</div>`}</div>
      <span class="r-add">⇄</span>
    </div>`);

  body.innerHTML = `<p class="hint">Whatever is in the chosen slot moves back to Spares.</p>${dests.join('')}`;
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
  if (state.spares.length === 0) {
    body.innerHTML = `<div class="empty-state"><div class="big">No spares available</div>
      <div class="small">Add a CD first, then swap it in here.</div></div>`;
    return;
  }
  sortSpares();
  const rows = state.spares.map(a => `
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
      const spare = state.spares.find(s => s.id === id);
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
  const all = [...state.stacker.filter(Boolean), state.dash, ...state.spares].filter(Boolean);
  return all.find(a => dupKey(a.title, a.artist) === key) || null;
}

function openAddSheet() {
  const { body, close } = modalShell('Add CD');
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
    <div class="field">
      <label>Search album</label>
      <input type="text" id="album-q" placeholder="Album or artist" />
    </div>
    <div id="album-status" class="hint"></div>
    <ul class="result-list" id="album-results"></ul>
    <div id="album-review"></div>
  `;
  const q = root.querySelector('#album-q');
  const status = root.querySelector('#album-status');
  const results = root.querySelector('#album-results');

  const run = debounce(async () => {
    const term = q.value.trim();
    results.innerHTML = '';
    root.querySelector('#album-review').innerHTML = '';
    if (term.length < 2) { status.textContent = ''; return; }
    status.innerHTML = `<span class="spinner"></span> Searching…`;
    try {
      const albums = await itunes.searchAlbums(term);
      status.textContent = albums.length ? '' : 'No albums found.';
      results.innerHTML = albums.map((a, i) => `
        <li class="result" data-i="${i}">
          <img src="${a.artwork || ''}" alt="" onerror="this.style.visibility='hidden'"/>
          <div class="r-body"><div class="r-title">${escapeHtml(a.title)}</div>
            <div class="r-sub">${escapeHtml(a.artist)}${a.year ? ' · ' + a.year : ''}</div></div>
          <span class="r-add">+</span>
        </li>`).join('');
      results.querySelectorAll('.result').forEach(node => {
        node.addEventListener('click', () => selectAlbum(albums[Number(node.dataset.i)], root, status, close));
      });
    } catch (e) {
      status.className = 'hint err';
      status.textContent = errMsg(e);
    }
  }, 350);

  q.addEventListener('input', () => { status.className = 'hint'; run(); });
  q.focus();
}

async function selectAlbum(album, root, status, close) {
  const results = root.querySelector('#album-results');
  const review = root.querySelector('#album-review');
  results.innerHTML = '';
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
  const model = {
    title: album.title,
    artist: album.artist,
    artworkUrl: itunes.upscaleArtwork(album.artwork, 600),
    uploadedBlob: null,
    tracks: parsed.map(p => ({ title: p.title, feat: p.feat })),
    isBurnt: false,
  };
  renderAlbumReview(review, model, status, close);
}

function renderAlbumReview(root, model, status, close) {
  const draw = () => {
    root.innerHTML = `
      <div class="section-label" style="margin-left:0">Review</div>
      <div class="field"><label>Title</label><input type="text" id="rv-title" value="${escapeHtml(model.title)}"/></div>
      <div class="field"><label>Artist</label><input type="text" id="rv-artist" value="${escapeHtml(model.artist)}"/></div>
      <div class="field">
        <label>Tracks</label>
        <div id="rv-tracks">
          ${model.tracks.map((t, i) => `
            <div class="track-edit-row" data-i="${i}">
              <input type="text" value="${escapeHtml(t.title)}" data-role="title"/>
              <button class="icon-btn" data-role="del" aria-label="Remove">✕</button>
            </div>`).join('')}
        </div>
        <button class="btn ghost" id="rv-add-track" style="margin-top:6px">+ Add track</button>
      </div>
      <div class="field">
        <label>Cover</label>
        <div class="file-drop">
          <label for="rv-file">Use your own photo instead
            <input type="file" id="rv-file" accept="image/*"/>
          </label>
          <img class="preview" id="rv-preview" style="display:${model.uploadedBlob ? 'inline-block' : (model.artworkUrl ? 'inline-block' : 'none')}"
               src="${model.uploadedBlob ? URL.createObjectURL(model.uploadedBlob) : (model.artworkUrl || '')}" alt=""/>
        </div>
      </div>
      <div id="rv-error" class="hint"></div>
      <div class="form-actions">
        <button class="btn accent" id="rv-confirm">Add to Spares</button>
      </div>`;

    root.querySelector('#rv-title').addEventListener('input', e => model.title = e.target.value);
    root.querySelector('#rv-artist').addEventListener('input', e => model.artist = e.target.value);
    root.querySelectorAll('#rv-tracks .track-edit-row').forEach(rowEl => {
      const i = Number(rowEl.dataset.i);
      rowEl.querySelector('[data-role="title"]').addEventListener('input', e => model.tracks[i].title = e.target.value);
      rowEl.querySelector('[data-role="del"]').addEventListener('click', () => { model.tracks.splice(i, 1); draw(); });
    });
    root.querySelector('#rv-add-track').addEventListener('click', () => { model.tracks.push({ title: '', feat: null }); draw(); });
    root.querySelector('#rv-file').addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) { model.uploadedBlob = f; draw(); }
    });
    root.querySelector('#rv-confirm').addEventListener('click', () => confirmAlbum(model, root.querySelector('#rv-error'), close));
  };
  draw();
}

async function confirmAlbum(model, errEl, close) {
  const title = model.title.trim();
  const artist = model.artist.trim();
  if (!title || !artist) { errEl.className = 'hint err'; errEl.textContent = 'Title and artist are required.'; return; }
  const dup = duplicateOf(title, artist);
  if (dup) {
    errEl.className = 'hint err';
    errEl.textContent = `Already in your collection: “${dup.title}” by ${dup.artist}.`;
    return;
  }
  const tracks = model.tracks.map(t => t.title.trim()).filter(Boolean);
  const features = {};
  model.tracks.forEach(t => { if (t.title.trim() && t.feat) features[t.title.trim()] = t.feat; });

  const album = newAlbum({ title, artist, isBurnt: false, tracks, features, trackArtists: null });
  await attachCover(album, model.uploadedBlob, model.artworkUrl);
  addToSpares(album);
  close();
  toast(`“${title}” added to Spares.`);
}

/* ---------- Mode B: Burnt CD ---------- */

function renderBurntMode(root, close) {
  const model = { title: '', tracks: [] /* {title, feat, artist} */, uploadedBlob: null };
  root.innerHTML = `
    <div class="field"><label>Disc name</label><input type="text" id="bt-name" placeholder="e.g. Summer Drive 2026"/></div>
    <div class="hint">Artist: <strong>Various Artists</strong></div>
    <div class="field" style="margin-top:10px">
      <label>Search songs</label>
      <input type="text" id="bt-q" placeholder="Any song, any artist"/>
    </div>
    <div id="bt-status" class="hint"></div>
    <ul class="result-list" id="bt-results"></ul>
    <div class="section-label" style="margin-left:0">On this disc</div>
    <ul class="chosen-list" id="bt-chosen"></ul>
    <div class="field" style="margin-top:12px">
      <label>Cover</label>
      <div class="file-drop">
        <label for="bt-file">Add a photo (optional)<input type="file" id="bt-file" accept="image/*"/></label>
        <img class="preview" id="bt-preview" style="display:none" alt=""/>
      </div>
    </div>
    <div id="bt-error" class="hint"></div>
    <div class="form-actions"><button class="btn accent" id="bt-confirm">Add to Spares</button></div>
  `;

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
        });
      });
    } catch (e) {
      status.className = 'hint err';
      status.textContent = errMsg(e);
    }
  }, 350);
  q.addEventListener('input', () => { status.className = 'hint'; run(); });

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
    toast(`“${title}” added to Spares.`);
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

function addToSpares(album) {
  state.spares.push(album);
  sortSpares();
  commit();
  render();
}

function errMsg(e) {
  if (e instanceof NetworkError) return e.message;
  return 'Something went wrong. Try again.';
}

/* ======================================================================
   BACKGROUND ARTWORK BACKFILL — sequential, silent
   ====================================================================== */

async function backfillArtwork() {
  const all = [...state.stacker.filter(Boolean), state.dash, ...state.spares].filter(Boolean);
  const missing = all.filter(a => !a.coverImageUri);
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
  document.getElementById('view-spares').hidden = name !== 'spares';
  window.scrollTo(0, 0);
}

window.addEventListener('online', () => { toast('Back online.'); backfillArtwork(); });
window.addEventListener('offline', () => toast('Offline — lookups paused. Everything else still works.', false, 3800));

boot();
