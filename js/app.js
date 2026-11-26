/**
 * NIJI VOICE — app shell, views and wiring.
 */
import { Drive, SharedMeta, NeedsAuth, META_NAME } from './drive.js';
import { parseId3 } from './id3.js';
import { Player, fmtTime } from './player.js';
import * as db from './db.js';
import { DEMO_TREE, demoAudioUrl, demoParsed, demoMeta } from './demo.js';

/* ─────────────────────────── helpers ─────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SETTINGS_KEY = 'niji.settings';
const PERSONAL_KEY = 'niji.personal';
const DEMO_META_KEY = 'niji.demo.meta';

function toast(msg, { err = false, ms = 2400 } = {}) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; }, ms);
  setTimeout(() => el.remove(), ms + 260);
}

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const p = (v) => String(v).padStart(2, '0');
  return `${sameYear ? '' : d.getFullYear() + '. '}${p(d.getMonth() + 1)}. ${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function displayName(name) {
  return String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
}

/* ── auto tags from folder path / file name / ID3 album ── */
function cleanSeriesName(text, { liverShort = '', liver = '' } = {}) {
  let s = String(text || '').trim();
  if (!s) return '';
  s = s.replace(/\.[a-z0-9]{2,5}$/i, '');
  s = s.replace(/^\s*\d{1,4}[_.\-\s]+/, '');
  s = s.replace(/^(19|20)\d{2}[_.\-\s]*/, '');
  s = s.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/ex[\s_-]*another/gi, ' ').replace(/\bex\b/gi, ' ');
  if (liver) s = s.split(liver).join(' ');
  if (liverShort) s = s.split(liverShort).join(' ');
  s = s.replace(/\s+/g, ' ').replace(/^[\s\-_.·]+|[\s\-_.·]+$/g, '').trim();
  if (!s) return '';
  if (/^(ex|another|ex another|ボイス|voice|전체)$/i.test(s)) return '';
  return s;
}

const autoTagCache = new Map();

function autoTagsOf(f) {
  if (!f) return [];
  const album = parsedCache.get(f.id)?.album || '';
  const key = `${album}|${f.name}|${f.liver}|${(f.path || []).join('/')}`;
  const hit = autoTagCache.get(f.id);
  if (hit && hit.key === key) return hit.tags;

  const nameBase = displayName(f.name || '');
  const liverShort = (f.liver || '').replace(/\s*\([^)]*\)\s*$/, '');
  const opts = { liverShort, liver: f.liver || '' };

  let series = '';
  const sources = [album, ...(f.path || []).slice(1).reverse(), nameBase];
  for (const source of sources) {
    series = cleanSeriesName(source, opts);
    if (series && series !== liverShort) break;
    series = '';
  }

  const tags = [];
  if (series && series !== f.year) tags.push(series);
  if (f.year) tags.push(f.year);
  if (/(^|[\s_-])ex([\s_-]|$)|ex[\s_-]*another/i.test(nameBase)) tags.push('EX');

  const out = [...new Set(tags.filter(Boolean).map((t) => t.replace(/\s+/g, ' ').trim()))];
  autoTagCache.set(f.id, { key, tags: out });
  return out;
}

/** custom tags (shared meta) + derived tags, custom first */
function tagsOf(f) {
  if (!f) return [];
  const custom = shared?.tagsOf(f.id) || [];
  const auto = autoTagsOf(f);
  if (!auto.length) return custom;
  const out = [...custom];
  for (const t of auto) if (!out.includes(t)) out.push(t);
  return out;
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

/* ── offline-first cache (instant start) ── */
const treeCacheKey = (rootId) => `niji.tree.${rootId || 'default'}`;
const metaCacheKey = (rootId) => `niji.meta.${rootId || 'default'}`;

function saveTreeCache(tree) {
  if (!tree?.root?.id) return;
  try {
    localStorage.setItem(treeCacheKey(settings.rootId || tree.root.id), JSON.stringify({
      savedAt: Date.now(),
      root: tree.root,
      folders: tree.folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, driveId: f.driveId || null })),
      files: tree.files.map((f) => ({
        id: f.id, name: f.name, size: f.size || 0,
        createdTime: f.createdTime, modifiedTime: f.modifiedTime,
        parentId: f.parentId, driveId: f.driveId || null,
      })),
    }));
  } catch {}
}

function loadTreeCache(rootId) {
  const want = rootId || settings.rootId;
  try {
    if (want) {
      const raw = localStorage.getItem(treeCacheKey(want));
      const data = raw ? JSON.parse(raw) : null;
      return data?.root?.id && Array.isArray(data.files) ? data : null;
    }
    const best = newestCache('niji.tree.');
    return best?.root?.id && Array.isArray(best.files) ? best : null;
  } catch { return null; }
}

function saveMetaCache(data) {
  if (!data) return;
  try {
    localStorage.setItem(metaCacheKey(settings.rootId), JSON.stringify({ savedAt: Date.now(), data }));
  } catch {}
}

function loadMetaCache(rootId) {
  const want = rootId || settings.rootId;
  try {
    if (want) {
      const raw = localStorage.getItem(metaCacheKey(want));
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed?.data ? parsed : null;
    }
    return newestCache('niji.meta.');
  } catch { return null; }
}

function newestCache(prefix) {
  let best = null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      let value = null;
      try { value = JSON.parse(localStorage.getItem(key)); } catch { continue; }
      if (!value) continue;
      if (!best || (value.savedAt || 0) > (best.savedAt || 0)) best = value;
    }
  } catch {}
  return best;
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ─────────────────────────── state ─────────────────────────── */
const DEFAULT_CLIENT_ID = '933433222359-8deoeh6c8mva4sbl9bv90gunkbe600lo.apps.googleusercontent.com';
const settings = Object.assign({ clientId: DEFAULT_CLIENT_ID, rootId: '' }, loadJSON(SETTINGS_KEY, {}));
if (!settings.clientId) settings.clientId = DEFAULT_CLIENT_ID;
const personal = Object.assign(
  { nickname: '게스트', favorites: {}, playlists: [], notesSeenAt: 0, lastFileId: null, lastLiver: null },
  loadJSON(PERSONAL_KEY, {})
);

const state = {
  mode: 'demo',
  loading: false,
  rootId: 'demo-root',
  files: [],
  folders: [],
  folderMap: new Map(),
  view: 'all',
  search: '',
  sort: 'recent',
  filters: { year: new Set(), liver: new Set(), tag: new Set() },
  openFilters: new Set(),
  filterBarOpen: false,
  offlineOnly: false,
  folderMode: 'collection',
  collectionLiver: null,
  selectMode: false,
  selected: new Set(),
  folderId: null,
  openPlaylistId: null,
  lyricsQuery: '',
  indexRunning: false,
  indexCancel: false,
  liveError: '',
  fromCache: false,
  cachedAt: 0,
  syncing: false,
};

const drive = new Drive();
drive.setClientId(settings.clientId);

let shared = null;
const parsedCache = new Map();   // fileId -> {title, artist, album, year, lyrics, coverUrl, coverType}
const offlineIds = new Set();
let player = null;

/* demo metadata behaves like SharedMeta but stays in localStorage */
class LocalMeta {
  constructor(data) { this.data = data; }
  onChange() { return () => {}; }
  save() { saveJSON(DEMO_META_KEY, this.data); }
  tagsOf(id) { return this.data.tags[id] || []; }
  notesOf(id) { return (this.data.notes[id] || []).slice().sort((a, b) => (a.t ?? 0) - (b.t ?? 0)); }
  async addTags(ids, tag) {
    const t = String(tag || '').trim();
    if (!t) return;
    for (const id of ids) {
      const set = new Set(this.data.tags[id] || []);
      set.add(t);
      this.data.tags[id] = [...set];
    }
    this.save();
  }
  async removeTag(id, tag) {
    this.data.tags[id] = (this.data.tags[id] || []).filter((x) => x !== tag);
    if (!this.data.tags[id].length) delete this.data.tags[id];
    this.save();
  }
  async addNote(fileId, n) {
    const note = {
      id: 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      author: n.author || '익명',
      text: n.text,
      t: n.t ?? null,
      createdAt: new Date().toISOString(),
    };
    this.data.notes[fileId] = [...(this.data.notes[fileId] || []), note];
    this.save();
    return note;
  }
  async removeNote(fileId, id) {
    this.data.notes[fileId] = (this.data.notes[fileId] || []).filter((n) => n.id !== id);
    if (!this.data.notes[fileId].length) delete this.data.notes[fileId];
    this.save();
  }
  setDuration(id, s) {
    const v = Math.round(s);
    if (!v || this.data.durations[id] === v) return;
    this.data.durations[id] = v;
    this.save();
  }
  setTranscript(id, t) {
    this.data.transcripts[id] = { ...t, source: 'manual', updatedAt: new Date().toISOString() };
    this.save();
  }
  allNotes() {
    const out = [];
    for (const [fileId, notes] of Object.entries(this.data.notes)) for (const n of notes) out.push({ ...n, fileId });
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
}

/* ─────────────────────────── data loading ─────────────────────────── */
function enrich(tree) {
  state.rootId = tree.root.id;
  state.folders = tree.folders;
  state.files = tree.files;
  state.folderMap = new Map(tree.folders.map((f) => [f.id, f]));
  if (!state.folderId) state.folderId = tree.root.id;

  const pathOf = (fid) => {
    const names = [];
    let cur = state.folderMap.get(fid);
    let guard = 0;
    while (cur && guard++ < 24) {
      names.unshift(cur.name);
      cur = state.folderMap.get(cur.parentId);
    }
    return names;
  };

  for (const f of state.files) {
    const path = pathOf(f.parentId);
    f.path = path;
    f.liver = (path[0] || '기타').replace(/^\d{1,2}[_\s\-]+/, '');
    const yearFolder = [...path].reverse().find((n) => /^(19|20)\d{2}/.test(n));
    f.year = yearFolder ? yearFolder.slice(0, 4) : '';
  }
}

function useDemo() {
  state.mode = 'demo';
  state.liveError = '';
  const saved = loadJSON(DEMO_META_KEY, null);
  shared = new LocalMeta(saved || demoMeta());
  enrich(DEMO_TREE);
  state.folderId = 'demo-root';
  for (const f of state.files) parsedCache.set(f.id, { ...demoParsed(f), demo: true });
  renderAll();
}

async function loadLive({ interactive = false, silent = false } = {}) {
  if (!settings.clientId) {
    if (!silent) toast('먼저 설정에서 OAuth Client ID를 입력해 주세요.', { err: true });
    return false;
  }
  if (!silent) { state.loading = true; renderHeader(); }
  try {
    drive.setClientId(settings.clientId);
    if (!drive.connected) {
      // keep the token request inside the tap so Safari doesn't block the popup
      if (interactive && drive.tokenClient) await drive.requestToken();
      else await drive.ensure({ interactive });
    }

    if (!settings.rootId) {
      const found = await drive.findFolderByName('NIJI VOICE');
      if (!found.length) throw new Error('드라이브에서 "NIJI VOICE" 폴더를 찾지 못했어요. 설정에서 폴더 ID를 직접 넣어 주세요.');
      let pick = null;
      if (found.length > 1) {
        try {
          const drives = await drive.listDrives();
          const target = drives.find((d) => /NIJISANJI/i.test(d.name || ''));
          pick = target ? found.find((f) => f.driveId === target.id) : null;
        } catch {}
      }
      pick = pick || found.find((f) => f.driveId) || found[0];
      settings.rootId = pick.id;
      saveJSON(SETTINGS_KEY, settings);
    }

    const tree = await drive.tree(settings.rootId, {
      skipFolder: skipFolderFilter,
      onProgress: silent ? undefined : ({ done }) => { setConnText(`불러오는 중… (${done}개 폴더)`); },
    });
    const meta = new SharedMeta(drive, settings.rootId);
    meta.onError = (e) => toast(`공유 메모 저장 실패: ${e?.message || e}`, { err: true, ms: 4000 });
    await meta.load();
    shared = meta;
    meta.onChange(() => saveMetaCache(meta.data));
    state.mode = 'live';
    state.liveError = '';
    enrich(tree);
    saveTreeCache(tree);
    saveMetaCache(meta.data);
    state.folderId = tree.root.id;
    for (const f of DEMO_TREE.files) parsedCache.delete(f.id);
    await refreshOfflineIds();
    await primeCache();
    renderAll();
    lastMetaRefresh = Date.now();
    if (!silent) toast(`${state.files.length}개 파일을 불러왔어요`);
    return true;
  } catch (e) {
    state.mode = state.files.length ? state.mode : 'demo';
    if (e instanceof NeedsAuth) {
      state.liveError = 'auth';
      if (interactive) showConnectError(e);
      else if (!silent) toast('Google 계정 연결이 필요해요.', { err: true });
    } else {
      state.liveError = e.message || 'Drive를 불러오지 못했어요.';
      if (interactive) showConnectError(e);
      else if (!silent) toast(state.liveError, { err: true });
    }
    renderHeader();
    return false;
  } finally {
    state.loading = false;
    renderHeader();
  }
}

/** Paint the last saved library before any network talk. */
function startFromCache(cached) {
  state.mode = 'live';
  state.liveError = '';
  state.fromCache = true;
  state.cachedAt = cached.savedAt || 0;
  const rootId = settings.rootId || cached.root?.id || '';
  if (!settings.rootId && cached.root?.id) {
    settings.rootId = cached.root.id;
    saveJSON(SETTINGS_KEY, settings);
  }
  const meta = new SharedMeta(drive, rootId);
  const cachedMeta = loadMetaCache(rootId);
  if (cachedMeta?.data) {
    meta.data = cachedMeta.data;
    meta.updatedAt = cachedMeta.savedAt || '';
  }
  meta.onError = (e) => toast(`공유 메모 저장 실패: ${e?.message || e}`, { err: true, ms: 4000 });
  meta.onChange(() => saveMetaCache(meta.data));
  shared = meta;
  enrich({ root: cached.root, folders: cached.folders || [], files: cached.files || [] });
  state.folderId = cached.root.id;
  renderAll();
}

/** Background sync: refresh list + shared meta without any loading UI. */
async function syncQuietly() {
  if (!settings.clientId || !settings.rootId) return;
  if (!drive.connected) return;
  if (state.syncing) return;
  state.syncing = true;
  const before = treeSignature();
  try {
    const tree = await drive.tree(settings.rootId, { skipFolder: skipFolderFilter });
    if (shared?.load) await shared.load();
    lastMetaRefresh = Date.now();
    enrich(tree);
    saveTreeCache(tree);
    saveMetaCache(shared?.data);
    state.fromCache = false;
    state.cachedAt = Date.now();
    if (before !== treeSignature()) renderAll();
    else { renderTabs(); renderList(); }
    renderHeader();
  } catch (e) {
    if (e instanceof NeedsAuth) state.liveError = 'auth';
    renderHeader();
  } finally {
    state.syncing = false;
  }
}

function treeSignature() {
  const s = state.folders.map((f) => `${f.id}:${f.name}`).join(',') + '#'
    + state.files.map((f) => `${f.id}:${f.name}:${f.modifiedTime || ''}:${f.parentId}`).join(',');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

/** Skip the untagged original-backup folder unless the user turns it back on. */
function skipFolderFilter(name) {
  if (settings.includeBackup) return false;
  return /^00[ _\-]/.test(name) || /원본\s*백업/.test(name);
}

async function refreshOfflineIds() {
  offlineIds.clear();
  try {
    const ks = await db.keys('audio');
    for (const k of ks) offlineIds.add(k);
  } catch {}
}

function setConnText(text) {
  const el = $('#connState');
  if (el) el.textContent = text;
}

/* ─────────────────────────── selection helpers ─────────────────────────── */
function fileById(id) { return state.files.find((f) => f.id === id) || null; }

function visibleFiles() {
  let list = state.files;
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((f) => f.name.toLowerCase().includes(q));
  const { year, liver, tag } = state.filters;
  if (year.size) list = list.filter((f) => f.year && year.has(f.year));
  if (liver.size) list = list.filter((f) => liver.has(f.liver));
  if (tag.size) list = list.filter((f) => { const ts = tagsOf(f); return [...tag].every((t) => ts.includes(t)); });
  if (state.offlineOnly) list = list.filter((f) => offlineIds.has(f.id));
  list = list.slice();
  if (state.sort === 'name') list.sort((a, b) => displayName(a.name).localeCompare(displayName(b.name), 'ko'));
  else list.sort((a, b) => String(b.createdTime || '').localeCompare(String(a.createdTime || '')));
  return list;
}

function isFav(id) { return !!personal.favorites[id]; }

function setFav(id, on) {
  if (on) personal.favorites[id] = true;
  else delete personal.favorites[id];
  saveJSON(PERSONAL_KEY, personal);
}

function isNewNote(n) {
  return n.author !== personal.nickname && new Date(n.createdAt).getTime() > (personal.notesSeenAt || 0);
}

function newNotesFor(id) {
  return shared.notesOf(id).filter(isNewNote).length;
}

function totalNewNotes() {
  return shared.allNotes().filter(isNewNote).length;
}

/* ─────────────────────────── rendering: chrome ─────────────────────────── */
function renderHeader() {
  const nickEl = $('#nickLabel');
  if (nickEl) nickEl.textContent = personal.nickname || '게스트';
  const conn = $('#connState');
  if (!conn) return;
  conn.className = 'conn';
  if (state.loading) {
    conn.textContent = '불러오는 중…';
    conn.title = 'Google Drive에서 목록을 불러오는 중';
  } else if (state.mode === 'live') {
    if (drive.connected) {
      conn.classList.add('is-live');
      conn.textContent = 'Google Drive 연결됨';
      conn.title = 'Google Drive 연결됨';
    } else {
      conn.classList.add('is-off');
      conn.textContent = '저장된 목록';
      conn.title = '저장해 둔 목록을 보는 중 — 눌러서 Google Drive에 연결';
    }
  } else if (settings.clientId) {
    conn.classList.add('is-off');
    conn.textContent = '데모 모드 · 연결';
    conn.title = '데모 모드 — 눌러서 Google Drive에 연결';
  } else {
    conn.textContent = '데모 모드';
    conn.title = '데모 모드 — 설정에서 Google Drive를 연결하세요';
  }
  const rb = $('#btnRefresh');
  if (rb) rb.classList.toggle('is-busy', state.loading);
}

function renderTabs() {
  for (const b of $$('#viewTabs .tab')) {
    const on = b.dataset.view === state.view;
    b.classList.toggle('is-on', on);
    if (b.dataset.view === 'notes') {
      const n = totalNewNotes();
      b.textContent = n ? `메모 ${n}` : '메모';
      b.classList.toggle('has-new', n > 0);
    }
  }
}

function renderFilters() {
  const years = [...new Set(state.files.map((f) => f.year).filter(Boolean))].sort().reverse();
  const livers = [...new Set(state.files.map((f) => f.liver))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  const tagCount = new Map();
  for (const f of state.files) for (const t of tagsOf(f)) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));

  const opt = (key, val, label, n) =>
    `<button type="button" class="fchip-opt ${state.filters[key].has(val) ? 'is-on' : ''}" data-fopt="${key}" data-val="${esc(val)}">${label}<span class="n">${n}</span></button>`;

  $('#fpYear').innerHTML = years.map((y) => opt('year', y, esc(y), state.files.filter((f) => f.year === y).length)).join('')
    || '<span class="note">연도 폴더가 없어요.</span>';
  $('#fpLiver').innerHTML = livers.map((l) => opt('liver', l, esc(l), state.files.filter((f) => f.liver === l).length)).join('')
    || '<span class="note">라이버 폴더가 없어요.</span>';
  $('#fpTag').innerHTML = tags.slice(0, 60).map(([t, n]) => opt('tag', t, `#${esc(t)}`, n)).join('')
    || '<span class="note">아직 태그가 없어요. 파일 카드의 “태그”로 추가해 보세요.</span>';

  for (const key of ['year', 'liver', 'tag']) {
    const chip = $(`#filters .fchip[data-open="${key}"]`);
    const pane = $(`#fp${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    const open = state.openFilters.has(key);
    if (chip) {
      chip.classList.toggle('is-open', open);
      chip.classList.toggle('is-on', state.filters[key].size > 0);
      const badge = $('.fcount', chip);
      const n = state.filters[key].size;
      if (badge) { badge.hidden = !n; badge.textContent = n ? String(n) : ''; }
    }
    if (pane) pane.classList.toggle('is-open', open);
  }

  const total = state.filters.year.size + state.filters.liver.size + state.filters.tag.size;
  $('#btnClearFilters').hidden = !total;
  $('#btnClearFilters').textContent = total ? `필터 초기화 (${total}) ✕` : '필터 초기화 ✕';

  const filtersEl = $('#filters');
  if (filtersEl) filtersEl.classList.toggle('is-open', !!state.filterBarOpen);
  const ft = $('#btnFilterToggle');
  if (ft) ft.classList.toggle('is-on', total > 0);
  const fc = $('#filterCount');
  if (fc) { fc.hidden = !total; fc.textContent = total ? String(total) : ''; }
}

function renderControlbar() {
  const play = $('#btnPlayAll');
  if (play) play.querySelector('span').textContent = (state.view === 'folders' && state.folderMode === 'tree') ? '이 폴더 재생' : '전체 재생';
  const off = $('#btnOffline');
  if (off) off.classList.toggle('is-on', !!state.offlineOnly);
  const sh = $('#btnShuffleAll');
  if (sh) sh.classList.toggle('is-on', !!player?.shuffle);
}

function renderAll() {
  renderHeader();
  renderTabs();
  renderFilters();
  renderControlbar();
  const fileViews = ['all', 'fav', 'folders'];
  $('#filters').hidden = !fileViews.includes(state.view);
  $('.controlbar').hidden = !fileViews.includes(state.view);
  renderList();
  renderSelectionBar();
}

/* ─────────────────────────── rendering: list ─────────────────────────── */
function cardHTML(f, { playlist = false } = {}) {
  const playing = player?.current?.id === f.id;
  const selected = state.selected.has(f.id);
  const tags = tagsOf(f);
  const notes = shared.notesOf(f.id).length;
  const newN = newNotesFor(f.id);
  const parsed = parsedCache.get(f.id);
  const hasLyrics = !!parsed?.lyrics?.length;
  const saved = offlineIds.has(f.id);
  const cover = parsed?.coverUrl || '';

  const meta = [];
  const liverShort = (f.liver || '').replace(/\s*\([^)]*\)\s*$/, '');
  if (liverShort) meta.push(`<span>${esc(liverShort)}</span>`);
  const albumName = parsed?.album || '';
  if (albumName) meta.push(`<span>${esc(albumName)}</span>`);
  else if (f.year) meta.push(`<span>${esc(f.year)}</span>`);
  if (tags.length) meta.push(`<span class="tg">${esc(tags.slice(0, 2).map((t) => '#' + t).join(' '))}</span>`);

  const status = [];
  if (notes) status.push(`<span class="st"><svg><use href="#i-memo"/></svg>${notes}</span>`);
  if (hasLyrics) status.push('<span class="st"><svg><use href="#i-lyrics"/></svg></span>');
  if (saved) status.push('<span class="st is-on"><svg><use href="#i-check"/></svg></span>');
  if (newN) status.push(`<span class="newbadge">NEW ${newN}</span>`);

  return `
  <article class="card ${playing ? 'is-playing' : ''} ${selected ? 'is-selected' : ''} ${state.selectMode ? 'is-selecting' : ''}" data-id="${esc(f.id)}">
    ${state.selectMode ? `<span class="card-sel">${selected ? '<svg><use href="#i-check"/></svg>' : ''}</span>` : ''}
    <span class="cov" data-cover="${esc(f.id)}"${cover ? ' data-painted="1"' : ''}>${cover ? `<img src="${cover}" alt="" loading="lazy" />` : '<svg><use href="#i-mic"/></svg>'}</span>
    <div class="card-body" data-act="open">
      <div class="card-title">${esc(displayName(f.name))}</div>
      <div class="card-sub">
        <span class="sub-meta">${meta.join('<i class="dot"></i>')}</span>
        ${status.length ? `<span class="sub-status">${status.join('')}</span>` : ''}
      </div>
    </div>
    <div class="card-side">
      <button class="star ${isFav(f.id) ? 'is-on' : ''}" data-act="fav" aria-label="즐겨찾기">
        <svg><use href="${isFav(f.id) ? '#i-star-fill' : '#i-star'}"/></svg>
      </button>
      <button class="cbtn-play" data-act="play" aria-label="재생">
        <svg><use href="${playing && player?.isPlaying ? '#i-pause' : '#i-play'}"/></svg>
      </button>
      <button class="morebtn" data-act="more" aria-label="더보기">
        <svg><use href="#i-more"/></svg>
      </button>
    </div>
  </article>`;
}

function filterSummary() {
  const bits = [];
  if (state.filters.tag.size) bits.push([...state.filters.tag].map((t) => `#${t}`).join(' '));
  if (state.filters.liver.size) bits.push([...state.filters.liver][0]);
  if (state.filters.year.size) bits.push([...state.filters.year].join('·'));
  if (state.offlineOnly) bits.push('오프라인');
  if (state.search.trim()) bits.push(`“${state.search.trim()}”`);
  return bits.join(' · ');
}

function listHead(text, extra = '') {
  return `<div class="listhead"><span>${text}</span>${extra}</div>`;
}

function emptyHTML({ icon = '🎧', title, desc, actions = '' }) {
  return `<div class="empty"><div class="em-ico">${icon}</div><h3>${esc(title)}</h3><p>${desc}</p>${actions ? `<div class="em-act">${actions}</div>` : ''}</div>`;
}

function renderList() {
  const area = $('#listArea');
  const foot = $('#listFoot');
  foot.innerHTML = '';

  if (state.view === 'playlists') return renderPlaylists();
  if (state.view === 'folders') return renderFolders();
  if (state.view === 'notes') return renderNotes();
  if (state.view === 'lyrics') return renderLyricsView();

  let files;
  if (state.view === 'fav') {
    files = visibleFiles().filter((f) => isFav(f.id));
    if (!files.length) {
      area.innerHTML = emptyHTML({
        icon: '⭐', title: '즐겨찾기가 비어 있어요',
        desc: '파일 카드의 별을 눌러 두면 여기에 모여요.',
      });
      return;
    }
  } else {
    files = visibleFiles();
    if (!files.length) {
      if (!state.files.length) {
        area.innerHTML = state.mode === 'live'
          ? emptyHTML({
            icon: '📂', title: '이 폴더에는 오디오 파일이 없어요',
            desc: '연결된 폴더에 mp3 파일이 있는지 확인해 주세요.<br>폴더 ID가 다르면 설정에서 바꿀 수 있어요.',
            actions: '<button class="btn-line primary" data-act="connect">폴더 설정 열기</button>',
          })
          : emptyHTML({
            icon: '🔌', title: 'Google 드라이브를 연결해 주세요',
            desc: '지금은 데모 모드예요. 설정에서 OAuth Client ID를 넣고 연결하면<br>NIJISANJI 공유 드라이브의 NIJI VOICE 폴더를 불러옵니다.',
            actions: `<button class="btn-line primary" data-act="connect">Google 계정 연결</button>
                      <button class="btn-line" data-act="demo">데모 보기</button>`,
          });
      } else {
        area.innerHTML = emptyHTML({
          icon: '🔍', title: '조건에 맞는 파일이 없어요',
          desc: '검색어나 필터를 바꿔 보세요.',
          actions: `<button class="btn-line" data-act="reset-search">검색·필터 초기화</button>`,
        });
      }
      return;
    }
  }

  const sortLabel = state.sort === 'name' ? '이름순' : '최신순';
  const summary = filterSummary();
  area.innerHTML = listHead(
    `${files.length}개 파일${summary ? ` · ${esc(summary)}` : ''} · ${sortLabel}`,
    `<button type="button" class="mini" data-act="select-mode">${state.selectMode ? '선택 해제' : '선택'}</button>`
  ) + files.map((f) => cardHTML(f)).join('');
  foot.textContent = state.mode === 'demo' ? '데모 모드 — 실제 드라이브는 설정에서 연결할 수 있어요.' : '';
}

function renderPlaylists() {
  const area = $('#listArea');
  if (state.openPlaylistId) {
    const pl = personal.playlists.find((p) => p.id === state.openPlaylistId);
    if (!pl) { state.openPlaylistId = null; return renderPlaylists(); }
    const files = pl.fileIds.map(fileById).filter(Boolean);
    area.innerHTML = `
      <div class="listhead">
        <button class="mini" data-act="pl-back">‹ 재생목록</button>
        <span>${esc(pl.name)} · ${files.length}개</span>
      </div>
      ${files.length ? files.map((f) => cardHTML(f, { playlist: true })).join('')
        : emptyHTML({ icon: '🎵', title: '아직 곡이 없어요', desc: '곡의 ⋯ 메뉴에서 재생목록에 추가할 수 있어요.' })}
      <div class="btnrow" style="margin:16px 4px 0">
        <button class="btn-secondary" data-act="pl-play">전체 재생</button>
        <button class="btn-secondary btn-danger" data-act="pl-delete">재생목록 삭제</button>
      </div>`;
    $('#listFoot').textContent = '';
    return;
  }

  const rows = personal.playlists.map((p) => `
    <button class="pl-row" data-act="pl-open" data-id="${esc(p.id)}">
      <span class="pl-ico"><svg><use href="#i-list"/></svg></span>
      <span class="pl-name">${esc(p.name)}</span>
      <span class="pl-count">${p.fileIds.length}곡</span>
      <svg style="width:16px;height:16px;color:var(--muted)"><use href="#i-chevron"/></svg>
    </button>`).join('');

  area.innerHTML = `
    <div class="listhead"><span>내 재생목록 ${personal.playlists.length}개</span></div>
    ${rows || emptyHTML({ icon: '🎵', title: '재생목록이 없어요', desc: '원하는 곡만 모아 두고 한 번에 들을 수 있어요.' })}
    <div style="padding:12px 4px"><button class="btn-secondary" data-act="pl-new">+ 새 재생목록</button></div>`;
}

function folderModeBar(mode, count = null) {
  const n = count == null ? state.files.length : count;
  return `<div class="colhead">
    <div class="seg">
      <button type="button" class="${mode !== 'tree' ? 'is-on' : ''}" data-act="folder-mode" data-mode="collection">컬렉션</button>
      <button type="button" class="${mode === 'tree' ? 'is-on' : ''}" data-act="folder-mode" data-mode="tree">폴더</button>
    </div>
    <span class="colcount">${n}개</span>
  </div>`;
}

function tileHTML(f) {
  const parsed = parsedCache.get(f.id);
  const cover = parsed?.coverUrl || '';
  const playing = player?.current?.id === f.id;
  const title = parsed?.title || displayName(f.name);
  return `<button type="button" class="tile ${playing ? 'is-playing' : ''}" data-act="tile" data-id="${esc(f.id)}">
    <span class="tile-cov">
      <span class="cov-box" data-cover="${esc(f.id)}"${cover ? ' data-painted="1"' : ''}>${cover ? `<img src="${cover}" alt="" loading="lazy" />` : ''}</span>
      <span class="tile-play"><svg><use href="${playing && player?.isPlaying ? '#i-pause' : '#i-play'}"/></svg></span>
    </span>
    <span class="tile-name">${esc(title)}</span>
  </button>`;
}

/* ── lazy ID3 covers (range request, IndexedDB cached) ── */
const coverPending = new Set();
const coverQueue = [];
let coverActive = 0;
let coverIO = null;
let coverMO = null;
let coverScanTimer = 0;

function watchCovers() {
  const area = $('#listArea');
  if (!area) return;
  if (!coverMO) {
    coverMO = new MutationObserver(() => {
      clearTimeout(coverScanTimer);
      coverScanTimer = setTimeout(scanCovers, 80);
    });
    coverMO.observe(area, { childList: true, subtree: true });
  }
  clearTimeout(coverScanTimer);
  coverScanTimer = setTimeout(scanCovers, 60);
}

function scanCovers() {
  const targets = $$('#listArea [data-cover]:not([data-painted])');
  if (!targets.length) return;
  if (state.mode !== 'live' || !drive.connected) return;
  if (!('IntersectionObserver' in window)) {
    for (const el of targets.slice(0, 8)) queueCover(el.dataset.cover);
    return;
  }
  if (coverIO) coverIO.disconnect();
  coverIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      coverIO.unobserve(en.target);
      queueCover(en.target.dataset.cover);
    }
  }, { root: $('#scroller'), rootMargin: '260px 0px' });
  for (const el of targets) coverIO.observe(el);
}

function queueCover(fileId) {
  if (!fileId || state.mode !== 'live' || !drive.connected) return;
  const cached = parsedCache.get(fileId);
  if (cached?.coverUrl) { paintCover(fileId, cached.coverUrl); return; }
  if (cachedEmpty.has(fileId)) return;
  if (coverPending.has(fileId) || coverQueue.includes(fileId)) return;
  coverQueue.push(fileId);
  pumpCovers();
}

function pumpCovers() {
  while (coverActive < 3 && coverQueue.length) {
    const id = coverQueue.shift();
    const file = fileById(id);
    if (!file) continue;
    const cached = parsedCache.get(id);
    if (cached?.coverUrl) { paintCover(id, cached.coverUrl); continue; }
    coverActive += 1;
    coverPending.add(id);
    loadParsed(file)
      .then((p) => { if (p?.coverUrl) paintCover(id, p.coverUrl); })
      .catch(() => {})
      .finally(() => {
        coverActive -= 1;
        coverPending.delete(id);
        pumpCovers();
      });
  }
}

function paintCover(fileId, url) {
  if (!url) return;
  let els = [];
  try { els = $$(`#listArea [data-cover="${CSS.escape(fileId)}"]`); } catch { return; }
  for (const el of els) {
    if (el.dataset.painted === '1' && el.querySelector('img')) continue;
    el.dataset.painted = '1';
    el.innerHTML = `<img src="${url}" alt="" loading="lazy" />`;
  }
}

function collectLivers() {
  const map = new Map();
  for (const f of visibleFiles()) {
    const liver = f.liver || '기타';
    map.set(liver, (map.get(liver) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko', { numeric: true }));
}

function currentLiver(livers) {
  const wanted = state.collectionLiver || personal.lastLiver || '';
  if (wanted && livers.some(([l]) => l === wanted)) return wanted;
  return livers.length ? livers[0][0] : '';
}

function liverInitial(name) {
  const m = String(name || '').match(/[가-힣A-Za-zぁ-んァ-ヶ一-龠0-9]/);
  return m ? m[0] : '♪';
}

function liverTone(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `background:hsl(${hue} 55% 95%);color:hsl(${hue} 42% 40%)`;
}

function renderCollection() {
  const area = $('#listArea');
  const all = visibleFiles();
  if (!all.length) {
    area.innerHTML = folderModeBar('collection', 0) + (state.files.length
      ? emptyHTML({ icon: '🔍', title: '조건에 맞는 곡이 없어요', desc: '검색어나 필터를 바꿔 보세요.', actions: '<button class="btn-line" data-act="reset-search">검색·필터 초기화</button>' })
      : emptyHTML({ icon: '📂', title: '아직 보이스가 없어요', desc: '드라이브를 연결하면 라이버·연도별로 모아 보여드려요.' }));
    return;
  }

  const livers = collectLivers();
  const liver = currentLiver(livers);
  state.collectionLiver = liver;
  const files = all.filter((f) => (f.liver || '기타') === liver);

  const hero = `
    <button type="button" class="lib-card" data-act="pick-liver">
      <span class="lib-avatar" style="${liverTone(liver)}">${esc(liverInitial(liver))}</span>
      <span class="lib-meta">
        <span class="lib-name">${esc(liver)}</span>
        <span class="lib-sub">보이스 ${files.length}개 · 라이버 ${livers.length}명</span>
      </span>
      <span class="lib-change">라이버 변경</span>
    </button>`;

  const years = new Map();
  for (const f of files) {
    const y = f.year || '기타';
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(f);
  }
  const yearKeys = [...years.keys()].sort((a, b) => String(b).localeCompare(String(a), 'ko', { numeric: true }));
  const sections = yearKeys.map((year) => {
    const list = years.get(year).slice().sort((a, b) => displayName(a.name).localeCompare(displayName(b.name), 'ko', { numeric: true }));
    return `<div class="col-year">${esc(year)}<span>${list.length}</span></div>
      <div class="col-grid">${list.map(tileHTML).join('')}</div>`;
  }).join('');

  area.innerHTML = folderModeBar('collection', files.length) + hero + sections;
  $('#listFoot').textContent = '';
}

function openLiverSheet() {
  const livers = collectLivers();
  const cur = currentLiver(livers);
  ui.sheet = 'liver';
  const body = openSheet('라이버 선택', `
    <div class="liverlist">
      ${livers.map(([name, n]) => `
        <button type="button" class="liver-row ${name === cur ? 'is-on' : ''}" data-act="choose-liver" data-liver="${esc(name)}">
          <span class="lib-avatar sm" style="${liverTone(name)}">${esc(liverInitial(name))}</span>
          <span class="liver-name">${esc(name)}</span>
          <span class="liver-count">${n}</span>
          <span class="liver-check">${name === cur ? '<svg><use href="#i-check"/></svg>' : ''}</span>
        </button>`).join('')}
    </div>
  `, { tall: true });
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="choose-liver"]');
    if (!b) return;
    state.collectionLiver = b.dataset.liver;
    personal.lastLiver = state.collectionLiver;
    saveJSON(PERSONAL_KEY, personal);
    state.folderMode = 'collection';
    closeSheet();
    renderList();
    const sc = $('#scroller');
    if (sc) sc.scrollTo({ top: 0 });
  });
}

function renderFolders() {
  if (state.folderMode !== 'tree') return renderCollection();
  const area = $('#listArea');
  const folderId = state.folderId || state.rootId;
  const crumbs = [];
  let cur = state.folderMap.get(folderId);
  let guard = 0;
  while (cur && guard++ < 24) { crumbs.unshift(cur); cur = state.folderMap.get(cur.parentId); }

  const subFolders = state.folders.filter((f) => f.parentId === folderId);
  const files = state.files
    .filter((f) => f.parentId === folderId)
    .sort((a, b) => displayName(a.name).localeCompare(displayName(b.name), 'ko', { numeric: true }));

  const crumbHTML = `
    <div class="crumbs">
      <button data-act="go-root">NIJI VOICE</button>
      ${crumbs.map((c) => `<span class="sep">›</span><button data-act="go-folder" data-id="${esc(c.id)}">${esc(c.name)}</button>`).join('')}
    </div>`;

  const folderHTML = subFolders.map((f) => {
    const n = state.files.filter((x) => x.parentId === f.id).length;
    const subs = state.folders.filter((x) => x.parentId === f.id).length;
    return `<button class="folder-card" data-act="go-folder" data-id="${esc(f.id)}">
      <span class="folder-ico"><svg><use href="#i-folder"/></svg></span>
      <span class="folder-name">${esc(f.name)}</span>
      <span class="folder-meta">${n ? n + '곡' : ''}${subs ? (n ? ' · ' : '') + subs + '폴더' : ''}</span>
      <svg style="width:16px;height:16px;color:var(--muted)"><use href="#i-chevron"/></svg>
    </button>`;
  }).join('');

  area.innerHTML = folderModeBar('tree') + crumbHTML + folderHTML + (files.length ? files.map((f) => cardHTML(f)).join('') : '')
    + (!subFolders.length && !files.length ? emptyHTML({ icon: '📂', title: '빈 폴더예요', desc: '여기에는 아직 오디오 파일이 없어요.' }) : '');
  $('#listFoot').textContent = files.length ? `${files.length}개 파일` : '';
}

function renderNotes() {
  const area = $('#listArea');
  const rows = shared.allNotes().map((n) => ({ ...n, file: fileById(n.fileId) })).filter((n) => n.file || n.fileId);
  const newN = rows.filter(isNewNote).length;

  const head = `<div class="listhead">
      <span>메모 <b>${rows.length}</b>개${newN ? ` · 새 메모 <b>${newN}</b>개` : ''}</span>
      ${newN ? '<button class="mini has-content" data-act="mark-seen">모두 읽음</button>' : ''}
    </div>`;

  if (!rows.length) {
    area.innerHTML = head + emptyHTML({ icon: '💬', title: '아직 메모가 없어요', desc: '재생 중 원하는 지점에서 메모를 남기면<br>타임스탬프와 함께 여기에 모여요.' });
    return;
  }

  area.innerHTML = head + rows.map((n) => `
    <button class="memo-card ${isNewNote(n) ? 'is-new' : ''}" data-act="memo-jump" data-id="${esc(n.fileId)}" data-t="${n.t ?? ''}">
      <div class="memo-file">${esc(displayName(n.file?.name || n.fileId))}</div>
      <div class="memo">
        <span class="memo-time">${n.t != null ? fmtTime(n.t) : '전체'}</span>
        <span class="memo-body">
          <span class="memo-text">${esc(n.text)}</span>
          <span class="memo-meta">${esc(n.author)} · ${esc(fmtDate(n.createdAt))} ${isNewNote(n) ? '<span class="newbadge">NEW</span>' : ''}</span>
        </span>
      </div>
    </button>`).join('');
}

/* ── lyrics search view ── */
async function renderLyricsView() {
  const area = $('#listArea');
  const total = state.files.length;
  const indexed = indexCount();
  area.innerHTML = `
    <div class="indexbar">
      <span>가사 인덱스 <b>${indexed}</b>/${total}</span>
      <span class="bar"><i style="width:${total ? Math.round((indexed / total) * 100) : 0}%"></i></span>
      <button class="mini ${indexed < total ? 'has-content' : ''}" data-act="index-run">${state.indexRunning ? '중지' : '만들기'}</button>
    </div>
    <div class="lyrics-search">
      <input id="lyricsInput" type="search" placeholder="가사 키워드 검색 (일본어 / 한국어)" value="${esc(state.lyricsQuery)}" enterkeyhint="search" />
    </div>
    <div id="lyricsHits"></div>`;
  const input = $('#lyricsInput');
  input.addEventListener('input', debounce((e) => {
    state.lyricsQuery = e.target.value;
    runLyricsSearch();
  }, 220));
  runLyricsSearch();
}

async function runLyricsSearch() {
  const host = $('#lyricsHits');
  if (!host) return;
  const q = state.lyricsQuery.trim().toLowerCase();
  if (!q) {
    host.innerHTML = emptyHTML({
      icon: '🔎', title: '가사로 찾아보세요',
      desc: 'MP3에 심어 둔 자막(일본어 원문·한국어 해석)에서 키워드를 찾고,<br>결과를 누르면 그 대사 지점부터 바로 재생해요.<br><span style="opacity:.8">“만들기”를 누르면 전체 파일의 자막을 한 번에 인덱싱합니다.</span>',
    });
    return;
  }

  const hits = [];
  for (const [fileId, p] of parsedCache) {
    const file = fileById(fileId);
    const lines = p.lyrics || [];
    for (const line of lines) {
      if ((line.orig || '').toLowerCase().includes(q) || (line.trans || '').toLowerCase().includes(q)) {
        hits.push({ fileId, file, time: line.time, orig: line.orig, trans: line.trans });
      }
    }
  }
  // subtitle transcripts kept with the shared metadata
  for (const [fileId, t] of Object.entries(shared.data.transcripts || {})) {
    const text = `${t.original || ''}\n${t.translated || ''}`;
    if (text.toLowerCase().includes(q)) {
      const idx = text.toLowerCase().indexOf(q);
      hits.push({
        fileId, file: fileById(fileId), time: null,
        orig: t.original?.slice(Math.max(0, idx - 30), idx + 50) || '',
        trans: t.translated?.slice(Math.max(0, idx - 30), idx + 50) || '',
      });
    }
  }

  if (!hits.length) {
    host.innerHTML = emptyHTML({
      icon: '🔍', title: '일치하는 가사가 없어요',
      desc: parsedCache.size ? '다른 키워드로 찾아보세요.' : '아직 인덱싱된 가사가 없어요. 위의 “만들기”를 눌러 주세요.',
    });
    return;
  }

  hits.sort((a, b) => (a.file?.name || '').localeCompare(b.file?.name || '') || (a.time ?? 0) - (b.time ?? 0));
  host.innerHTML = `<div class="listhead"><span>${hits.length}개 대사</span></div>` + hits.slice(0, 300).map((h) => `
    <button class="hit" data-act="lyric-hit" data-id="${esc(h.fileId)}" data-t="${h.time ?? ''}">
      <span class="memo-time">${h.time != null ? fmtTime(h.time) : '전체'}</span>
      <span class="hit-line">
        <span class="hit-orig">${highlight(h.orig, q)}</span>
        ${h.trans ? `<span class="hit-trans">${highlight(h.trans, q)}</span>` : ''}
        <span class="hit-file">${esc(displayName(h.file?.name || h.fileId))}</span>
      </span>
    </button>`).join('');
}

function highlight(text, q) {
  const s = esc(text || '');
  if (!q) return s;
  const idx = s.toLowerCase().indexOf(esc(q).toLowerCase());
  if (idx < 0) return s;
  return s.slice(0, idx) + '<mark>' + s.slice(idx, idx + q.length) + '</mark>' + s.slice(idx + q.length);
}

/* ─────────────────────────── selection bar ─────────────────────────── */
function renderSelectionBar() {
  const bar = $('#selBar');
  const n = state.selected.size;
  bar.hidden = !state.selectMode;
  $('#selCount').textContent = `${n}개 선택`;
  $$('#selBar [data-sel]').forEach((b) => { b.disabled = n === 0 && b.dataset.sel !== 'cancel'; });
}

/* ─────────────────────────── parsed ID3 & audio ─────────────────────────── */
function hydrate(rec) {
  if (!rec) return null;
  const cached = parsedCache.get(rec.fileId);
  if (cached) return cached;
  const out = {
    title: rec.title || '',
    artist: rec.artist || '',
    album: rec.album || '',
    year: rec.year || '',
    lyrics: rec.lyrics || [],
    plainLyrics: rec.plainLyrics || '',
    coverType: rec.coverType || 'image/jpeg',
    coverUrl: rec.coverBlob ? URL.createObjectURL(rec.coverBlob) : null,
  };
  parsedCache.set(rec.fileId, out);
  return out;
}

async function loadParsed(file, { network = true } = {}) {
  if (!file) return null;
  if (file.demo) {
    const p = demoParsed(file);
    parsedCache.set(file.id, p);
    return p;
  }
  if (parsedCache.has(file.id)) return parsedCache.get(file.id);

  let rec = null;
  try { rec = await db.get('parsed', file.id); } catch {}
  if (rec) {
    if (rec.empty) { cachedEmpty.add(file.id); return null; }
    return hydrate(rec);
  }
  if (!network) return null;

  const buf = await drive.readId3(file.id);
  const tag = buf ? parseId3(buf) : null;
  if (!tag) {
    await db.put('parsed', file.id, { fileId: file.id, empty: true, parsedAt: Date.now() }).catch(() => {});
    return null;
  }
  const coverBlob = tag.cover ? new Blob([tag.cover.bytes], { type: tag.cover.mime || 'image/jpeg' }) : null;
  const newRec = {
    fileId: file.id,
    title: tag.title || '',
    artist: tag.artist || '',
    album: tag.album || '',
    year: tag.year || '',
    lyrics: tag.lyrics || [],
    plainLyrics: tag.plainLyrics || '',
    coverBlob,
    coverType: tag.cover?.mime || 'image/jpeg',
    tagSize: tag.tagSize || 0,
    parsedAt: Date.now(),
  };
  await db.put('parsed', file.id, newRec).catch(() => {});
  return hydrate(newRec);
}

async function primeCache() {
    try {
      const rows = await db.all('parsed');
      for (const r of rows) {
        if (!r?.fileId) continue;
        if (r.empty) cachedEmpty.add(r.fileId);
        else if (!parsedCache.has(r.fileId)) hydrate(r);
      }
    } catch {}
  }

function indexCount() { return parsedCache.size + cachedEmpty.size; }

const cachedEmpty = new Set();

async function resolveTrack(file) {
  if (file.demo) {
    return { url: demoAudioUrl(file), parsed: demoParsed(file) };
  }
  const saved = await db.get('audio', file.id).catch(() => null);
  const parsed = await loadParsed(file, { network: !saved }).catch(() => null);

  if (saved?.blob) {
    return { url: URL.createObjectURL(saved.blob), parsed: parsed || {} };
  }

  const t = toastProgress(`불러오는 중…`);
  try {
    const buf = await drive.download(file.id, { onProgress: t.update });
    t.done();
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    return { url: URL.createObjectURL(blob), parsed: parsed || {} };
  } catch (e) {
    t.done();
    throw e;
  }
}

function toastProgress(label) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = `${label} 0%`;
  host.appendChild(el);
  let finished = false;
  return {
    update: ({ received, total }) => {
      if (finished) return;
      const pct = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
      el.textContent = `${label} ${pct}%`;
    },
    done: () => {
      finished = true;
      el.remove();
    },
  };
}

/* ─────────────────────────── playback ─────────────────────────── */
function initPlayer() {
  player = new Player($('#audio'), {
    resolve: resolveTrack,
    onState: updatePlayerUI,
    onError: (e) => toast(e?.message || '재생 중 문제가 생겼어요.', { err: true }),
  });

  const saved = personal.lastFileId ? fileById(personal.lastFileId) : null;
  if (saved) player.current = saved;
  updatePlayerUI({
    current: player.current, isPlaying: false, currentTime: 0, duration: 0,
    ab: player.ab, sleep: player.sleep, shuffle: player.shuffle, queueLength: 0, loading: false,
  });
}

function playFile(file, { list = null, startAt = 0 } = {}) {
  if (!file) return;
  player.unlock();
  const queue = list && list.length ? list : visibleFiles().length ? visibleFiles() : [file];
  let idx = queue.findIndex((f) => f.id === file.id);
  if (idx < 0) { queue.unshift(file); idx = 0; }
  personal.lastFileId = file.id;
  saveJSON(PERSONAL_KEY, personal);
  player.playFiles(queue, idx, { startAt });
}

function updatePlayerUI(st) {
  const bar = $('#playerBar');
  const cur = st.current;
  if (bar) bar.classList.toggle('is-empty', !cur);

  if (!cur) {
    const t = $('#pTitle');
    if (t) t.textContent = '재생 중인 곡 없음';
    const s = $('#pSub');
    if (s) s.textContent = '전체 재생을 눌러 시작해 보세요';
    const th = $('#pThumb');
    if (th) th.innerHTML = '<svg><use href="#i-mic"/></svg>';
    setSeek(0, 0, true);
  } else {
    const p = parsedCache.get(cur.id) || (cur.demo ? demoParsed(cur) : null) || {};
    const title = $('#pTitle');
    if (title) title.textContent = p.title || displayName(cur.name);
    const bits = [];
    if (p.artist) bits.push(p.artist);
    if (st.queueLength > 1) bits.push(`${player.queue.findIndex((f) => f.id === cur.id) + 1}/${st.queueLength}`);
    const sub = $('#pSub');
    if (sub) sub.textContent = bits.join(' · ') || cur.liver || '';
    const thumb = $('#pThumb');
    if (thumb) thumb.innerHTML = p.coverUrl ? `<img src="${p.coverUrl}" alt="" />` : '<svg><use href="#i-mic"/></svg>';
    const dur = st.duration || p.duration || shared?.data?.durations?.[cur.id] || 0;
    setSeek(st.currentTime, dur || 0, false);
    if (dur > 0 && shared && st.duration > 0 && Math.abs((shared.data.durations?.[cur.id] || 0) - st.duration) > 1) {
      shared.setDuration?.(cur.id, st.duration);
    }
  }

  const playBtn = $('#btnPlay');
  if (playBtn) playBtn.innerHTML = `<svg><use href="${st.isPlaying ? '#i-pause' : '#i-play'}"/></svg>`;

  const flags = $('#pFlags');
  if (flags) flags.innerHTML = [
    st.loading ? '<span class="pflag">불러오는 중…</span>' : '',
    st.ab.a != null ? `<span class="pflag">A–B ${fmtTime(st.ab.a)} ~ ${st.ab.b != null ? fmtTime(st.ab.b) : '…'}<button data-act="ab-clear">✕</button></span>` : '',
    st.sleep.mode ? `<span class="pflag timer">${st.sleep.mode === 'track' ? '트랙 끝나면 정지' : '취침 ' + fmtLeft(st.sleep.endsAt)}<button data-act="sleep-clear">✕</button></span>` : '',
    cur && offlineIds.has(cur.id) ? '<span class="pflag">오프라인</span>' : '',
  ].join('');
  // live lyric highlight in the now-playing sheet
  if (ui.sheet === 'now' && cur) {
    updateNowSheet(st);
    updateNowLyric(st.currentTime);
  }
  // list play-state
  syncCardStates();
}

function fmtLeft(endsAt) {
  if (!endsAt) return '';
  const left = Math.max(0, endsAt - Date.now());
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

let dragging = false;
function setSeek(t, dur, apply) {
  const pct = dur > 0 ? Math.min(100, (t / dur) * 100) : 0;
  const bar = $('#playerBar');
  if (bar) bar.style.setProperty('--pct', `${pct}%`);
  const prog = $('#pProg');
  if (prog) prog.style.width = `${pct}%`;
  const el = $('#seek');
  if (el) {
    if (!dragging || apply) el.value = String(dur > 0 ? Math.round((t / dur) * 1000) : 0);
    el.style.setProperty('--pct', `${pct}%`);
  }
  const np = $('#npSeek');
  if (np) {
    if (!dragging || apply) np.value = String(dur > 0 ? Math.round((t / dur) * 1000) : 0);
    np.style.setProperty('--pct', `${pct}%`);
  }
}

let lastSync = { id: null, playing: null };
function syncCardStates() {
  if (!player?.current) return;
  const id = player.current.id;
  if (lastSync.id === id && lastSync.playing === player.isPlaying) return;
  lastSync = { id, playing: player.isPlaying };
  for (const card of $$('#listArea .card')) {
    const on = card.dataset.id === id;
    card.classList.toggle('is-playing', on);
    if (on) {
      const icon = card.querySelector('.cbtn-play use');
      if (icon) icon.setAttribute('href', player.isPlaying ? '#i-pause' : '#i-play');
    } else {
      const icon = card.querySelector('.cbtn-play use');
      if (icon) icon.setAttribute('href', '#i-play');
    }
  }
}

/* ─────────────────────────── sheets ─────────────────────────── */
const ui = { sheet: null, lyricIdx: -1, sheetFile: null, seg: 'lyrics', panelKey: '' };

function openSheet(title, html, { tall = false, full = false } = {}) {
  $('#sheetTitle').textContent = title;
  // replace the body node so listeners from the previous sheet are dropped
  const old = $('#sheetBody');
  const body = document.createElement('div');
  body.className = 'sheet-body';
  body.id = 'sheetBody';
  old.replaceWith(body);
  body.innerHTML = html;
  $('#sheet').classList.toggle('is-tall', tall && !full);
  $('#sheet').classList.toggle('is-full', !!full);
  const closeUse = $('#sheetClose')?.querySelector('use');
  if (closeUse) closeUse.setAttribute('href', full ? '#i-chevd' : '#i-close');
  $('#overlay').hidden = false;
  body.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  return body;
}

function closeSheet() {
  $('#overlay').hidden = true;
  ui.sheet = null;
  ui.sheetFile = null;
  ui.lyricIdx = -1;
  document.body.style.overflow = '';
}

/* settings */
function openSettings() {
  ui.sheet = 'settings';
  const isLive = state.mode === 'live';
  const online = drive.connected;
  const stateText = isLive
    ? (online ? 'Google Drive 연결됨' : '저장된 목록 표시 중 — 연결 필요')
    : '데모 모드';
  const body = openSheet('설정', `
    <div class="field">
      <label>연결 상태</label>
      <div class="indexbar" style="margin:0">
        <span style="flex:1 1 auto">${stateText}</span>
        <button class="mini ${isLive && online ? '' : 'has-content'}" data-act="connect">${isLive && online ? '다시 연결' : '연결하기'}</button>
      </div>
      <p class="hint">${isLive
        ? `${esc(state.files.length)}개 파일 · ${esc(state.folders.length)}개 폴더${state.cachedAt ? ` · ${esc(fmtDate(new Date(state.cachedAt).toISOString()))} 기준` : ''}`
        : '연결하면 실제 드라이브의 NIJI VOICE 폴더를 불러옵니다.'}</p>
    </div>

    <div class="field">
      <label>Google OAuth Client ID</label>
      <input type="text" id="setClientId" placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com" value="${esc(settings.clientId)}" autocapitalize="off" autocomplete="off" spellcheck="false" />
      <p class="hint">Google Cloud Console → 사용자 인증 정보 → “OAuth 클라이언트 ID(웹 애플리케이션)”에서 만들어요.
        승인된 JavaScript 출처에 <b>https://harumana.github.io</b> 를 넣어 주세요.</p>
    </div>

    <div class="field">
      <label>루트 폴더 (NIJI VOICE)</label>
      <div class="row">
        <input type="text" id="setRootId" placeholder="폴더 ID 또는 드라이브 링크" value="${esc(settings.rootId)}" autocapitalize="off" autocomplete="off" spellcheck="false" />
        <button class="chip" data-act="detect">자동 찾기</button>
      </div>
      <p class="hint">비워 두고 “연결하기”를 누르면 드라이브에서 <b>NIJI VOICE</b> 폴더를 자동으로 찾아요.</p>
    </div>

    <div class="btnrow">
      <button class="btn-primary" data-act="save-settings">저장</button>
      <button class="btn-secondary" data-act="disconnect">연결 해제</button>
    </div>
    <div class="field">
      <label>폴더 옵션</label>
      <label class="switchrow">
        <input type="checkbox" id="setBackup" ${settings.includeBackup ? 'checked' : ''} />
        <span>“00_원본 백업(태깅 전)” 폴더도 불러오기</span>
      </label>
      <p class="hint">기본은 꺼짐 — 태깅 전 원본 사본이 목록에서 빠져 중복이 줄어요.</p>
    </div>

    <div class="field">
      <label>오프라인 저장</label>
      <div class="indexbar" style="margin:0">
        <span style="flex:1 1 auto" id="offlineUsage">계산 중…</span>
        <button class="mini" data-act="clear-offline">전체 삭제</button>
      </div>
      <p class="hint">파일 카드의 <b>⬇</b> 버튼으로 트랙을 저장하면 네트워크 없이도 재생돼요.</p>
    </div>

    <div class="field">
      <label>가사 인덱스</label>
      <div class="indexbar" style="margin:0">
        <span style="flex:1 1 auto">${indexCount()} / ${state.files.length} 파일</span>
        <button class="mini" data-act="index-run">${state.indexRunning ? '중지' : '인덱싱'}</button>
        <button class="mini" data-act="clear-index">삭제</button>
      </div>
      <p class="hint">MP3 안의 ID3 태그만 읽어 자막·커버를 모아요. 파일을 통째로 받지 않아 빠릅니다.</p>
    </div>

    <div class="field">
      <label>홈 화면에 설치 (아이폰)</label>
      <ol class="steps">
        <li>Safari로 이 페이지를 엽니다.</li>
        <li>하단의 <b>공유</b> 버튼을 누릅니다.</li>
        <li><b>홈 화면에 추가</b>를 선택하면 앱처럼 열려요.</li>
      </ol>
      <p class="hint">홈 화면에서 열면 주소창 없이 전체 화면으로 뜨고, 잠금화면에서도 재생/다음 곡을 조작할 수 있어요.</p>
      <p class="hint">Google 로그인은 <b>Safari</b>에서 먼저 한 번 해 두는 게 안전해요. 홈 화면 앱에서 로그인 창이 뜨지 않으면 Safari로 열어 연결해 주세요.</p>
    </div>

    <div class="field">
      <label>개인정보</label>
      <p class="hint">음원·자막·메모는 이 브라우저와 사용자의 Google 드라이브에만 있고, 서버로 보내지 않아요.
        이 앱은 정적 페이지라 API 키나 개인 데이터를 저장하지 않습니다. 즐겨찾기·재생목록·닉네임은 이 기기에만 저장돼요.</p>
      <p class="hint">공유 메모·태그는 드라이브의 <b>${META_NAME}</b> 파일에 저장되어, 같은 드라이브를 연결한 사람과 함께 볼 수 있어요.</p>
    </div>

    <p class="note" style="text-align:center;margin-top:18px">NIJI VOICE · PWA v1.0</p>
  `, { tall: true });

  db.audioUsage().then((u) => {
    const el = $('#offlineUsage');
    if (el) el.textContent = `${u.count}곡${u.bytes ? ` · ${fmtBytes(u.bytes)}` : ''}`;
  }).catch(() => {});

  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'connect') connectFromUI();
    if (act === 'save-settings') saveSettingsFromUI();
    if (act === 'detect') detectFolder();
    if (act === 'disconnect') {
      drive.signOut();
      state.mode = 'demo';
      try {
        localStorage.removeItem(treeCacheKey(settings.rootId));
        localStorage.removeItem(metaCacheKey(settings.rootId));
      } catch {}
      parsedCache.clear();
      cachedEmpty.clear();
      useDemo();
      toast('연결을 해제했어요. 데모 모드로 돌아갑니다.');
      closeSheet();
    }
    if (act === 'clear-offline') {
      if (!confirm('오프라인 저장한 곡을 모두 지울까요?')) return;
      db.clear('audio').then(() => { offlineIds.clear(); toast('오프라인 저장을 비웠어요'); renderList(); closeSheet(); });
    }
    if (act === 'clear-index') {
      if (!confirm('가사 인덱스(자막·커버 캐시)를 지울까요? 다시 만들 수 있어요.')) return;
      db.clear('parsed').then(() => { parsedCache.clear(); cachedEmpty.clear(); toast('가사 인덱스를 지웠어요'); renderList(); closeSheet(); });
    }
    if (act === 'index-run') { closeSheet(); startIndexing(); }
  });
}

function showConnectError(e) {
  ui.sheet = 'diag';
  const msg = e?.message || String(e || '알 수 없는 오류');
  const origin = location.origin;
  const body = openSheet('연결 진단', `
    <div class="field">
      <label>오류 내용</label>
      <p class="note" style="color:var(--new);word-break:break-word">${esc(msg)}</p>
    </div>
    <div class="field">
      <label>확인 목록</label>
      <ol class="steps">
        <li>Google Cloud 프로젝트에서 <b>Google Drive API</b>를 사용 설정했나요?</li>
        <li>OAuth 클라이언트가 <b>웹 애플리케이션</b>이고, 승인된 JavaScript 출처에 <b>${esc(origin)}</b>가 들어 있나요?</li>
        <li>OAuth 동의 화면의 <b>테스트 사용자</b>에 지금 접속한 Gmail을 추가했나요?</li>
        <li>폴더 ID가 공유 드라이브 안의 <b>NIJI VOICE</b> 폴더가 맞나요?</li>
        <li>앱을 <b>${esc(origin)}</b> 주소로 열었나요? (localhost 등 다른 주소면 출처가 다릅니다)</li>
      </ol>
    </div>
    <div class="btnrow">
      <button class="btn-primary" data-act="retry">다시 연결</button>
      <button class="btn-secondary" data-act="to-settings">설정으로</button>
    </div>
    <p class="hint">연결 전에도 데모 모드로 모든 기능을 써 볼 수 있어요.</p>
  `);
  body.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'retry') connectFromUI();
    if (b.dataset.act === 'to-settings') openSettings();
  });
}

function parseFolderInput(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/);
  return m ? m[1] : s;
}

async function saveSettingsFromUI() {
  const clientId = ($('#setClientId')?.value || '').trim();
  const rootId = parseFolderInput($('#setRootId')?.value || '');
  settings.clientId = clientId;
  settings.rootId = rootId;
  settings.includeBackup = !!$('#setBackup')?.checked;
  saveJSON(SETTINGS_KEY, settings);
  drive.setClientId(clientId);
  toast('저장했어요');
  closeSheet();
  if (clientId) connectFromUI();
}

async function detectFolder() {
  if (!settings.clientId && !drive.clientId) { toast('먼저 OAuth Client ID를 넣어 주세요.', { err: true }); return; }
  try {
    drive.setClientId(($('#setClientId')?.value || settings.clientId).trim());
    await drive.ensure({ interactive: true });
    const found = await drive.findFolderByName('NIJI VOICE');
    if (!found.length) { toast('드라이브에서 NIJI VOICE 폴더를 찾지 못했어요.', { err: true }); return; }
    const pick = found.find((f) => f.driveId) || found[0];
    const input = $('#setRootId');
    if (input) input.value = pick.id;
    toast(`폴더를 찾았어요: ${pick.name}`);
  } catch (e) {
    toast(e?.message || '폴더를 찾지 못했어요.', { err: true });
  }
}

async function connectFromUI() {
  const clientId = ($('#setClientId')?.value || settings.clientId || '').trim();
  if (clientId) { settings.clientId = clientId; drive.setClientId(clientId); }
  const rootId = parseFolderInput($('#setRootId')?.value || settings.rootId || '');
  if (rootId) settings.rootId = rootId;
  const backupEl = $('#setBackup');
  if (backupEl) settings.includeBackup = !!backupEl.checked;
  saveJSON(SETTINGS_KEY, settings);
  closeSheet();
  const ok = await loadLive({ interactive: true });
  if (ok) toast('연결 완료!');
}

/* nickname */
function openNickname() {
  ui.sheet = 'nick';
  const body = openSheet('닉네임', `
    <p class="note">메모에 표시될 이름이에요. 이 기기에만 저장돼요.</p>
    <div class="field">
      <label>닉네임</label>
      <input type="text" id="nickInput" maxlength="20" value="${esc(personal.nickname === '게스트' ? '' : personal.nickname)}" placeholder="예: 쭈" />
      <p class="hint">바꾸면 앞으로 남기는 메모의 작성자 이름이 됩니다. (이미 남긴 메모는 그대로예요)</p>
    </div>
    <button class="btn-primary" data-act="save-nick">저장</button>
  `);
  setTimeout(() => $('#nickInput')?.focus(), 80);
  body.addEventListener('click', (e) => {
    if (!e.target.closest('[data-act="save-nick"]')) return;
    const v = ($('#nickInput')?.value || '').trim() || '게스트';
    personal.nickname = v.slice(0, 20);
    saveJSON(PERSONAL_KEY, personal);
    renderHeader();
    renderList();
    closeSheet();
    toast(`닉네임을 “${personal.nickname}”으로 저장했어요`);
  });
}

/* tags */
function openTagSheet(fileIds) {
  ui.sheet = 'tag';
  const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
  const existing = new Set();
  for (const id of ids) for (const t of shared.tagsOf(id)) existing.add(t);
  const autoSet = new Set();
  for (const id of ids) { const f = fileById(id); if (f) for (const t of autoTagsOf(f)) autoSet.add(t); }
  const allTags = new Set();
  for (const f of state.files) for (const t of tagsOf(f)) allTags.add(t);

  const body = openSheet(ids.length > 1 ? `${ids.length}개 파일에 태그` : '태그', `
    ${ids.length === 1 ? `<div class="note" style="margin-bottom:6px">${esc(displayName(fileById(ids[0])?.name || ''))}</div>` : ''}
    <div class="taglist">
      ${[...existing].map((t) => `<span class="tagpill">#${esc(t)}<button data-act="rm-tag" data-tag="${esc(t)}"><svg><use href="#i-close"/></svg></button></span>`).join('') || '<span class="note">직접 붙인 태그가 없어요.</span>'}
    </div>
    ${autoSet.size ? `<div class="field"><label>자동 태그</label><div class="chiprow">${[...autoSet].map((t) => `<span class="chip auto">#${esc(t)}</span>`).join('')}</div><p class="hint">폴더 경로·파일명·앨범에서 자동으로 붙는 태그예요.</p></div>` : ''}
    <div class="field">
      <label>새 태그</label>
      <div class="row">
        <input type="text" id="tagInput" placeholder="예: 잠들기 전, 최애, 생일" maxlength="24" />
        <button class="chip" data-act="add-tag">추가</button>
      </div>
    </div>
    ${allTags.size ? `<div class="field"><label>기존 태그에서 고르기</label><div class="chiprow">${[...allTags].sort().map((t) =>
      `<button class="chip ${existing.has(t) ? 'is-on' : ''}" data-act="pick-tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div></div>` : ''}
  `);

  const add = async (tag) => {
    const t = String(tag || '').trim();
    if (!t) return;
    await shared.addTags(ids, t);
    toast(`#${t} 태그를 붙였어요`);
    renderFilters(); renderList();
    openTagSheet(ids);
  };

  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'add-tag') {
      const inp = $('#tagInput');
      if (inp?.value.trim()) { const v = inp.value; inp.value = ''; await add(v); }
    }
    if (b.dataset.act === 'pick-tag') await add(b.dataset.tag);
    if (b.dataset.act === 'rm-tag') {
      for (const id of ids) await shared.removeTag(id, b.dataset.tag);
      renderFilters(); renderList();
      openTagSheet(ids);
    }
  });
  body.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && e.target.id === 'tagInput') {
      e.preventDefault();
      if (e.target.value.trim()) await add(e.target.value);
    }
  });
}

/* memos */
function openMemoSheet(file) {
  ui.sheet = 'memo';
  ui.sheetFile = file.id;
  const notes = shared.notesOf(file.id);
  const t = player?.current?.id === file.id ? player.audio.currentTime || 0 : 0;
  const body = openSheet('타임스탬프 메모', `
    <div class="note" style="margin-bottom:4px">${esc(displayName(file.name))}</div>
    <div class="field">
      <label>메모 남기기</label>
      <div class="row" style="align-items:center;gap:8px">
        <button class="chip" data-act="stamp" title="현재 재생 위치">${fmtTime(t)}</button>
        <input type="text" id="memoInput" placeholder="이 지점에 대한 메모…" maxlength="200" style="flex:1 1 auto;padding:11px 12px;border-radius:12px;border:1px solid var(--line);background:var(--surface-2)" />
        <button class="chip is-on" data-act="add-memo">남기기</button>
      </div>
      <p class="hint">시간 버튼을 누르면 지금 재생 위치를 다시 찍어요. 남긴 메모는 공유 드라이브에 저장돼 함께 볼 수 있어요.</p>
    </div>
    <div class="taglist" id="memoList">
      ${notes.length ? notes.map((n) => `
        <div class="memo" data-note="${esc(n.id)}">
          <button class="memo-time" data-act="jump" data-t="${n.t ?? ''}">${n.t != null ? fmtTime(n.t) : '전체'}</button>
          <div class="memo-body">
            <div class="memo-text">${esc(n.text)}</div>
            <div class="memo-meta">${esc(n.author)} · ${esc(fmtDate(n.createdAt))} ${isNewNote(n) ? '<span class="newbadge">NEW</span>' : ''}
              ${n.author === personal.nickname ? '<button class="memo-del" data-act="del" data-id="' + esc(n.id) + '">삭제</button>' : ''}
            </div>
          </div>
        </div>`).join('') : '<div class="note">아직 메모가 없어요.</div>'}
    </div>
  `);

  let stamp = t;
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'stamp') {
      stamp = player?.current?.id === file.id ? player.audio.currentTime || 0 : 0;
      b.textContent = fmtTime(stamp);
    }
    if (act === 'add-memo') {
      const inp = $('#memoInput');
      const text = (inp?.value || '').trim();
      if (!text) { toast('메모 내용을 입력해 주세요.', { err: true }); return; }
      if (stamp > 0 && player?.current?.id !== file.id) {
        // keep the stamped time only for the playing file
      }
      await shared.addNote(file.id, { author: personal.nickname, text, t: stamp });
      toast('메모를 남겼어요');
      renderList();
      openMemoSheet(file);
    }
    if (act === 'jump' && b.dataset.t !== '') {
      jumpTo(file, Number(b.dataset.t));
      closeSheet();
    }
    if (act === 'del') {
      await shared.removeNote(file.id, b.dataset.id);
      toast('메모를 지웠어요');
      renderList();
      openMemoSheet(file);
    }
  });
}

function jumpTo(file, seconds) {
  if (!Number.isFinite(seconds)) return;
  if (player?.current?.id === file.id) {
    player.seek(seconds);
    if (!player.isPlaying) player.toggle();
  } else {
    playFile(file, { startAt: seconds });
  }
}

function jumpToFilter({ tag = '', liver = '' } = {}) {
  closeSheet();
  state.view = liver ? 'folders' : 'all';
  state.folderMode = 'collection';
  state.openPlaylistId = null;
  state.selectMode = false;
  state.search = '';
  const se = $('#searchInput');
  if (se) se.value = '';
  const cb = $('#btnClearSearch');
  if (cb) cb.hidden = true;
  state.filters.year.clear();
  state.filters.liver.clear();
  state.filters.tag.clear();
  if (tag) state.filters.tag.add(tag);
  if (liver) state.filters.liver.add(liver);
  if (liver) {
    state.collectionLiver = liver;
    personal.lastLiver = liver;
    saveJSON(PERSONAL_KEY, personal);
  }
  state.filterBarOpen = false;
  renderAll();
  const sc = $('#scroller');
  if (sc) sc.scrollTo({ top: 0 });
  if (tag) toast(`#${tag} 태그로 모았어요`);
  else if (liver) toast(`${liver} 곡만 보여드려요`);
}

/* subtitles */
function openLyricsSheet(file) {
  const rec = parsedCache.get(file.id);
  if (!rec && !cachedEmpty.has(file.id) && !file.demo && state.mode === 'live') {
    openSheet('자막', '<div class="loading"><span class="spin-ico"></span>자막을 읽는 중…</div>', { tall: true });
    ui.sheet = 'lyrics';
    loadParsed(file)
      .then(() => { if (ui.sheet === 'lyrics') openLyricsSheet(file); })
      .catch((e) => { toast(e?.message || '자막을 읽지 못했어요.', { err: true }); closeSheet(); });
    return;
  }
  ui.sheet = 'lyrics';
  const lyrics = rec?.lyrics || [];
  const transcript = shared.data.transcripts?.[file.id];
  const body = openSheet('자막', `
    <div class="note" style="margin-bottom:8px">${esc(displayName(file.name))}</div>
    ${lyrics.length ? `<div class="lyrics" id="sheetLyrics">${lyrics.map((l, i) => `
      <button class="lrc-line" data-act="seek" data-t="${l.time}" data-i="${i}">
        <span class="orig">${esc(l.orig)}</span>${l.trans ? `<span class="trans">${esc(l.trans)}</span>` : ''}
      </button>`).join('')}</div>`
      : `<div class="lrc-empty">이 파일에는 타임싱크 자막이 없어요.<br>MP3에 USLT 태그를 넣으면 여기서 바로 볼 수 있어요.</div>`}
    <div class="field">
      <label>자막 직접 붙여넣기 (공유 저장)</label>
      <textarea id="trOrig" placeholder="원문 자막">${esc(transcript?.original || '')}</textarea>
      <textarea id="trTrans" placeholder="해석 자막">${esc(transcript?.translated || '')}</textarea>
      <div class="btnrow"><button class="btn-secondary" data-act="save-sub">자막 저장</button></div>
      <p class="hint">여기에 넣은 자막은 드라이브의 공유 메타데이터에 저장되어, 가사 검색에도 함께 걸려요.</p>
    </div>
  `, { tall: true });

  if (player?.current?.id !== file.id) {
    // still show; clicking a line starts the file at that point
  }
  updateNowLyric(player?.current?.id === file.id ? player.audio.currentTime : -1);

  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'seek') {
      jumpTo(file, Number(b.dataset.t));
    }
    if (b.dataset.act === 'save-sub') {
      shared.setTranscript(file.id, {
        original: $('#trOrig')?.value || '',
        translated: $('#trTrans')?.value || '',
        author: personal.nickname,
      }).then(() => toast('자막을 저장했어요')).catch(() => toast('자막 저장에 실패했어요', { err: true }));
    }
  });
}

/* now playing — full-screen player */
function currentParsed(file) {
  return parsedCache.get(file.id) || (file.demo ? demoParsed(file) : {}) || {};
}

function rateLabel(rate) {
  const r = Number(rate) || 1;
  if (Math.abs(r - 1) < 0.001) return '1.0x';
  return `${String(r)}x`;
}

function npMemoHTML(file) {
  const notes = shared.notesOf(file.id);
  const t = player?.current?.id === file.id ? (player.audio.currentTime || 0) : 0;
  return `
    <div class="np-memo-compose">
      <button type="button" class="stamp" data-act="np-stamp" data-t="${t}" title="현재 재생 위치">${fmtTime(t)}</button>
      <input id="npMemoInput" type="text" placeholder="이 지점에 남길 메모…" maxlength="200" />
      <button type="button" class="send" data-act="np-add-memo">남기기</button>
    </div>
    <div id="npMemoList">
      ${notes.length ? notes.map((n) => `
        <div class="memo" data-note="${esc(n.id)}">
          <button type="button" class="memo-time" data-act="np-seek" data-t="${n.t ?? ''}">${n.t != null ? fmtTime(n.t) : '전체'}</button>
          <div class="memo-body">
            <div class="memo-text">${esc(n.text)}</div>
            <div class="memo-meta">${esc(n.author)} · ${esc(fmtDate(n.createdAt))} ${isNewNote(n) ? '<span class="newbadge">NEW</span>' : ''}
              ${n.author === personal.nickname ? `<button type="button" class="memo-del" data-act="np-del" data-id="${esc(n.id)}">삭제</button>` : ''}
            </div>
          </div>
        </div>`).join('')
        : '<div class="note" style="padding:14px 4px">아직 메모가 없어요. 재생 중 원하는 지점에서 남겨 보세요.</div>'}
    </div>`;
}

function npPanelHTML(file, seg) {
  const p = currentParsed(file);
  if (seg === 'memo') return npMemoHTML(file);
  if (seg === 'cover') {
    return `
    <div class="np-art">
      ${p.coverUrl
        ? `<img src="${p.coverUrl}" alt="${esc(p.title || displayName(file.name))}" data-act="np-art" />`
        : '<div class="np-art-empty"><svg><use href="#i-mic"/></svg><span>이 곡에는 앨범 커버가 없어요.</span></div>'}
    </div>`;
  }
  return `
    <div class="np-panel-head">
      <button type="button" data-act="np-edit-lyrics">자막 편집</button>
    </div>
    ${p.lyrics?.length ? `<div class="lyrics" id="sheetLyrics">${p.lyrics.map((l, i) => `
      <button class="lrc-line" data-act="np-seek" data-t="${l.time}" data-i="${i}">
        <span class="orig">${esc(l.orig)}</span>${l.trans ? `<span class="trans">${esc(l.trans)}</span>` : ''}
      </button>`).join('')}</div>`
      : `<div class="lrc-empty">${p.plainLyrics ? esc(p.plainLyrics) : '이 곡에는 타임싱크 자막이 없어요.'}</div>`}`;
}

function renderNowPanel(file, seg) {
  const panel = $('#npPanel');
  if (!panel) return;
  panel.innerHTML = npPanelHTML(file, seg);
  const p = currentParsed(file);
  ui.panelKey = `${file.id}|${seg}|${(p.lyrics || []).length}`;
  ui.lyricIdx = -1;
}

function openCoverView(url) {
  if (!url) { toast('이 곡에는 앨범 커버가 없어요'); return; }
  const ov = document.createElement('div');
  ov.className = 'coverview';
  ov.innerHTML = `<img src="${url}" alt="앨범 커버" /><button type="button" class="cv-x" aria-label="닫기"><svg><use href="#i-close"/></svg></button>`;
  ov.addEventListener('click', () => ov.remove());
  document.body.appendChild(ov);
}

function openNowPlaying() {
  if (!player?.current) { toast('재생 중인 곡이 없어요'); return; }
  const file = player.current;
  const p = currentParsed(file);
  const tags = tagsOf(file);
  ui.sheet = 'now';
  ui.sheetFile = file.id;
  ui.lyricIdx = -1;
  const seg0 = ['cover', 'lyrics', 'memo'].includes(personal.lastSeg) ? personal.lastSeg : 'lyrics';
  ui.seg = seg0;
  const eyebrow = p.album || file.liver || '지금 재생 중';
  const body = openSheet(eyebrow, `
    <div class="np">
      <div class="np-hero">
        <button type="button" class="np-cover" id="npCover" data-act="np-cover" aria-label="앨범 커버 크게 보기">${p.coverUrl ? `<img src="${p.coverUrl}" alt="" />` : '<svg><use href="#i-mic"/></svg>'}</button>
        <div class="np-head">
          <div class="np-info">
            <div class="np-title" id="npTitle">${esc(p.title || displayName(file.name))}</div>
            <div class="np-sub" id="npSub">${esc([p.artist, p.album].filter(Boolean).join(' · ') || file.liver || '')}</div>
            ${(file.liver || tags.length) ? `<div class="np-tags" id="npTags">
              ${file.liver ? `<button type="button" class="badge np-liver" data-act="np-liver" data-liver="${esc(file.liver)}">${esc(file.liver)}</button>` : ''}
              ${tags.map((t) => `<button type="button" class="badge np-tag" data-act="np-tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
            </div>` : ''}
          </div>
          <button type="button" class="np-fav ${isFav(file.id) ? 'is-on' : ''}" id="npFav" data-act="np-fav" aria-label="즐겨찾기">
            <svg><use href="${isFav(file.id) ? '#i-star-fill' : '#i-star'}"/></svg>
          </button>
        </div>
      </div>
      <div class="np-seekwrap">
        <input id="npSeek" type="range" min="0" max="1000" step="1" value="0" aria-label="재생 위치" />
        <div class="np-times"><span id="npCur">00:00</span><span id="npDur">-00:00</span></div>
      </div>
      <div class="np-ctrl">
        <button type="button" data-act="np-prev" aria-label="이전 곡"><svg><use href="#i-prev"/></svg></button>
        <button type="button" data-act="np-back10" aria-label="10초 뒤로"><svg><use href="#i-back10"/></svg></button>
        <button type="button" class="np-play" id="npPlay" data-act="np-play" aria-label="재생/일시정지"><svg><use href="${player.isPlaying ? '#i-pause' : '#i-play'}"/></svg></button>
        <button type="button" data-act="np-fwd10" aria-label="10초 앞으로"><svg><use href="#i-fwd10"/></svg></button>
        <button type="button" data-act="np-next" aria-label="다음 곡"><svg><use href="#i-next"/></svg></button>
      </div>
      <div class="np-pills">
        <button type="button" class="np-pill ${player.shuffle ? 'is-on' : ''}" id="npShuffle" data-act="np-shuffle"><svg><use href="#i-shuffle"/></svg>셔플</button>
        <button type="button" class="np-pill ${player.ab.a != null ? 'is-on' : ''}" id="npAB" data-act="np-ab">A–B</button>
        <button type="button" class="np-pill" id="npRate" data-act="np-rate">${rateLabel(player.rate)}</button>
        <button type="button" class="np-pill ${player.sleep.mode ? 'is-on' : ''}" id="npSleep" data-act="np-sleep"><svg><use href="#i-moon"/></svg>취침</button>
        <button type="button" class="np-pill" data-act="np-queue"><svg><use href="#i-list"/></svg>대기열</button>
        <button type="button" class="np-pill" data-act="np-more"><svg><use href="#i-more"/></svg>더보기</button>
      </div>
      <div class="np-optrow" id="npSleepOpt" hidden>
        ${[15, 30, 60].map((m) => `<button type="button" class="chip" data-act="np-sleep-set" data-min="${m}">${m}분</button>`).join('')}
        <button type="button" class="chip" data-act="np-sleep-set" data-min="track">트랙 끝</button>
        <button type="button" class="chip" data-act="np-sleep-set" data-min="off">해제</button>
      </div>
      <div class="np-optrow" id="npRateOpt" hidden>
        ${[0.75, 1, 1.25, 1.5].map((r) => `<button type="button" class="chip ${Math.abs((player.rate || 1) - r) < 0.001 ? 'is-on' : ''}" data-act="np-rate-set" data-rate="${r}">${rateLabel(r)}</button>`).join('')}
      </div>
      <div class="np-seg" id="npSeg">
        <button type="button" data-seg="cover" class="${seg0 === 'cover' ? 'is-on' : ''}">커버</button>
        <button type="button" data-seg="lyrics" class="${seg0 === 'lyrics' ? 'is-on' : ''}">가사</button>
        <button type="button" data-seg="memo" class="${seg0 === 'memo' ? 'is-on' : ''}">메모</button>
      </div>
      <div class="np-panel" id="npPanel">${npPanelHTML(file, seg0)}</div>
    </div>
  `, { full: true });
  ui.panelKey = `${file.id}|${seg0}|${(p.lyrics || []).length}`;

  updateNowSheet({
    current: file,
    isPlaying: player.isPlaying,
    currentTime: player.audio.currentTime || 0,
    duration: Number.isFinite(player.audio.duration) ? player.audio.duration : 0,
    ab: { ...player.ab },
    sleep: { ...player.sleep },
    shuffle: player.shuffle,
  });
  updateNowLyric(player.audio.currentTime || 0);

  const npSeek = $('#npSeek');
  if (npSeek) {
    npSeek.addEventListener('input', () => {
      dragging = true;
      const dur = player.audio.duration || 0;
      const pct = Number(npSeek.value) / 10;
      npSeek.style.setProperty('--pct', `${pct}%`);
      const curEl = $('#npCur');
      if (curEl && dur) curEl.textContent = fmtTime((Number(npSeek.value) / 1000) * dur);
    });
    npSeek.addEventListener('change', () => {
      const dur = player.audio.duration || 0;
      if (dur) player.seek((Number(npSeek.value) / 1000) * dur);
      dragging = false;
    });
  }

  for (const btn of $$('#npSeg button', body)) {
    btn.addEventListener('click', () => {
      const seg = btn.dataset.seg;
      ui.seg = seg;
      personal.lastSeg = seg;
      saveJSON(PERSONAL_KEY, personal);
      for (const x of $$('#npSeg button', body)) x.classList.toggle('is-on', x === btn);
      renderNowPanel(file, seg);
      if (seg === 'lyrics') updateNowLyric(player.audio.currentTime || 0);
    });
  }

  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'np-fav') {
      setFav(file.id, !isFav(file.id));
      const on = isFav(file.id);
      b.classList.toggle('is-on', on);
      const use = b.querySelector('use');
      if (use) use.setAttribute('href', on ? '#i-star-fill' : '#i-star');
      renderList();
      renderSelectionBar();
      return;
    }
    if (act === 'np-tag') {
      jumpToFilter({ tag: b.dataset.tag || '' });
      return;
    }
    if (act === 'np-liver') {
      jumpToFilter({ liver: b.dataset.liver || '' });
      return;
    }
    if (act === 'np-cover' || act === 'np-art') {
      openCoverView(currentParsed(file).coverUrl);
      return;
    }
    if (act === 'np-play') { if (player.current?.id === file.id) player.toggle(); else playFile(file); return; }
    if (act === 'np-prev') { player.prev(); return; }
    if (act === 'np-next') { player.next(); return; }
    if (act === 'np-back10') {
      player.seek(Math.max(0, (player.audio.currentTime || 0) - 10));
      return;
    }
    if (act === 'np-fwd10') {
      player.seek((player.audio.currentTime || 0) + 10);
      return;
    }
    if (act === 'np-rate') {
      const row = $('#npRateOpt');
      if (row) row.hidden = !row.hidden;
      const srow = $('#npSleepOpt');
      if (srow) srow.hidden = true;
      return;
    }
    if (act === 'np-rate-set') {
      player.setRate(Number(b.dataset.rate));
      const lab = $('#npRate');
      if (lab) lab.textContent = rateLabel(player.rate);
      const row = $('#npRateOpt');
      if (row) row.hidden = true;
      for (const c of $$('#npRateOpt .chip')) c.classList.toggle('is-on', Number(c.dataset.rate) === player.rate);
      toast(`재생 속도 ${rateLabel(player.rate)}`);
      return;
    }
    if (act === 'np-shuffle') { player.setShuffle(!player.shuffle); toast(player.shuffle ? '셔플 켜짐' : '셔플 꺼짐'); return; }
    if (act === 'np-ab') { cycleABWithToast(); return; }
    if (act === 'np-sleep') {
      const row = $('#npSleepOpt');
      if (row) row.hidden = !row.hidden;
      const rrow = $('#npRateOpt');
      if (rrow) rrow.hidden = true;
      return;
    }
    if (act === 'np-sleep-set') {
      const v = b.dataset.min;
      if (v === 'off') { player.clearSleep(); toast('타이머를 해제했어요'); }
      else if (v === 'track') { player.setSleep('track'); toast('현재 트랙이 끝나면 정지해요'); }
      else { player.setSleep(Number(v)); toast(`${v}분 뒤 정지해요`); }
      const row = $('#npSleepOpt');
      if (row) row.hidden = true;
      return;
    }
    if (act === 'np-queue') { openQueue(); return; }
    if (act === 'np-more') { openMoreSheet(file); return; }
    if (act === 'np-edit-lyrics') { openLyricsSheet(file); return; }
    if (act === 'np-seek') {
      const t = b.dataset.t;
      if (t !== undefined && t !== '') {
        player.seek(Number(t));
        if (!player.isPlaying) player.toggle();
      }
      return;
    }
    if (act === 'np-stamp') {
      const t = player?.current?.id === file.id ? player.audio.currentTime || 0 : 0;
      b.dataset.t = String(t);
      b.textContent = fmtTime(t);
      return;
    }
    if (act === 'np-add-memo') {
      const inp = $('#npMemoInput');
      const text = (inp?.value || '').trim();
      if (!text) { toast('메모 내용을 입력해 주세요.', { err: true }); return; }
      const stampEl = body.querySelector('[data-act="np-stamp"]');
      const t = stampEl ? Number(stampEl.dataset.t || 0) : 0;
      await shared.addNote(file.id, { author: personal.nickname, text, t });
      toast('메모를 남겼어요');
      renderList();
      renderTabs();
      renderNowPanel(file, 'memo');
      return;
    }
    if (act === 'np-del') {
      await shared.removeNote(file.id, b.dataset.id);
      toast('메모를 지웠어요');
      renderList();
      renderNowPanel(file, 'memo');
      return;
    }
  });
}

function updateNowSheet(st) {
  const cur = st.current;
  if (!cur) return;
  if (ui.sheet === 'now' && ui.sheetFile && cur.id !== ui.sheetFile) {
    openNowPlaying();
    return;
  }
  const p = currentParsed(cur);
  const eyebrow = p.album || cur.liver || '지금 재생 중';
  const titleEl = $('#sheetTitle');
  if (titleEl) titleEl.textContent = eyebrow;
  const panelKey = `${cur.id}|${ui.seg}|${(p.lyrics || []).length}`;
  if ($('#npPanel') && ui.seg !== 'memo' && ui.panelKey !== panelKey) {
    renderNowPanel(cur, ui.seg);
    if (ui.seg === 'lyrics') updateNowLyric(st.currentTime);
  }
  const dur = st.duration || p.duration || shared?.data?.durations?.[cur.id] || 0;
  const pct = dur > 0 ? Math.min(100, (st.currentTime / dur) * 100) : 0;
  const seek = $('#npSeek');
  if (seek) {
    if (!dragging) seek.value = String(dur > 0 ? Math.round((st.currentTime / dur) * 1000) : 0);
    seek.style.setProperty('--pct', `${pct}%`);
  }
  const curEl = $('#npCur');
  if (curEl) curEl.textContent = fmtTime(st.currentTime);
  const durEl = $('#npDur');
  if (durEl) durEl.textContent = dur ? '-' + fmtTime(Math.max(0, dur - st.currentTime)) : '-00:00';
  const playUse = $('#npPlay use');
  if (playUse) playUse.setAttribute('href', st.isPlaying ? '#i-pause' : '#i-play');
  const sh = $('#npShuffle');
  if (sh) sh.classList.toggle('is-on', !!st.shuffle);
  const ab = $('#npAB');
  if (ab) ab.classList.toggle('is-on', st.ab.a != null);
  const rateEl = $('#npRate');
  if (rateEl) rateEl.textContent = rateLabel(st.rate != null ? st.rate : player.rate);
  const sl = $('#npSleep');
  if (sl) sl.classList.toggle('is-on', !!st.sleep.mode);
  const title = $('#npTitle');
  if (title) title.textContent = p.title || displayName(cur.name);  const sub = $('#npSub');
  if (sub) sub.textContent = [p.artist, p.album].filter(Boolean).join(' · ') || cur.liver || '';
  const cov = $('#npCover');
  if (cov) {
    const url = p.coverUrl || '';
    const img = cov.querySelector('img');
    if (url && (!img || img.getAttribute('src') !== url)) cov.innerHTML = `<img src="${url}" alt="" />`;
    else if (!url && !img) cov.innerHTML = '<svg><use href="#i-mic"/></svg>';
  }
}

function cycleABWithToast() {
  if (!player?.current) { toast('먼저 곡을 재생해 주세요.'); return; }
  const r = player.cycleAB();
  if (r.step === 'a') toast(`A 지점 ${fmtTime(r.t)} — 끝 지점에서 한 번 더 누르세요`);
  else if (r.step === 'b') toast(`A–B 반복 ${fmtTime(player.ab.a)} ~ ${fmtTime(player.ab.b)}`);
  else toast('A–B 반복을 해제했어요');
}

function updateNowLyric(time) {
  const host = $('#sheetLyrics');
  if (!host || time < 0) return;
  const lines = $$('.lrc-line', host);
  if (!lines.length) return;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (Number(lines[i].dataset.t) <= time + 0.15) idx = i; else break;
  }
  if (idx === ui.lyricIdx) return;
  ui.lyricIdx = idx;
  lines.forEach((el, i) => el.classList.toggle('is-on', i === idx));
  if (idx >= 0) {
    const el = lines[idx];
    const box = host;
    const top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
    box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
}

/* queue */
function openQueue() {
  ui.sheet = 'queue';
  const q = player?.queue || [];
  const body = openSheet(`재생 목록 (${q.length})`, q.length ? q.map((f, i) => `
    <button class="hit" data-act="q-play" data-i="${i}">
      <span class="memo-time">${i + 1}</span>
      <span class="hit-line">
        <span class="hit-orig" style="${player?.current?.id === f.id ? 'color:var(--primary-ink)' : ''}">${esc(displayName(f.name))}</span>
        <span class="hit-file">${esc([f.liver, f.year].filter(Boolean).join(' · '))}</span>
      </span>
    </button>`).join('') : '<div class="lrc-empty">재생 목록이 비어 있어요.</div>', { tall: true });
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="q-play"]');
    if (!b) return;
    const i = Number(b.dataset.i);
    player.index = i;
    player.load(player.queue[i]);
    closeSheet();
  });
}

/* sleep timer */
function openSortSheet() {
  ui.sheet = 'sort';
  const row = (key, label) => `<button type="button" class="act-item ${state.sort === key ? 'is-on' : ''}" data-act="sort" data-sort="${key}">
    <span class="ai"><svg><use href="${state.sort === key ? '#i-check' : '#i-sort'}"/></svg></span>
    <span class="al">${label}</span>
    ${state.sort === key ? '<span class="av">선택됨</span>' : ''}
  </button>`;
  const body = openSheet('정렬', row('recent', '최신순') + row('name', '이름순'));
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="sort"]');
    if (!b) return;
    state.sort = b.dataset.sort === 'name' ? 'name' : 'recent';
    closeSheet();
    renderList();
  });
}

function openSleep() {
  const st = player?.sleep || {};
  const body = openSheet('취침 타이머 🌙', `
    <p class="note">설정한 시간이 지나면 재생이 자동으로 멈춰요.</p>
    <div class="chiprow" style="margin-top:14px">
      ${[15, 30, 60].map((m) => `<button class="chip ${st.mode === m ? 'is-on' : ''}" data-act="sleep" data-min="${m}">${m}분</button>`).join('')}
      <button class="chip ${st.mode === 'track' ? 'is-on' : ''}" data-act="sleep" data-min="track">현재 트랙 끝나면</button>
      <button class="chip" data-act="sleep" data-min="off">해제</button>
    </div>
    ${st.endsAt ? `<p class="note" style="margin-top:14px">남은 시간 ${fmtLeft(st.endsAt)}</p>` : ''}
  `);
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="sleep"]');
    if (!b) return;
    const v = b.dataset.min;
    if (v === 'off') { player.clearSleep(); toast('타이머를 해제했어요'); }
    else if (v === 'track') { player.setSleep('track'); toast('현재 트랙이 끝나면 정지해요'); }
    else { player.setSleep(Number(v)); toast(`${v}분 뒤 정지해요`); }
    closeSheet();
  });
}

/* playlist picker */
function openPlaylistPicker(fileIds) {
  const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
  const body = openSheet('재생목록에 추가', `
    ${personal.playlists.map((p) => `<button class="pl-row" data-act="pick" data-id="${esc(p.id)}">
      <span class="pl-ico"><svg><use href="#i-list"/></svg></span>
      <span class="pl-name">${esc(p.name)}</span>
      <span class="pl-count">${p.fileIds.length}곡</span>
    </button>`).join('') || '<div class="note">아직 재생목록이 없어요.</div>'}
    <div class="field" style="margin-top:14px">
      <label>새 재생목록</label>
      <div class="row">
        <input type="text" id="plName" placeholder="재생목록 이름" maxlength="30" />
        <button class="chip" data-act="create">만들기</button>
      </div>
    </div>
  `);
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'pick') {
      const pl = personal.playlists.find((p) => p.id === b.dataset.id);
      if (!pl) return;
      let added = 0;
      for (const id of ids) if (!pl.fileIds.includes(id)) { pl.fileIds.push(id); added += 1; }
      saveJSON(PERSONAL_KEY, personal);
      toast(`${pl.name}에 ${added}곡을 담았어요`);
      closeSheet();
      renderList();
    }
    if (b.dataset.act === 'create') {
      const name = ($('#plName')?.value || '').trim();
      if (!name) { toast('이름을 입력해 주세요.', { err: true }); return; }
      personal.playlists.push({ id: 'pl_' + Date.now().toString(36), name, fileIds: [...new Set(ids)] });
      saveJSON(PERSONAL_KEY, personal);
      toast(`“${name}” 재생목록을 만들었어요`);
      closeSheet();
      renderList();
    }
  });
}

/* per-track action sheet (⋯) */
function openMoreSheet(file, { playlist = false } = {}) {
  ui.sheet = 'more';
  const p = currentParsed(file);
  const cover = p.coverUrl || '';
  const saved = offlineIds.has(file.id);
  const notes = shared.notesOf(file.id).length;
  const tags = tagsOf(file);
  const isCurrent = player?.current?.id === file.id;
  const body = openSheet('더보기', `
    <div class="act-head">
      <span class="act-cov">${cover ? `<img src="${cover}" alt="" />` : '<svg><use href="#i-mic"/></svg>'}</span>
      <span class="act-meta">
        <div class="act-title">${esc(p.title || displayName(file.name))}</div>
        <div class="act-sub">${esc([file.liver, file.year, fmtBytes(file.size)].filter(Boolean).join(' · '))}</div>
      </span>
    </div>
    <button type="button" class="act-item" data-act="m-tag">
      <span class="ai"><svg><use href="#i-tag"/></svg></span>
      <span class="al">태그</span>
      <span class="av">${tags.length ? `${tags.length}개` : '없음'}</span>
    </button>
    <button type="button" class="act-item" data-act="m-memo">
      <span class="ai"><svg><use href="#i-memo"/></svg></span>
      <span class="al">타임스탬프 메모</span>
      <span class="av">${notes ? `${notes}개` : ''}</span>
    </button>
    <button type="button" class="act-item" data-act="m-lyrics">
      <span class="ai"><svg><use href="#i-lyrics"/></svg></span>
      <span class="al">자막</span>
      <span class="av">${p.lyrics?.length ? '있음' : ''}</span>
    </button>
    <button type="button" class="act-item ${saved ? 'is-on' : ''}" data-act="m-offline">
      <span class="ai"><svg><use href="${saved ? '#i-check' : '#i-download'}"/></svg></span>
      <span class="al">${saved ? '오프라인 저장 삭제' : '오프라인 저장'}</span>
      <span class="av">${saved ? '완료' : ''}</span>
    </button>
    <button type="button" class="act-item" data-act="m-pl">
      <span class="ai"><svg><use href="#i-list"/></svg></span>
      <span class="al">재생목록에 추가</span>
    </button>
    ${playlist ? `<button type="button" class="act-item danger" data-act="m-pl-remove">
      <span class="ai"><svg><use href="#i-close"/></svg></span>
      <span class="al">이 재생목록에서 빼기</span>
    </button>` : ''}
    <button type="button" class="act-item" data-act="m-play">
      <span class="ai"><svg><use href="${isCurrent ? '#i-pause' : '#i-play'}"/></svg></span>
      <span class="al">${isCurrent ? '재생 / 일시정지' : '이 곡 재생'}</span>
    </button>
  `);

  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'm-tag') { openTagSheet(file.id); return; }
    if (act === 'm-memo') { openMemoSheet(file); return; }
    if (act === 'm-lyrics') { openLyricsSheet(file); return; }
    if (act === 'm-pl') { openPlaylistPicker([file.id]); return; }
    if (act === 'm-pl-remove') { removeFromPlaylist(file.id); return; }
    if (act === 'm-offline') {
      await toggleOffline(file);
      openMoreSheet(file, { playlist });
      return;
    }
    if (act === 'm-play') {
      closeSheet();
      if (player.current?.id === file.id) player.toggle();
      else playFile(file);
    }
  });
}

function removeFromPlaylist(fileId) {
  const pl = personal.playlists.find((p) => p.id === state.openPlaylistId);
  if (!pl) return;
  pl.fileIds = pl.fileIds.filter((id) => id !== fileId);
  saveJSON(PERSONAL_KEY, personal);
  closeSheet();
  renderList();
  toast('재생목록에서 뺐어요');
}

/* ─────────────────────────── offline ─────────────────────────── */
async function toggleOffline(file) {
  if (file.demo) { toast('데모 곡은 이미 오프라인에서 재생돼요.'); return; }
  if (offlineIds.has(file.id)) {
    if (!confirm('이 곡의 오프라인 저장을 지울까요?')) return;
    await db.del('audio', file.id);
    offlineIds.delete(file.id);
    toast('오프라인 저장을 지웠어요');
    renderList();
    return;
  }
  try {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    const t = toastProgress(`${displayName(file.name)} 저장 중`);
    const buf = await drive.download(file.id, { onProgress: t.update });
    t.done();
    await db.put('audio', file.id, {
      fileId: file.id, name: file.name, size: buf.byteLength,
      blob: new Blob([buf], { type: 'audio/mpeg' }), savedAt: Date.now(),
    });
    await loadParsed(file).catch(() => {});
    offlineIds.add(file.id);
    toast('오프라인 저장 완료 — 네트워크 없이 재생돼요');
    renderList();
  } catch (e) {
    toast(e?.message || '저장하지 못했어요.', { err: true });
  }
}

/* ─────────────────────────── lyrics indexing ─────────────────────────── */
async function startIndexing() {
  if (state.indexRunning) { state.indexCancel = true; return; }
  if (state.mode !== 'live') { toast('데모 모드에서는 이미 인덱싱되어 있어요.'); return; }
  state.indexRunning = true;
  state.indexCancel = false;
  const todo = state.files.filter((f) => !parsedCache.has(f.id) && !cachedEmpty.has(f.id));
  let ok = 0;
  let fail = 0;
  const t = toastProgress('가사 인덱싱');
  for (const f of todo) {
    if (state.indexCancel) break;
    try {
      await loadParsed(f);
      ok += 1;
    } catch (e) {
      fail += 1;
      if (e instanceof NeedsAuth) break;
    }
    t.update({ received: ok + fail, total: todo.length });
    if (state.view === 'lyrics') {
      const bar = $('#listArea .indexbar .bar i');
      if (bar) bar.style.width = `${Math.round((indexCount() / Math.max(1, state.files.length)) * 100)}%`;
    }
  }
  t.done();
  state.indexRunning = false;
  toast(`가사 인덱싱 완료 — ${ok}개 추가${fail ? `, ${fail}개 실패` : ''}`);
  if (state.view === 'lyrics') renderLyricsView();
  if (ui.sheet === 'settings') openSettings();
}

/* ─────────────────────────── events ─────────────────────────── */
function bindEvents() {
  const on = (sel, ev, fn, opts) => {
    const el = $(sel);
    if (el) el.addEventListener(ev, fn, opts);
    return el;
  };

  $('#viewTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    state.view = b.dataset.view;
    state.openPlaylistId = null;
    state.selected.clear();
    state.selectMode = false;
    renderAll();
    $('#scroller').scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('#filters').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) {
      const key = open.dataset.open;
      if (state.openFilters.has(key)) state.openFilters.delete(key);
      else { state.openFilters.clear(); state.openFilters.add(key); }
      renderFilters();
      return;
    }
    const opt = e.target.closest('[data-fopt]');
    if (opt) {
      const key = opt.dataset.fopt;
      const val = opt.dataset.val;
      if (state.filters[key].has(val)) state.filters[key].delete(val); else state.filters[key].add(val);
      renderFilters();
      renderList();
      return;
    }
    if (e.target.closest('#btnClearFilters')) {
      state.filters.year.clear(); state.filters.liver.clear(); state.filters.tag.clear();
      renderFilters(); renderList();
    }
  });

  $('#btnClearFilters').addEventListener('click', () => {
    state.filters.year.clear(); state.filters.liver.clear(); state.filters.tag.clear();
    renderFilters(); renderList();
  });

  on('#btnFilterToggle', 'click', () => {
    state.filterBarOpen = !state.filterBarOpen;
    if (!state.filterBarOpen) state.openFilters.clear();
    renderFilters();
  });

  $('#searchInput').addEventListener('input', debounce((e) => {
    state.search = e.target.value;
    $('#btnClearSearch').hidden = !state.search;
    renderList();
  }, 140));

  $('#btnClearSearch').addEventListener('click', () => {
    state.search = '';
    $('#searchInput').value = '';
    $('#btnClearSearch').hidden = true;
    renderList();
  });

  $('#btnRefresh').addEventListener('click', async () => {
    if (state.loading) return;
    if (!settings.clientId) { toast('데모 모드예요. 설정에서 Google Drive를 연결해 주세요.'); return; }
    if (!drive.connected || state.mode === 'demo') { await loadLive({ interactive: true }); return; }
    await refresh(true);
  });

  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnNick').addEventListener('click', openNickname);
  $('#connState').addEventListener('click', () => {
    if (settings.clientId && !drive.connected) loadLive({ interactive: true }).catch(() => {});
    else openSettings();
  });
  $('#connState').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (settings.clientId && !drive.connected) loadLive({ interactive: true }).catch(() => {});
    else openSettings();
  });

  on('#btnSort', 'click', openSortSheet);
  on('#btnOffline', 'click', () => {
    state.offlineOnly = !state.offlineOnly;
    const b = $('#btnOffline');
    if (b) b.classList.toggle('is-on', state.offlineOnly);
    renderList();
    toast(state.offlineOnly ? '오프라인 저장한 곡만 보여드려요' : '저장한 곡을 모두 보여드려요');
  });
  on('#btnShuffleAll', 'click', () => {
    const files = visibleFiles();
    if (!files.length) { toast('재생할 파일이 없어요.'); return; }
    player.setShuffle(true);
    const start = Math.floor(Math.random() * files.length);
    player.playFiles(files, start);
    renderControlbar();
    toast(`${files.length}곡을 섞어서 재생해요`);
  });
  on('#btnPlayAll', 'click', () => {
    let files = visibleFiles();
    if (state.view === 'folders' && state.folderMode === 'tree') {
      files = state.files.filter((f) => f.parentId === (state.folderId || state.rootId));
    }
    if (!files.length) { toast('재생할 파일이 없어요.'); return; }
    player.playFiles(files, 0);
    toast(`${files.length}곡 재생 시작`);
  });

  $('#listArea').addEventListener('click', onListClick);
  $('#selBar').addEventListener('click', onSelAction);

  /* player */
  on('#btnPlay', 'click', () => {
    if (!player.current) {
      const files = visibleFiles();
      if (files.length) player.playFiles(files, 0);
      else toast('재생할 파일이 없어요.');
      return;
    }
    if (!player.loaded) { playFile(player.current); return; }
    player.toggle();
  });
  on('#btnNext', 'click', () => player.next());
  on('#btnNow', 'click', openNowPlaying);
  on('#pFlags', 'click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'ab-clear') { player.clearAB(); toast('A–B 반복을 해제했어요'); }
    if (b.dataset.act === 'sleep-clear') { player.clearSleep(); toast('타이머를 해제했어요'); }
  });

  $('#sheetClose').addEventListener('click', closeSheet);
  $('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeSheet(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#overlay').hidden) closeSheet();
    if (e.key === ' ' && $('#overlay').hidden && !/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName)) {
      e.preventDefault();
      if (player?.current) player.toggle();
    }
  });

  $('#scroller').addEventListener('scroll', () => {
    const hdr = $('.hdr');
    if (hdr) hdr.classList.toggle('is-scrolled', $('#scroller').scrollTop > 4);
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.mode === 'live' && drive.connected && shared?.modifiedTime && Date.now() - lastMetaRefresh > 120000) {
      refreshMetaOnly();
    }
  });

  window.addEventListener('error', (e) => {
    (window.__errors ||= []).push(String(e.message || e.error));
  });
  window.addEventListener('unhandledrejection', (e) => {
    (window.__errors ||= []).push('promise: ' + String(e.reason?.message || e.reason));
  });
}

let lastMetaRefresh = 0;
async function refreshMetaOnly() {
  if (!drive.connected) return;
  try {
    await shared.load();
    lastMetaRefresh = Date.now();
    saveMetaCache(shared?.data);
    renderList();
    renderTabs();
  } catch {}
}

async function refresh(manual = false) {
  if (state.mode === 'demo') {
    if (manual) { useDemo(); toast('데모 데이터를 새로고침했어요'); }
    return;
  }
  state.loading = true;
  renderHeader();
  try {
    const tree = await drive.tree(settings.rootId, {
      skipFolder: skipFolderFilter,
      onProgress: ({ done }) => setConnText(`불러오는 중… (${done})`),
    });
    await shared.load();
    lastMetaRefresh = Date.now();
    enrich(tree);
    saveTreeCache(tree);
    saveMetaCache(shared?.data);
    state.fromCache = false;
    await refreshOfflineIds();
    await primeCache();
    renderAll();
    if (manual) toast('새로고침 완료');
  } catch (e) {
    if (e instanceof NeedsAuth) {
      toast('다시 연결해 주세요.', { err: true });
      openSettings();
    } else {
      toast(e?.message || '새로고침에 실패했어요.', { err: true });
    }
  } finally {
    state.loading = false;
    renderHeader();
  }
}

/* list interactions */
function onListClick(e) {
  const action = e.target.closest('[data-act]');
  const card = e.target.closest('.card');

  // views that are not plain card lists
  if (!action) return;
  const act = action.dataset.act;

  if (act === 'connect') { openSettings(); return; }
  if (act === 'demo') { useDemo(); return; }
  if (act === 'select-mode') { toggleSelectMode(); return; }
  if (act === 'pick-liver') { openLiverSheet(); return; }
  if (act === 'folder-mode') {
    state.folderMode = action.dataset.mode === 'tree' ? 'tree' : 'collection';
    if (state.folderMode === 'tree' && !state.folderId) state.folderId = state.rootId;
    renderList();
    return;
  }
  if (act === 'tile') {
    const f = fileById(action.dataset.id);
    if (f) playFile(f);
    return;
  }
  if (act === 'reset-search') {
    state.search = ''; $('#searchInput').value = ''; $('#btnClearSearch').hidden = true;
    state.filters.year.clear(); state.filters.liver.clear(); state.filters.tag.clear();
    renderAll(); return;
  }
  if (act === 'mark-seen') {
    personal.notesSeenAt = Date.now();
    saveJSON(PERSONAL_KEY, personal);
    renderTabs(); renderList(); return;
  }
  if (act === 'memo-jump') {
    const f = fileById(action.dataset.id);
    if (!f) return;
    const t = action.dataset.t;
    if (t !== '') jumpTo(f, Number(t)); else playFile(f);
    return;
  }
  if (act === 'lyric-hit') {
    const f = fileById(action.dataset.id);
    if (!f) return;
    const t = action.dataset.t;
    if (t !== '') jumpTo(f, Number(t)); else playFile(f);
    return;
  }
  if (act === 'go-root') { state.folderId = state.rootId; renderList(); return; }
  if (act === 'go-folder') { state.folderId = action.dataset.id; renderList(); $('#scroller').scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (act === 'index-run') { startIndexing(); return; }

  if (act === 'pl-new') {
    const name = prompt('새 재생목록 이름');
    if (!name?.trim()) return;
    personal.playlists.push({ id: 'pl_' + Date.now().toString(36), name: name.trim(), fileIds: [] });
    saveJSON(PERSONAL_KEY, personal);
    renderList();
    return;
  }
  if (act === 'pl-open') { state.openPlaylistId = action.dataset.id; renderList(); return; }
  if (act === 'pl-back') { state.openPlaylistId = null; renderList(); return; }
  if (act === 'pl-play') {
    const pl = personal.playlists.find((p) => p.id === state.openPlaylistId);
    const files = (pl?.fileIds || []).map(fileById).filter(Boolean);
    if (!files.length) { toast('재생할 곡이 없어요.'); return; }
    player.playFiles(files, 0);
    return;
  }
  if (act === 'pl-remove') {
    removeFromPlaylist(action.dataset.id);
    return;
  }
  if (act === 'pl-delete') {
    const pl = personal.playlists.find((p) => p.id === state.openPlaylistId);
    if (!pl || !confirm(`“${pl.name}” 재생목록을 삭제할까요?`)) return;
    personal.playlists = personal.playlists.filter((p) => p.id !== pl.id);
    saveJSON(PERSONAL_KEY, personal);
    state.openPlaylistId = null;
    renderList();
    return;
  }

  if (!card) return;
  const file = fileById(card.dataset.id);
  if (!file) return;

  if (state.selectMode && (act === 'open' || act === 'play')) {
    toggleSelect(file.id);
    return;
  }

  switch (act) {
    case 'play': {
      if (player.current?.id === file.id) player.toggle();
      else playFile(file);
      break;
    }
    case 'open': {
      if (player.current?.id === file.id) openNowPlaying();
      else playFile(file);
      break;
    }
    case 'more': {
      openMoreSheet(file, { playlist: state.view === 'playlists' && !!state.openPlaylistId });
      break;
    }
    case 'fav': {
      setFav(file.id, !isFav(file.id));
      renderList();
      renderSelectionBar();
      break;
    }
    case 'tag': openTagSheet(state.selectMode && state.selected.size ? [...state.selected] : file.id); break;
    case 'untag': {
      shared.removeTag(file.id, action.dataset.tag).then(() => { renderFilters(); renderList(); });
      break;
    }
    case 'memo': openMemoSheet(file); break;
    case 'lyrics': openLyricsSheet(file); break;
    case 'offline': toggleOffline(file); break;
    default: break;
  }
}

function toggleSelectMode() {
  state.selectMode = !state.selectMode;
  state.selected.clear();
  renderControlbar();
  renderSelectionBar();
  renderList();
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  const card = $(`#listArea .card[data-id="${CSS.escape(id)}"]`);
  if (card) {
    card.classList.toggle('is-selected', state.selected.has(id));
    const box = card.querySelector('.card-sel');
    if (box) box.innerHTML = state.selected.has(id) ? '<svg><use href="#i-check"/></svg>' : '';
  }
  renderSelectionBar();
}

function onSelAction(e) {
  const b = e.target.closest('[data-sel]');
  if (!b) return;
  const act = b.dataset.sel;
  const ids = [...state.selected];
  if (act === 'cancel') {
    state.selectMode = false;
    state.selected.clear();
    renderControlbar(); renderSelectionBar(); renderList();
    return;
  }
  if (!ids.length) return;
  if (act === 'tag') { openTagSheet(ids); return; }
  if (act === 'fav') {
    const allFav = ids.every(isFav);
    for (const id of ids) setFav(id, !allFav);
    toast(allFav ? '즐겨찾기를 해제했어요' : `${ids.length}개를 즐겨찾기에 담았어요`);
    renderList();
    return;
  }
  if (act === 'playlist') { openPlaylistPicker(ids); return; }
}

/* ─────────────────────────── boot ─────────────────────────── */
async function boot() {
  renderHeader();

  // a token held from this session lets us refresh without any popup
  if (settings.clientId) {
    try { drive.restore(); } catch {}
  }

  // 1) paint the last saved library first — no spinner, no demo flash
  const cached = loadTreeCache();
  const fromCache = !!(cached && cached.files?.length);
  if (fromCache) startFromCache(cached);
  else useDemo();

  bindEvents();
  initPlayer();
  restoreLast();
  watchCovers();

  // 2) offline markers and cached ID3 come from IndexedDB; repaint once known
  Promise.all([refreshOfflineIds(), primeCache()])
    .then(() => { if (fromCache) renderList(); })
    .catch(() => {});

  // 3) only a token we already hold may talk to Drive on its own.
  //    Anything else waits for the user's tap, so no login popup on launch.
  if (settings.clientId) {
    drive.loadGis().then(() => drive.client()).catch(() => {});
    if (drive.connected) {
      if (fromCache) syncQuietly();
      else loadLive({ interactive: false, silent: true }).catch(() => {});
    } else {
      renderHeader();
    }
  }

  if ('serviceWorker' in navigator) {
    const registerSw = () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); };
    if (document.readyState === 'complete') registerSw();
    else window.addEventListener('load', registerSw, { once: true });
  }
  window.__appReady = true;
}

function restoreLast() {
  const id = personal.lastFileId;
  if (!id) return;
  const f = fileById(id);
  if (!f) return;
  player.current = f;
  const t = $('#pTitle');
  if (t) t.textContent = displayName(f.name);
  const s = $('#pSub');
  if (s) s.textContent = [f.liver, f.year].filter(Boolean).join(' · ');
  loadParsed(f, { network: drive.connected }).then((p) => {
    const th = $('#pThumb');
    if (p?.coverUrl && th) th.innerHTML = `<img src="${p.coverUrl}" alt="" />`;
    const tt = $('#pTitle');
    if (p?.title && tt) tt.textContent = p.title;
  }).catch(() => {});
}

boot();
