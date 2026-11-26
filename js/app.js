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

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ─────────────────────────── state ─────────────────────────── */
const settings = Object.assign({ clientId: '', rootId: '' }, loadJSON(SETTINGS_KEY, {}));
const personal = Object.assign(
  { nickname: '게스트', favorites: {}, playlists: [], notesSeenAt: 0, lastFileId: null },
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
  selectMode: false,
  selected: new Set(),
  folderId: null,
  openPlaylistId: null,
  lyricsQuery: '',
  indexRunning: false,
  indexCancel: false,
  liveError: '',
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
    f.liver = path[0] || '기타';
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

async function loadLive({ interactive = false } = {}) {
  if (!settings.clientId) {
    toast('먼저 설정에서 OAuth Client ID를 입력해 주세요.', { err: true });
    return false;
  }
  state.loading = true;
  renderHeader();
  try {
    drive.setClientId(settings.clientId);
    if (!drive.connected) {
      // keep the token request inside the tap so Safari doesn't block the popup
      if (interactive && drive.tokenClient) await drive.requestToken();
      else await drive.ensure({ interactive });
    }

    if (!settings.rootId) {
      const found = await drive.findFolderByName('NIJI VOICE');
      const pick = found.find((f) => f.driveId) || found[0];
      if (!pick) throw new Error('드라이브에서 "NIJI VOICE" 폴더를 찾지 못했어요. 설정에서 폴더 ID를 직접 넣어 주세요.');
      settings.rootId = pick.id;
      saveJSON(SETTINGS_KEY, settings);
    }

    const tree = await drive.tree(settings.rootId, {
      onProgress: ({ done }) => { setConnText(`불러오는 중… (${done}개 폴더)`); },
    });
    const meta = new SharedMeta(drive, settings.rootId);
    meta.onError = (e) => toast(`공유 메모 저장 실패: ${e?.message || e}`, { err: true, ms: 4000 });
    await meta.load();
    shared = meta;
    state.mode = 'live';
    state.liveError = '';
    enrich(tree);
    state.folderId = tree.root.id;
    for (const f of DEMO_TREE.files) parsedCache.delete(f.id);
    await refreshOfflineIds();
    await primeCache();
    renderAll();
    toast(`${state.files.length}개 파일을 불러왔어요`);
    return true;
  } catch (e) {
    state.mode = state.files.length ? state.mode : 'demo';
    if (e instanceof NeedsAuth) {
      state.liveError = 'auth';
      if (interactive) showConnectError(e);
      else toast('Google 계정 연결이 필요해요.', { err: true });
    } else {
      state.liveError = e.message || 'Drive를 불러오지 못했어요.';
      if (interactive) showConnectError(e);
      else toast(state.liveError, { err: true });
    }
    renderHeader();
    return false;
  } finally {
    state.loading = false;
    renderHeader();
  }
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
  if (tag.size) list = list.filter((f) => { const ts = shared.tagsOf(f.id); return [...tag].every((t) => ts.includes(t)); });
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
  $('#nickLabel').textContent = personal.nickname || '게스트';
  const conn = $('#connState');
  conn.className = 'conn';
  if (state.loading) {
    conn.textContent = '불러오는 중…';
  } else if (state.mode === 'live') {
    conn.classList.add('is-live');
    conn.textContent = drive.connected ? 'Google Drive 연결됨' : '연결 확인 필요';
  } else if (settings.clientId) {
    conn.classList.add('is-off');
    conn.textContent = '데모 모드 · 다시 연결';
  } else {
    conn.textContent = '데모 모드 · 설정에서 연결';
  }
  $('#btnRefresh').classList.toggle('is-busy', state.loading);
}

function renderTabs() {
  for (const b of $$('#viewTabs .tab')) {
    const on = b.dataset.view === state.view;
    b.classList.toggle('is-on', on);
    if (b.dataset.view === 'notes') {
      const n = totalNewNotes();
      b.textContent = n ? `메모 모아보기 ${n}` : '메모 모아보기';
      b.classList.toggle('has-new', n > 0);
    }
  }
}

function renderFilters() {
  const years = [...new Set(state.files.map((f) => f.year).filter(Boolean))].sort().reverse();
  const livers = [...new Set(state.files.map((f) => f.liver))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  const tagCount = new Map();
  for (const f of state.files) for (const t of shared.tagsOf(f.id)) tagCount.set(t, (tagCount.get(t) || 0) + 1);
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
    const row = $(`#filters [data-f="${key}"]`);
    const chip = $('.fchip', row);
    const open = state.openFilters.has(key);
    row.classList.toggle('is-open', open);
    chip.classList.toggle('is-open', open);
    chip.classList.toggle('is-on', state.filters[key].size > 0);
    const badge = $('.fcount', chip);
    const n = state.filters[key].size;
    badge.hidden = !n;
    badge.textContent = n ? String(n) : '';
  }

  const total = state.filters.year.size + state.filters.liver.size + state.filters.tag.size;
  $('#btnClearFilters').hidden = !total;
  $('#btnClearFilters').textContent = total ? `필터 초기화 (${total}) ✕` : '필터 초기화 ✕';
}

function renderControlbar() {
  const on = state.selectMode;
  $('#btnSelectMode').classList.toggle('is-on', on);
  $('#btnSelectMode').querySelector('span:last-child').textContent = on ? '선택 해제' : '선택 모드';
  $('#sortLabel').textContent = state.sort === 'name' ? '이름순' : '최신순';
  $('#btnPlayAll').querySelector('span').textContent = state.view === 'folders' ? '이 폴더 재생' : '전체 재생';
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
  const tags = shared.tagsOf(f.id);
  const notes = shared.notesOf(f.id).length;
  const newN = newNotesFor(f.id);
  const lyrics = parsedCache.get(f.id);
  const saved = offlineIds.has(f.id);
  const showYear = f.year && f.year !== '';
  return `
  <article class="card ${playing ? 'is-playing' : ''} ${selected ? 'is-selected' : ''} ${state.selectMode ? 'is-selecting' : ''}" data-id="${esc(f.id)}">
    ${state.selectMode ? `<span class="card-sel">${selected ? '<svg><use href="#i-check"/></svg>' : ''}</span>` : ''}
    <button class="cbtn-play" data-act="play" aria-label="재생">
      <svg><use href="${playing && player?.isPlaying ? '#i-pause' : '#i-play'}"/></svg>
    </button>
    <div class="card-body" data-act="open">
      <div class="card-title-row">
        <span class="card-title">${esc(displayName(f.name))}</span>
      </div>
      <div class="card-badges">
        ${f.liver ? `<span class="badge">${esc(f.liver)}</span>` : ''}
        ${showYear ? `<span class="badge year">${esc(f.year)}</span>` : ''}
        ${tags.map((t) => `<span class="badge tag" data-act="untag" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}
        <button class="mini" data-act="tag"><svg><use href="#i-tag"/></svg>태그</button>
        <button class="mini ${notes ? 'has-content' : ''}" data-act="memo"><svg><use href="#i-memo"/></svg>${notes ? `메모 ${notes}` : '메모'}${newN ? '<span class="ndot"></span>' : ''}</button>
        <button class="mini ${lyrics?.lyrics?.length ? 'has-content' : ''}" data-act="lyrics"><svg><use href="#i-lyrics"/></svg>자막</button>
        ${newN ? `<span class="newbadge">NEW ${newN}</span>` : ''}
      </div>
    </div>
    <div class="card-side">
      <button class="star ${isFav(f.id) ? 'is-on' : ''}" data-act="fav" aria-label="즐겨찾기">
        <svg><use href="${isFav(f.id) ? '#i-star-fill' : '#i-star'}"/></svg>
      </button>
      <span class="card-size">${fmtBytes(f.size)}</span>
      <button class="offbtn ${saved ? 'is-saved' : ''}" data-act="offline" title="${saved ? '오프라인 저장됨 — 눌러서 삭제' : '오프라인 저장'}" aria-label="오프라인 저장">
        <svg><use href="${saved ? '#i-check' : '#i-download'}"/></svg>
      </button>
    </div>
  </article>`;
}

function listHead(text) {
  return `<div class="listhead"><span>${text}</span></div>`;
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
        area.innerHTML = emptyHTML({
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

  area.innerHTML = listHead(`${files.length}개 파일`) + files.map((f) => cardHTML(f)).join('');
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
      ${files.length ? files.map((f) => `
        <div class="pl-item" data-id="${esc(f.id)}">
          ${cardHTML(f, { playlist: true })}
          <button class="pl-remove" data-act="pl-remove" data-id="${esc(f.id)}">빼기</button>
        </div>`).join('')
        : emptyHTML({ icon: '🎵', title: '아직 곡이 없어요', desc: '파일 카드에서 재생목록에 추가할 수 있어요.' })}
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

function renderFolders() {
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

  area.innerHTML = crumbHTML + folderHTML + (files.length ? files.map((f) => cardHTML(f)).join('') : '')
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
  bar.classList.toggle('is-empty', !cur);

  if (!cur) {
    $('#pTitle').textContent = '재생 중인 파일 없음';
    $('#pSub').textContent = '전체 재생을 눌러 시작해 보세요';
    $('#pThumb').innerHTML = '<svg><use href="#i-mic"/></svg>';
    $('#tCur').textContent = '00:00';
    $('#tDur').textContent = '-00:00';
    setSeek(0, 0, true);
  } else {
    const p = parsedCache.get(cur.id) || (cur.demo ? demoParsed(cur) : null) || {};
    $('#pTitle').textContent = p.title || displayName(cur.name);
    const bits = [];
    if (p.artist) bits.push(p.artist);
    if (st.queueLength > 1) bits.push(`${player.queue.findIndex((f) => f.id === cur.id) + 1}/${st.queueLength}`);
    $('#pSub').textContent = bits.join(' · ') || cur.liver || '';
    $('#pThumb').innerHTML = p.coverUrl ? `<img src="${p.coverUrl}" alt="" />` : '<svg><use href="#i-mic"/></svg>';
    $('#tCur').textContent = fmtTime(st.currentTime);
    const dur = st.duration || p.duration || shared.data.durations?.[cur.id] || 0;
    $('#tDur').textContent = dur ? '-' + fmtTime(Math.max(0, dur - st.currentTime)) : '-00:00';
    setSeek(st.currentTime, dur || 0, false);
    if (dur > 0 && shared && st.duration > 0 && Math.abs((shared.data.durations?.[cur.id] || 0) - st.duration) > 1) {
      shared.setDuration?.(cur.id, st.duration);
    }
  }

  $('#btnPlay').innerHTML = `<svg><use href="${st.isPlaying ? '#i-pause' : '#i-play'}"/></svg>`;
  $('#btnShuffle').classList.toggle('is-on', !!st.shuffle);
  $('#btnAB').classList.toggle('is-set', st.ab.a != null);

  $('#pFlags').innerHTML = [
    st.loading ? '<span class="pflag">불러오는 중…</span>' : '',
    st.ab.a != null ? `<span class="pflag">A–B ${fmtTime(st.ab.a)} ~ ${st.ab.b != null ? fmtTime(st.ab.b) : '…'}<button data-act="ab-clear">✕</button></span>` : '',
    st.sleep.mode ? `<span class="pflag timer">${st.sleep.mode === 'track' ? '트랙 끝나면 정지' : '취침 ' + fmtLeft(st.sleep.endsAt)}<button data-act="sleep-clear">✕</button></span>` : '',
    cur && offlineIds.has(cur.id) ? '<span class="pflag">오프라인</span>' : '',
  ].join('');

  // live lyric highlight in the now-playing sheet
  if (ui.sheet === 'now' && cur) updateNowLyric(st.currentTime);
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
  const el = $('#seek');
  const pct = dur > 0 ? Math.min(100, (t / dur) * 100) : 0;
  if (!dragging || apply) el.value = String(dur > 0 ? Math.round((t / dur) * 1000) : 0);
  el.style.setProperty('--pct', `${pct}%`);
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
const ui = { sheet: null, lyricIdx: -1, sheetFile: null };

function openSheet(title, html, { tall = false } = {}) {
  $('#sheetTitle').textContent = title;
  // replace the body node so listeners from the previous sheet are dropped
  const old = $('#sheetBody');
  const body = document.createElement('div');
  body.className = 'sheet-body';
  body.id = 'sheetBody';
  old.replaceWith(body);
  body.innerHTML = html;
  $('#sheet').classList.toggle('is-tall', tall);
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
  const connected = state.mode === 'live';
  const body = openSheet('설정', `
    <div class="field">
      <label>연결 상태</label>
      <div class="indexbar" style="margin:0">
        <span style="flex:1 1 auto">${connected ? 'Google Drive 연결됨' : (settings.clientId ? '데모 모드 (연결 대기)' : '데모 모드')}</span>
        <button class="mini ${connected ? '' : 'has-content'}" data-act="connect">${connected ? '다시 연결' : '연결하기'}</button>
      </div>
      <p class="hint">${connected ? `${esc(state.files.length)}개 파일 · ${esc(state.folders.length)}개 폴더` : '연결하면 실제 드라이브의 NIJI VOICE 폴더를 불러옵니다.'}</p>
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
    if (el) el.textContent = `${u.count}곡 · ${fmtBytes(u.bytes)}`;
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
  const allTags = new Set();
  for (const f of state.files) for (const t of shared.tagsOf(f.id)) allTags.add(t);

  const body = openSheet(ids.length > 1 ? `${ids.length}개 파일에 태그` : '태그', `
    ${ids.length === 1 ? `<div class="note" style="margin-bottom:6px">${esc(displayName(fileById(ids[0])?.name || ''))}</div>` : ''}
    <div class="taglist">
      ${[...existing].map((t) => `<span class="tagpill">#${esc(t)}<button data-act="rm-tag" data-tag="${esc(t)}"><svg><use href="#i-close"/></svg></button></span>`).join('') || '<span class="note">아직 태그가 없어요.</span>'}
    </div>
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

/* subtitles */
function openLyricsSheet(file) {
  ui.sheet = 'lyrics';
  const rec = parsedCache.get(file.id);
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

/* now playing */
function openNowPlaying() {
  if (!player?.current) { toast('재생 중인 곡이 없어요'); return; }
  const file = player.current;
  const p = parsedCache.get(file.id) || (file.demo ? demoParsed(file) : {}) || {};
  const tags = shared.tagsOf(file.id);
  const notes = shared.notesOf(file.id);
  ui.sheet = 'now';
  ui.sheetFile = file.id;
  ui.lyricIdx = -1;
  const body = openSheet('지금 재생 중', `
    <div class="np">
      <div class="np-cover" id="npCover">${p.coverUrl ? `<img src="${p.coverUrl}" alt="" />` : '<svg><use href="#i-mic"/></svg>'}</div>
      <div class="np-title">${esc(p.title || displayName(file.name))}</div>
      <div class="np-sub">${esc([p.artist, p.album].filter(Boolean).join(' · ') || file.liver || '')}</div>
      ${tags.length ? `<div class="np-tags">${tags.map((t) => `<span class="badge tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="chiprow" style="justify-content:center;margin:2px 0 0">
        <button class="chip" data-act="np-tag">+ 태그</button>
        <button class="chip" data-act="np-memo">💬 메모 ${notes.length || ''}</button>
        <button class="chip" data-act="np-sub">자막</button>
        <button class="chip" data-act="np-offline">${offlineIds.has(file.id) ? '오프라인 저장됨' : '오프라인 저장'}</button>
      </div>
    </div>
    ${p.lyrics?.length ? `<div class="lyrics" id="sheetLyrics">${p.lyrics.map((l, i) => `
      <button class="lrc-line" data-act="seek" data-t="${l.time}" data-i="${i}">
        <span class="orig">${esc(l.orig)}</span>${l.trans ? `<span class="trans">${esc(l.trans)}</span>` : ''}
      </button>`).join('')}</div>` : `<div class="lrc-empty">${p.plainLyrics ? esc(p.plainLyrics) : '이 곡에는 자막이 없어요.'}</div>`}
    <div class="field" style="margin-top:10px">
      <label>이 곡의 메모</label>
      ${notes.length ? notes.map((n) => `<div class="memo"><button class="memo-time" data-act="seek" data-t="${n.t ?? 0}">${n.t != null ? fmtTime(n.t) : '전체'}</button>
        <div class="memo-body"><div class="memo-text">${esc(n.text)}</div><div class="memo-meta">${esc(n.author)} · ${esc(fmtDate(n.createdAt))} ${isNewNote(n) ? '<span class="newbadge">NEW</span>' : ''}</div></div></div>`).join('')
        : '<div class="note">아직 메모가 없어요.</div>'}
    </div>
  `, { tall: true });

  updateNowLyric(player.audio.currentTime || 0);

  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'seek') { player.seek(Number(b.dataset.t)); if (!player.isPlaying) player.toggle(); }
    if (act === 'np-tag') openTagSheet(file.id);
    if (act === 'np-memo') openMemoSheet(file);
    if (act === 'np-sub') openLyricsSheet(file);
    if (act === 'np-offline') toggleOffline(file);
  });
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
      if (state.openFilters.has(key)) state.openFilters.delete(key); else state.openFilters.add(key);
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
    if (state.mode === 'demo' && !settings.clientId) { toast('데모 모드예요. 설정에서 연결하면 실제 드라이브를 불러와요.'); return; }
    await refresh(true);
  });

  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnNick').addEventListener('click', openNickname);
  $('#connState').addEventListener('click', openSettings);

  $('#btnSelectMode').addEventListener('click', () => {
    state.selectMode = !state.selectMode;
    state.selected.clear();
    renderControlbar();
    renderSelectionBar();
    renderList();
  });

  $('#btnPlayAll').addEventListener('click', () => {
    let files = visibleFiles();
    if (state.view === 'folders') files = state.files.filter((f) => f.parentId === (state.folderId || state.rootId));
    if (!files.length) { toast('재생할 파일이 없어요.'); return; }
    player.playFiles(files, 0);
    toast(`${files.length}곡 재생 시작`);
  });

  $('#btnSort').addEventListener('click', () => {
    state.sort = state.sort === 'recent' ? 'name' : 'recent';
    renderControlbar();
    renderList();
  });

  $('#listArea').addEventListener('click', onListClick);
  $('#selBar').addEventListener('click', onSelAction);

  /* player */
  $('#btnPlay').addEventListener('click', () => {
    if (!player.current) {
      const files = visibleFiles();
      if (files.length) player.playFiles(files, 0);
      else toast('재생할 파일이 없어요.');
      return;
    }
    if (!player.loaded) { playFile(player.current); return; }
    player.toggle();
  });
  $('#btnPrev').addEventListener('click', () => player.prev());
  $('#btnNext').addEventListener('click', () => player.next());
  $('#btnShuffle').addEventListener('click', () => { player.setShuffle(!player.shuffle); toast(player.shuffle ? '셔플 켜짐' : '셔플 꺼짐'); });
  $('#btnAB').addEventListener('click', () => {
    if (!player.current) { toast('먼저 곡을 재생해 주세요.'); return; }
    const r = player.cycleAB();
    if (r.step === 'a') toast(`A 지점 ${fmtTime(r.t)} — 끝 지점에서 한 번 더 누르세요`);
    else if (r.step === 'b') toast(`A–B 반복 ${fmtTime(player.ab.a)} ~ ${fmtTime(player.ab.b)}`);
    else toast('A–B 반복을 해제했어요');
  });
  $('#btnLyrics').addEventListener('click', () => { if (player.current) openLyricsSheet(player.current); else toast('재생 중인 곡이 없어요'); });
  $('#btnTimer').addEventListener('click', openSleep);
  $('#btnMemo').addEventListener('click', () => { if (player.current) openMemoSheet(player.current); else toast('재생 중인 곡이 없어요'); });
  $('#btnQueue').addEventListener('click', openQueue);
  $('#btnNow').addEventListener('click', openNowPlaying);
  $('#pFlags').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'ab-clear') { player.clearAB(); toast('A–B 반복을 해제했어요'); }
    if (b.dataset.act === 'sleep-clear') { player.clearSleep(); toast('타이머를 해제했어요'); }
  });

  const seek = $('#seek');
  seek.addEventListener('input', () => {
    dragging = true;
    const dur = player.audio.duration || 0;
    if (dur) $('#tCur').textContent = fmtTime((Number(seek.value) / 1000) * dur);
  });
  seek.addEventListener('change', () => {
    const dur = player.audio.duration || 0;
    if (dur) player.seek((Number(seek.value) / 1000) * dur);
    dragging = false;
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
    $('#scroller');
    $('.hdr').classList.toggle('is-scrolled', $('#scroller').scrollTop > 4);
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.mode === 'live' && shared?.modifiedTime && Date.now() - lastMetaRefresh > 120000) {
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
  try {
    await shared.load();
    lastMetaRefresh = Date.now();
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
      onProgress: ({ done }) => setConnText(`불러오는 중… (${done})`),
    });
    await shared.load();
    lastMetaRefresh = Date.now();
    enrich(tree);
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
    const pl = personal.playlists.find((p) => p.id === state.openPlaylistId);
    if (!pl) return;
    pl.fileIds = pl.fileIds.filter((id) => id !== action.dataset.id);
    saveJSON(PERSONAL_KEY, personal);
    renderList();
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

  if (state.selectMode && act === 'open') {
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
  await refreshOfflineIds();
  useDemo();
  bindEvents();
  initPlayer();
  restoreLast();

  if (settings.clientId) {
    // warm up Google Identity Services so the connect tap can open the popup synchronously
    drive.loadGis().then(() => drive.client()).catch(() => {});
    drive.restore();
    loadLive({ interactive: false }).catch(() => {});
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
  window.__appReady = true;
}

function restoreLast() {
  const id = personal.lastFileId;
  if (!id) return;
  const f = fileById(id);
  if (!f) return;
  player.current = f;
  $('#pTitle').textContent = displayName(f.name);
  $('#pSub').textContent = [f.liver, f.year].filter(Boolean).join(' · ');
  loadParsed(f).then((p) => {
    if (p?.coverUrl) $('#pThumb').innerHTML = `<img src="${p.coverUrl}" alt="" />`;
    if (p?.title) $('#pTitle').textContent = p.title;
  }).catch(() => {});
}

boot();
