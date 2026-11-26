/**
 * NIJI VOICE — app shell, views and wiring.
 */
import { Drive, SharedMeta, NeedsAuth, META_NAME } from './drive.js';
import { parseId3 } from './id3.js';
import { Player, fmtTime } from './player.js';
import * as db from './db.js';

/* ─────────────────────────── helpers ─────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SETTINGS_KEY = 'niji.settings';
const PERSONAL_KEY = 'niji.personal';

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

/** stable key for "same series" cover sharing (path/name only, no ID3) */
function exVariantOf(...sources) {
  for (const s of sources) {
    if (!s) continue;
    if (/ex[\s_\-]*another/i.test(s)) return 'EX Another';
    if (/(^|[^a-z0-9])ex([^a-z0-9]|$)/i.test(s)) return 'EX';
  }
  return '';
}

const normTxt = (v) => String(v || '').toLowerCase().replace(/[_\-.\s()\[\]]/g, '');

/** Human title: ID3 title first, else a cleaned file name; "라이버 - 시리즈 (EX)" when both are known. */
function displayTitleOf(f, { short = false } = {}) {
  if (!f) return '';
  const p = parsedCache.get(f.id);
  const id3 = (p?.title || '').trim();
  const fileBase = displayName(f.name || '');
  const src = id3 || fileBase;
  const liverShort = (f.liver || '').replace(/\s*\([^)]*\)\s*$/, '');
  const series = seriesNameOf(f);
  const ex = exVariantOf(id3, fileBase);

  const partMatch = fileBase.match(/(track|scene|episode|ep|vol)\s*\.?\s*(\d+)/i);
  let part = '';
  if (partMatch) {
    const kind = partMatch[1].toLowerCase();
    part = `${kind === 'episode' ? 'ep' : kind} ${partMatch[2]}`;
  }

  if (series && normTxt(src).includes(normTxt(series))) {
    const base = (liverShort && !short) ? `${liverShort} - ${series}` : series;
    const liverCore = liverShort.replace(/\s+/g, '');
    const liverRe = liverCore
      ? new RegExp(liverCore.split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'gi')
      : null;
    let rest = src;
    if (liverRe) rest = rest.replace(liverRe, ' ');
    const hadSeries = rest.indexOf(series) >= 0;
    if (hadSeries) rest = rest.split(series).join(' ');
    rest = rest
      .replace(/ex[\s_-]*another/gi, ' ')
      .replace(/(^|[^a-z0-9])ex([^a-z0-9]|$)/gi, ' ')
      .replace(/[()\[\]]/g, ' ')
      .replace(/[_.]/g, ' ')
      .replace(/^[\s\u2014\u2013\-·:]+/, '')
      .replace(/^\s*\d{1,3}[\s._-]+/, '')
      .replace(/^[\s\u2014\u2013\-·:]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (/^\d{1,3}$/.test(rest)) rest = '';
    if (!hadSeries) rest = part;
    const bits = [];
    if (rest) bits.push(rest);
    if (ex) bits.push(ex);
    return bits.length ? `${base} (${bits.join(', ')})` : base;
  }

  let s = src
    .replace(/^\s*track\s*\d+\s*[_.\-\s]*/i, '')
    .replace(/^\s*\d{1,3}\s*[_.\-\s]+/, '')
    .replace(/[()]\s*(ex|ex another)\s*[()]/gi, ' ')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (liverShort) s = s.split(liverShort).join(' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(19|20)\d{2}\s*/, '').replace(/\s+/g, ' ').trim();
  if (!s) s = src;
  return ex ? `${s} (${ex})` : s;
}

/**
 * 트랙 번호 — 파일명이나 ID3 제목 앞에 붙은 01·1_ 같은 숫자를 그대로 읽는다.
 * 같은 시리즈 안에서 그 숫자가 없으면 순서로 채워 넣는다.
 */
function trackNoOf(f) {
  if (!f) return '';
  const p = parsedCache.get(f.id);
  const sources = [displayName(f.name || ''), (p?.title || '').trim()];
  for (const src of sources) {
    const m = String(src || '').match(/^\s*(?:track\s*\.?\s*)?(\d{1,3})(?![\d])\s*(?:[_\-.\s)\]])/i);
    if (m) return m[1].padStart(2, '0');
  }
  const m2 = String(sources[0] || '').match(/(?:track|tr|no)\.?\s*(\d{1,3})/i);
  if (m2) return m2[1].padStart(2, '0');
  return '';
}

/** 시리즈 안에서의 순번까지 붙인 목록 — 전체 리스트에서 몇 번째인지 알 수 있게 */
function withTrackNos(files) {
  const groups = new Map();
  for (const f of files) {
    const key = seriesKeyOf(f) || f.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const out = new Map();
  for (const list of groups.values()) {
    list.forEach((f, i) => {
      const own = trackNoOf(f);
      out.set(f.id, own || String(i + 1).padStart(2, '0'));
    });
  }
  return out;
}

const trackNoCache = new Map();

function trackNoFor(f) {
  if (trackNoCache.has(f.id)) return trackNoCache.get(f.id);
  return trackNoOf(f);
}

function rebuildTrackNos(files) {
  trackNoCache.clear();
  for (const [id, n] of withTrackNos(files)) trackNoCache.set(id, n);
}

function seriesKeyOf(f) {
  if (!f) return '';
  const liverShort = (f.liver || '').replace(/\s*\([^)]*\)\s*$/, '');
  const opts = { liverShort, liver: f.liver || '' };
  const sources = [...(f.path || []).slice(1).reverse(), displayName(f.name || '')];
  let name = '';
  for (const source of sources) {
    const n = cleanSeriesName(source, opts);
    if (n && n !== liverShort && n !== f.year) { name = n; break; }
  }
  return `${f.liver || ''}|${f.year || ''}|${name || displayName(f.name)}`;
}

/* ── 폴더 커버 이미지 id 지도 — 한 번 찾으면 저장해 두고, 다음 실행부터는 조회 없이 바로 쓴다 ── */
let folderCoverMap = null;
const folderCoverMapKey = () => `niji.covermap.${settings.rootId || 'default'}`;
function coverMap() {
  if (!folderCoverMap) folderCoverMap = new Map(Object.entries(loadJSON(folderCoverMapKey(), {})));
  return folderCoverMap;
}
const folderCoverMissKey = () => `niji.covermiss.v2.${settings.rootId || 'default'}`;
let folderCoverMiss = null;
function coverMiss() {
  if (!folderCoverMiss) folderCoverMiss = new Set(loadJSON(folderCoverMissKey(), []));
  return folderCoverMiss;
}
function rememberFolderMiss(folderId) {
  if (!folderId) return;
  const m = coverMiss();
  if (m.has(folderId)) return;
  m.add(folderId);
  try { saveJSON(folderCoverMissKey(), [...m].slice(-4000)); } catch {}
}

function rememberFolderCover(folderId, imageId) {
  if (!folderId || !imageId) return;
  const m = coverMap();
  if (m.get(folderId) === imageId) return;
  m.set(folderId, imageId);
  try { saveJSON(folderCoverMapKey(), Object.fromEntries(m)); } catch {}
}

/* series-level cover cache: one fetch per series, shared by its tracks */
const seriesCover = new Map();      // seriesKey -> { thumb, full }
const seriesPending = new Set();    // seriesKey being fetched

function coverInfoFor(f) {
  if (!f) return null;
  const p = parsedCache.get(f.id);
  if (p?.thumb || p?.coverUrl) return { thumb: p.thumb || p.coverUrl, full: p.coverUrl || p.thumb };
  const s = seriesCover.get(seriesKeyOf(f));
  if (s) return s;
  return null;
}

function rememberSeriesCover(f, info) {
  if (!f || !info) return;
  const key = seriesKeyOf(f);
  const prev = seriesCover.get(key);
  if (!prev || (!prev.full && info.full)) seriesCover.set(key, info);
}

/** series / album name derived from album → folders → file name */
function seriesNameOf(f) {
  if (!f) return '';
  const album = parsedCache.get(f.id)?.album || '';
  const liverShort = (f.liver || '').replace(/\s*\([^)]*\)\s*$/, '');
  const opts = { liverShort, liver: f.liver || '' };
  const sources = [album, ...(f.path || []).slice(1).reverse(), displayName(f.name || '')];
  for (const source of sources) {
    const name = cleanSeriesName(source, opts);
    if (name && name !== liverShort && name !== f.year) return name;
  }
  return '';
}

function autoTagsOf(f) {
  if (!f) return [];
  const album = parsedCache.get(f.id)?.album || '';
  const key = `${album}|${f.name}|${f.liver}|${(f.path || []).join('/')}`;
  const hit = autoTagCache.get(f.id);
  if (hit && hit.key === key) return hit.tags;

  const nameBase = displayName(f.name || '');
  const tags = [];
  const series = seriesNameOf(f);
  if (series) tags.push(series);
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

const TREE_CACHE_V = 5;

/* ── offline-first cache (instant start) ── */
const treeCacheKey = (rootId) => `niji.tree.${rootId || 'default'}`;
const metaCacheKey = (rootId) => `niji.meta.${rootId || 'default'}`;

function saveTreeCache(tree) {
  if (!tree?.root?.id) return;
  try {
    localStorage.setItem(treeCacheKey(settings.rootId || tree.root.id), JSON.stringify({
      savedAt: Date.now(),
      v: TREE_CACHE_V,
      root: tree.root,
      folders: tree.folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, driveId: f.driveId || null })),
      files: tree.files.map((f) => ({
        id: f.id, name: f.name, size: f.size || 0,
        createdTime: f.createdTime, modifiedTime: f.modifiedTime,
        parentId: f.parentId, driveId: f.driveId || null,
        folderCover: f.folderCover || null,
        folderCoverId: f.folderCoverId || null,
      })),
    }));
  } catch {}
}

/** a cache written before folder covers existed — re-list so covers appear */
function cacheMissingCovers(data) {
  return Array.isArray(data?.files) && data.files.length > 0
    && data.files.some((f) => !Object.prototype.hasOwnProperty.call(f, 'folderCoverId'));
}

function loadTreeCache(rootId) {
  const want = rootId || settings.rootId;
  try {
    if (want) {
      const raw = localStorage.getItem(treeCacheKey(want));
      const data = raw ? JSON.parse(raw) : null;
      if (cacheMissingCovers(data) || data?.v !== TREE_CACHE_V) return null;
      return data?.root?.id && Array.isArray(data.files) ? data : null;
    }
    const best = newestCache('niji.tree.');
    if (cacheMissingCovers(best) || best?.v !== TREE_CACHE_V) return null;
    return best?.root?.id && Array.isArray(best.files) ? best : null;
  } catch { return null; }
}

function saveMetaCache(data) {
  if (!data) return;
  try {
    localStorage.setItem(metaCacheKey(settings.rootId), JSON.stringify({ savedAt: Date.now(), data: { ...data, v: TREE_CACHE_V } }));
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
  mode: 'live',
  loading: false,
  rootId: null,
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
  collectionAxis: 'liver',
  openTheme: null,
  openSeries: null,
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

  const cmap = coverMap();
  for (const f of state.files) {
    const path = pathOf(f.parentId);
    f.path = path;
    if (!f.folderCoverId && cmap.has(f.parentId)) f.folderCoverId = cmap.get(f.parentId);
    f.liver = (path[0] || '기타').replace(/^\d{1,2}[_\s\-]+/, '');
    const yearFolder = [...path].reverse().find((n) => /(19|20)\d{2}/.test(n));
    const ym = yearFolder ? yearFolder.match(/(19|20)\d{2}/) : null;
    f.year = ym ? ym[0] : '';
  }
}

/** no library yet: an empty library plus the connect prompt */
/** 목록 캐시가 없어도 오프라인 저장분만으로 화면을 먼저 그린다 */
function startFromOffline() {
  state.mode = 'live';
  state.fromCache = false;
  state.cachedAt = 0;
  shared = new SharedMeta(drive, settings.rootId || '');
  shared.onError = (e) => toast(`공유 메모 저장 실패: ${e?.message || e}`, { err: true, ms: 4000 });
  showDisconnected();
}

function showDisconnected() {
  state.mode = 'live';
  state.files = [];
  state.folders = [];
  state.folderMap = new Map();
  state.folderId = null;
  state.openSeries = null;
  shared = new SharedMeta(drive, settings.rootId || '');
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
    await refreshOfflineIds();
    await primeCache();
    await mergeOfflineIntoLibrary();
    renderAll();
    lastMetaRefresh = Date.now();
    if (!silent) toast(`${state.files.length}개 파일을 불러왔어요`);
    return true;
  } catch (e) {
    state.mode = 'live';
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
    if (!state.files.length) {
      const offline = await offlineLibrary();
      if (offline.length) { state.files = offline; renderAll(); }
    }
    renderHeader();
  } finally {
    state.syncing = false;
  }
}

function treeSignature() {
  const s = state.folders.map((f) => `${f.id}:${f.name}`).join(',') + '#'
    + state.files.map((f) => `${f.id}:${f.name}:${f.modifiedTime || ''}:${f.parentId}:${f.folderCover ? 1 : 0}`).join(',');
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

/** 오프라인 기록에 남겨 둘 목록 정보 — 드라이브 없이도 목록을 그릴 수 있게 */
function offlineMetaOf(f) {
  return {
    id: f.id, name: f.name, size: f.size || 0,
    parentId: f.parentId || null, driveId: f.driveId || null,
    createdTime: f.createdTime || '', modifiedTime: f.modifiedTime || '',
    path: Array.isArray(f.path) ? f.path : [],
    liver: f.liver || '', year: f.year || '', seriesKey: f.seriesKey || '',
  };
}

/** IndexedDB에 저장된 오프라인 보이스만으로 라이브러리를 복원한다 */
async function offlineLibrary() {
  let rows = [];
  try { rows = await db.all('audio'); } catch { return []; }
  const out = [];
  for (const r of rows) {
    const id = r?.fileId || r?.id;
    if (!id) continue;
    const known = state.files.find((f) => f.id === id);
    const base = r.meta || (known ? offlineMetaOf(known) : { id, name: r.name || id, path: [] });
    out.push({ ...base, id, name: base.name || r.name || id, path: base.path || known?.path || [], offline: true });
  }
  return out;
}

/** 목록 어디에도 없는 오프라인 보이스를 라이브러리에 붙인다 */
async function mergeOfflineIntoLibrary() {
  const extra = (await offlineLibrary()).filter((f) => !state.files.some((x) => x.id === f.id));
  if (!extra.length) return false;
  state.files = [...extra, ...state.files];
  renderList();
  return true;
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
  if (q) {
    list = list.filter((f) => {
      const hay = [displayName(f.name || ''), f.liver || '', seriesNameOf(f), tagsOf(f).join(' ')]
        .join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  const { year, liver, tag } = state.filters;
  if (year.size) list = list.filter((f) => f.year && year.has(f.year));
  if (liver.size) list = list.filter((f) => liver.has(f.liver));
  if (tag.size) list = list.filter((f) => { const ts = tagsOf(f); return [...tag].every((t) => ts.includes(t)); });
  if (state.offlineOnly) list = list.filter((f) => offlineIds.has(f.id));
  list = list.slice();
  if (state.sort === 'name') {
    // 화면에 보이는 제목 기준 — 숫자는 2 < 10 으로, 같은 시리즈 안은 트랙 번호 순
    list.sort((a, b) => {
      const c = displayTitleOf(a).localeCompare(displayTitleOf(b), 'ko', { numeric: true, sensitivity: 'base' });
      if (c) return c;
      const na = trackNoOf(a), nb = trackNoOf(b);
      if (na && nb) return na.localeCompare(nb, 'ko', { numeric: true });
      return displayName(a.name).localeCompare(displayName(b.name), 'ko', { numeric: true });
    });
  }
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

function filterFacets() {
  const years = [...new Set(state.files.map((f) => f.year).filter(Boolean))].sort().reverse();
  const livers = [...new Set(state.files.map((f) => f.liver).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  const tagCount = new Map();
  for (const f of state.files) for (const t of tagsOf(f)) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const tags = [...tagCount.entries()]
    .filter(([t]) => !/^(19|20)\d{2}$/.test(t))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))
    .slice(0, 80);
  return {
    years: years.map((y) => [y, state.files.filter((f) => f.year === y).length]),
    livers: livers.map((l) => [l, state.files.filter((f) => f.liver === l).length]),
    tags,
  };
}

function renderFilters() {
  const total = state.filters.year.size + state.filters.liver.size + state.filters.tag.size;
  const ft = $('#btnFilterToggle');
  if (ft) ft.classList.toggle('is-on', total > 0);
  const fc = $('#filterCount');
  if (fc) { fc.hidden = !total; fc.textContent = total ? String(total) : ''; }
}

function filterDraftCount(draft) {
  return state.files.filter((f) => {
    if (draft.year.size && !(f.year && draft.year.has(f.year))) return false;
    if (draft.liver.size && !draft.liver.has(f.liver)) return false;
    if (draft.tag.size) {
      const ts = tagsOf(f);
      if (![...draft.tag].every((t) => ts.includes(t))) return false;
    }
    return true;
  }).length;
}

function openFilterSheet() {
  ui.sheet = 'filter';
  const draft = {
    year: new Set(state.filters.year),
    liver: new Set(state.filters.liver),
    tag: new Set(state.filters.tag),
  };
  const facets = filterFacets();
  const chipRow = (key, items, labelFn) => items.map(([val, n]) => `
    <button type="button" class="chip ${draft[key].has(val) ? 'is-on' : ''}" data-fkey="${key}" data-fval="${esc(val)}">${labelFn(val)}<span class="chip-n">${n}</span></button>`).join('');

  const body = openSheet('필터', `
    <div class="fgroup">
      <div class="flabel">연도</div>
      <div class="chiprow">${chipRow('year', facets.years, (v) => esc(v)) || '<span class="note">연도 폴더가 없어요.</span>'}</div>
    </div>
    <div class="fgroup">
      <div class="flabel">라이버</div>
      <div class="chiprow">${chipRow('liver', facets.livers, (v) => esc(v)) || '<span class="note">라이버 폴더가 없어요.</span>'}</div>
    </div>
    <div class="fgroup">
      <div class="flabel">태그</div>
      <div class="chiprow">${chipRow('tag', facets.tags, (v) => `#${esc(v)}`) || '<span class="note">아직 태그가 없어요.</span>'}</div>
    </div>
    <div class="fsheet-foot">
      <div class="fhint" id="fHint">${filterDraftCount(draft)}개 보이스</div>
      <div class="btnrow" style="margin:0">
        <button type="button" class="btn-secondary" data-act="f-reset">초기화</button>
        <button type="button" class="btn-primary" data-act="f-apply">적용</button>
      </div>
    </div>
  `, { tall: true });

  const hint = () => {
    const el = $('#fHint');
    if (el) el.textContent = `${filterDraftCount(draft)}개 보이스`;
  };

  body.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-fkey]');
    if (chip) {
      const key = chip.dataset.fkey;
      const val = chip.dataset.fval;
      if (draft[key].has(val)) draft[key].delete(val); else draft[key].add(val);
      chip.classList.toggle('is-on', draft[key].has(val));
      hint();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'f-reset') {
      draft.year.clear(); draft.liver.clear(); draft.tag.clear();
      for (const el of $$('#sheetBody .chip[data-fkey]')) el.classList.remove('is-on');
      state.filters.year.clear(); state.filters.liver.clear(); state.filters.tag.clear();
      renderFilters();
      renderList();
      hint();
      return;
    }
    if (b.dataset.act === 'f-apply') {
      state.filters.year = new Set(draft.year);
      state.filters.liver = new Set(draft.liver);
      state.filters.tag = new Set(draft.tag);
      closeSheet();
      renderFilters();
      renderList();
      const total = draft.year.size + draft.liver.size + draft.tag.size;
      if (total) toast(`필터 ${total}개를 적용했어요`);
    }
  });
}

function renderControlbar() {
  const ft = $('#btnFilterToggle');
  if (ft) ft.hidden = state.view === 'folders';
  const play = $('#btnPlayAll');
  if (play) play.querySelector('span').textContent = (state.view === 'all' && state.folderMode === 'tree') ? '이 폴더 재생' : '전체 재생';
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
  const cover = coverInfoFor(f)?.thumb || '';

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
      <div class="card-title"><span class="trk">${esc(trackNoFor(f))}</span>${esc(displayTitleOf(f, { short: true }))}</div>
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
  renderListInner();
  queueVisibleCovers();
}

function renderListInner() {
  rebuildTrackNos(state.files);
  const area = $('#listArea');
  const foot = $('#listFoot');
  foot.innerHTML = '';
  renderTabs();

  if (state.view === 'playlists') return renderPlaylists();
  if (state.view === 'folders') return renderCollection();
  if (state.view === 'all' && state.folderMode === 'tree') return renderFolders();
  if (state.view === 'notes') return renderNotes();
  if (state.view === 'lyrics') return renderLyricsView();

  let files;
  if (state.view === 'fav') {
    state.view = 'playlists';
    state.openPlaylistId = 'fav';
    return renderPlaylists();
  }
  {
    files = visibleFiles();
    if (!files.length) {
      if (!state.files.length) {
        area.innerHTML = emptyHTML({
            icon: '📂', title: '이 폴더에는 오디오 파일이 없어요',
            desc: '연결된 폴더에 mp3 파일이 있는지 확인해 주세요.<br>폴더 ID가 다르면 설정에서 바꿀 수 있어요.',
            actions: `<button class="btn-line primary" data-act="connect">Google 계정 연결</button>`,
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
    `<span class="listhead-acts">${folderToggleInline()}<button type="button" class="mini" data-act="select-mode">${state.selectMode ? '선택 해제' : '선택'}</button></span>`
  ) + files.map((f) => cardHTML(f)).join('');
  foot.textContent = '';
}

function renderPlaylists() {
  const area = $('#listArea');
  if (state.openPlaylistId === 'fav') {
    const files = state.files.filter((f) => isFav(f.id));
    area.innerHTML = `
      <div class="listhead">
        <button class="mini" data-act="pl-back">‹ 보관함</button>
        <span>즐겨찾기 · ${files.length}개</span>
        ${files.length ? `<span class="listhead-acts"><button type="button" class="mini" data-act="select-mode">${state.selectMode ? '선택 해제' : '선택'}</button></span>` : ''}
      </div>
      ${files.length ? files.map((f) => cardHTML(f)).join('')
        : emptyHTML({ icon: '⭐', title: '즐겨찾기가 비어 있어요', desc: '보이스 카드의 별을 눌러 두면 여기에 모여요.' })}
      ${files.length ? `<div class="btnrow" style="margin:16px 4px 0">
        <button class="btn-secondary" data-act="fav-play">전체 재생</button>
      </div>` : ''}`;
    $('#listFoot').textContent = '';
    return;
  }
  if (state.openPlaylistId === 'offline') {
    const files = state.files.filter((f) => offlineIds.has(f.id))
      .sort((a, b) => displayName(a.name).localeCompare(displayName(b.name), 'ko', { numeric: true }));
    area.innerHTML = `
      <div class="listhead">
        <button class="mini" data-act="pl-back">‹ 보관함</button>
        <span>오프라인 저장 · ${files.length}개</span>
        ${files.length ? `<span class="listhead-acts"><button type="button" class="mini" data-act="select-mode">${state.selectMode ? '선택 해제' : '선택'}</button></span>` : ''}
      </div>
      ${files.length ? files.map((f) => cardHTML(f)).join('')
        : emptyHTML({
          icon: '⬇️', title: '오프라인 저장한 보이스가 없어요',
          desc: '보이스를 골라 <b>오프라인</b>으로 저장하면<br>여기 모여 인터넷 없이도 들을 수 있어요.',
        })}
      ${files.length ? `<div class="btnrow" style="margin:16px 4px 0">
        <button class="btn-secondary" data-act="offline-play">전체 재생</button>
      </div>` : ''}`;
    $('#listFoot').textContent = '';
    return;
  }
  if (state.openPlaylistId) {
    const pl = personal.playlists.find((p) => p.id === state.openPlaylistId);
    if (!pl) { state.openPlaylistId = null; return renderPlaylists(); }
    const files = pl.fileIds.map(fileById).filter(Boolean);
    area.innerHTML = `
      <div class="listhead">
        <button class="mini" data-act="pl-back">‹ 보관함</button>
        <span>${esc(pl.name)} · ${files.length}개</span>
      </div>
      ${files.length ? files.map((f) => cardHTML(f, { playlist: true })).join('')
        : emptyHTML({ icon: '🎵', title: '아직 보이스가 없어요', desc: '보이스의 ⋯ 메뉴에서 이 목록에 담을 수 있어요.' })}
      <div class="btnrow" style="margin:16px 4px 0">
        <button class="btn-secondary" data-act="pl-play">전체 재생</button>
        <button class="btn-secondary btn-danger" data-act="pl-delete">재생목록 삭제</button>
      </div>`;
    $('#listFoot').textContent = '';
    return;
  }

  const favCount = state.files.filter((f) => isFav(f.id)).length;
  const favRow = `
    <button class="pl-row pl-gold" data-act="pl-fav">
      <span class="pl-ico"><svg><use href="#i-star-fill"/></svg></span>
      <span class="pl-name">즐겨찾기</span>
      <span class="pl-count">${favCount}개</span>
      <svg style="width:16px;height:16px;color:var(--muted)"><use href="#i-chevron"/></svg>
    </button>`;
  const offCount = state.files.filter((f) => offlineIds.has(f.id)).length;
  const offRow = `
    <button class="pl-row pl-offline" data-act="pl-offline">
      <span class="pl-ico"><svg><use href="#i-download"/></svg></span>
      <span class="pl-name">오프라인 저장</span>
      <span class="pl-count">${offCount}개</span>
      <svg style="width:16px;height:16px;color:var(--muted)"><use href="#i-chevron"/></svg>
    </button>`;
  const rows = favRow + offRow + personal.playlists.map((p) => `
    <button class="pl-row" data-act="pl-open" data-id="${esc(p.id)}">
      <span class="pl-ico"><svg><use href="#i-list"/></svg></span>
      <span class="pl-name">${esc(p.name)}</span>
      <span class="pl-count">${p.fileIds.length}개</span>
      <svg style="width:16px;height:16px;color:var(--muted)"><use href="#i-chevron"/></svg>
    </button>`).join('');

  area.innerHTML = `
    ${rows}
    <div class="listhead"><span>내 재생목록 ${personal.playlists.length}개</span></div>
    <div style="padding:12px 4px"><button class="btn-secondary" data-act="pl-new">+ 새 재생목록</button></div>`;
}

function folderModeBar(mode, count = null) {
  const n = count == null ? state.files.length : count;
  return `<div class="colhead">
    <span class="colcount">${n}개</span>
  </div>`;
}

/** 전체 보기에서 폴더 트리로 보는 토글 */
function folderToggle() {
  return `<label class="checkline">
    <input type="checkbox" data-act="folder-mode" ${state.folderMode === 'tree' ? 'checked' : ''} />
    <span>폴더별 보기</span>
  </label>`;
}

/** 목록 머리 오른쪽에 붙는 컴팩트 토글 */
function folderToggleInline() {
  const on = state.folderMode === 'tree';
  return `<button type="button" class="mini mini-toggle ${on ? 'is-on' : ''}" data-act="folder-mode" aria-pressed="${on}">
    <svg><use href="${on ? '#i-folder-open' : '#i-folder'}"/></svg>폴더별
  </button>`;
}

/* ── lazy ID3 covers: one range read per series, shared by its tracks ── */
const coverQueue = [];          // series keys waiting
const coverRep = new Map();     // seriesKey -> representative file id
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

let coverRetryTimer = 0;
let coverRetries = 0;
function scanCovers() {
  const targets = $$('#listArea [data-cover]:not([data-painted])');
  if (!targets.length) return;
  if (state.mode !== 'live' || !drive.connected) {
    // 연결이 아직 안 붙었을 뿐이다 — 붙을 때까지 천천히 다시 시도한다
    const ready = targets.some((el) => {
      const f = fileById(el.dataset.cover);
      return f && (f.folderCoverId || (f.parentId && coverMap().has(f.parentId)));
    });
    if (!ready) {
      // 커버 id를 아직 모른다 — 연결이 붙을 때까지 천천히 다시 시도한다
      if (coverRetries < 40) {
        coverRetries += 1;
        clearTimeout(coverRetryTimer);
        coverRetryTimer = setTimeout(scanCovers, 800);
      }
      return;
    }
    // id를 아니까 IndexedDB에 저장해 둔 커버로 네트워크 없이도 그린다
    clearTimeout(coverRetryTimer);
    if (!drive.connected) coverRetries = 0;
  }
  if (drive.connected) coverRetries = 0;
  if (!('IntersectionObserver' in window)) {
    for (const el of targets.slice(0, 10)) queueCover(el.dataset.cover);
    return;
  }
  if (coverIO) coverIO.disconnect();
  coverIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      coverIO.unobserve(en.target);
      queueCover(en.target.dataset.cover);
    }
  }, { root: $('#scroller'), rootMargin: '420px 0px' });
  for (const el of targets) coverIO.observe(el);
}

function queueCover(fileId) {
  if (!fileId || state.mode !== 'live') return;
  const file = fileById(fileId);
  if (!file) return;
  const hasFolderCover = !!(file.folderCoverId || (file.parentId && coverMap().has(file.parentId)));
  const canAskFolder = drive.connected && !!file.parentId && !coverMiss().has(file.parentId);
  // 폴더도 못 물어보고 아는 커버도 없으면 할 수 있는 게 없다
  if (!canAskFolder && !hasFolderCover) return;
  const key = seriesKeyOf(file);
  if (seriesCover.has(key)) { paintSeries(key); return; }
  const own = parsedCache.get(fileId);
  if (own?.thumb || own?.coverUrl) {
    rememberSeriesCover(file, { thumb: own.thumb || own.coverUrl, full: own.coverUrl || own.thumb });
    paintSeries(key);
    return;
  }
  // mp3에 아트가 없다고 기록돼 있어도 폴더 커버는 따로 시도한다
  if (seriesPending.has(key) || coverQueue.includes(key)) return;
  coverQueue.push(key);
  coverRep.set(key, fileId);
  pumpCovers();
}

/* the cover.png in a series folder, downloaded once and kept in IndexedDB */
const coverBlobs = new Map();       // drive image id -> object url
const coverBlobPending = new Map(); // drive image id -> promise

/**
 * 커버 그림은 트랙과 같은 폴더에 있기도 하고, 한 단계 위 시리즈 폴더에 있기도 하다.
 * 가까운 폴더부터 위로 올라가며 처음 만나는 이미지를 쓴다. (루트 폴더는 건너뛴다)
 */
async function coverImageFor(file) {
  const rootId = state.rootId || settings.rootId || '';
  let fid = file?.parentId || '';
  let guard = 0;
  while (fid && fid !== rootId && guard++ < 6) {
    const known = coverMap().get(fid);
    if (known) return known;
    if (coverMiss().has(fid)) { fid = state.folderMap?.get(fid)?.parentId || ''; continue; }
    let img = null;
    let asked = false;
    try {
      img = await drive.folderImage(fid);
      asked = true;                        // 조회 자체는 성공했다
    } catch {}
    if (img?.id) { rememberFolderCover(fid, img.id); return img.id; }
    if (asked) rememberFolderMiss(fid);   // 정말 이미지가 없는 폴더만 기억한다
    fid = state.folderMap?.get(fid)?.parentId || '';
  }
  return null;
}

async function folderCoverInfo(file) {
  let id = file?.folderCoverId || (file?.parentId ? coverMap().get(file.parentId) : null);
  if (!id) id = await coverImageFor(file);
  if (id && file) file.folderCoverId = id;
  if (!id) return null;
  if (coverBlobs.has(id)) return { thumb: coverBlobs.get(id), full: coverBlobs.get(id) };
  if (coverBlobPending.has(id)) return coverBlobPending.get(id);
  const job = (async () => {
    const saved = await db.get('covers', id).catch(() => null);
    if (saved?.blob && String(saved.blob.type || '').startsWith('image/')) {
      const url = URL.createObjectURL(saved.blob);
      coverBlobs.set(id, url);
      return { thumb: url, full: url };
    }
    if (saved) await db.del('covers', id).catch(() => {});
    const blob = await drive.mediaBlob(id);
    const url = URL.createObjectURL(blob);
    coverBlobs.set(id, url);
    db.put('covers', id, { blob }).catch(() => {});
    return { thumb: url, full: url };
  })();
  coverBlobPending.set(id, job);
  try {
    return await job;
  } catch {
    return null;
  } finally {
    coverBlobPending.delete(id);
  }
}

function pumpCovers() {
  while (coverActive < 5 && coverQueue.length) {
    const key = coverQueue.shift();
    const file = fileById(coverRep.get(key));
    if (!file) continue;
    if (seriesCover.has(key)) { paintSeries(key); continue; }
    coverActive += 1;
    seriesPending.add(key);
    folderCoverInfo(file)
      .then(async (folderCov) => {
        if (folderCov) {
          rememberSeriesCover(file, folderCov);
          paintSeries(key);
          return;
        }
        // 폴더에 커버가 없다 — mp3 안의 아트로 넘어간다 (이미 없다고 아는 파일은 건너뛴다)
        if (cachedEmpty.has(file.id)) return;
        const p = await loadParsed(file).catch(() => null);
        const info = p && (p.thumb || p.coverUrl)
          ? { thumb: p.thumb || p.coverUrl, full: p.coverUrl || p.thumb }
          : null;
        if (info) {
          rememberSeriesCover(file, info);
          paintSeries(key);
        }
      })
      .catch(() => {})
      .finally(() => {
        coverActive -= 1;
        seriesPending.delete(key);
        pumpCovers();
      });
  }
}

/** Paint every rendered cover element that belongs to this series. */
function paintSeries(key) {
  const info = seriesCover.get(key);
  if (!info) return;
  const url = info.thumb || info.full;
  if (!url) return;
  for (const el of $$('#listArea [data-cover]')) {
    if (el.dataset.painted === '1') continue;
    const f = fileById(el.dataset.cover);
    if (!f || seriesKeyOf(f) !== key) continue;
    el.dataset.painted = '1';
    el.innerHTML = `<img src="${url}" alt="" loading="lazy" />`;
    const img = el.querySelector('img');
    if (img) img.addEventListener('error', () => {
      seriesCover.delete(key);
      el.dataset.painted = '';
      el.innerHTML = '';
      queueCover(el.dataset.cover);
    }, { once: true });
  }
}

function collectLivers() {
  const map = new Map();
  for (const f of state.files) {
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
  const m = String(name || '').match(/[\uAC00-\uD7A3A-Za-z\u3041-\u3096\u30A1-\u30F6\u4E00-\u9FAF0-9]/);
  return m ? m[0] : '\u266A';
}

function liverTone(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `background:hsl(${hue} 55% 95%);color:hsl(${hue} 42% 40%)`;
}

function seriesTileHTML(group) {
  const coverFile = group.files.find((f) => coverInfoFor(f)) || group.files[0];
  const cov = coverInfoFor(coverFile);
  const playing = group.files.some((f) => player?.current?.id === f.id);
  return `<button type="button" class="tile ${playing ? 'is-playing' : ''}" data-act="open-series" data-title="${esc(group.title)}" data-ids="${esc(group.files.map((f) => f.id).join(','))}">
    <span class="tile-cov">
      <span class="cov-box" data-cover="${esc(coverFile ? coverFile.id : '')}"${cov ? ' data-painted="1"' : ''}>${cov ? `<img src="${cov.thumb || cov.full}" alt="" loading="lazy" />` : ''}</span>
      ${group.files.length > 1 ? `<span class="tile-badge">${group.files.length}</span>` : ''}
      <span class="tile-play"><svg><use href="${playing && player?.isPlaying ? '#i-pause' : '#i-play'}"/></svg></span>
    </span>
    <span class="tile-name">${esc(group.title)}</span>
  </button>`;
}

/** group the selected liver's voices into series, kept in year sections */
function collectionGroups(liver) {
  const files = state.files.filter((f) => (f.liver || '기타') === liver);
  const years = new Map();
  for (const f of files) {
    const y = f.year || '연도 미분류';
    const title = seriesNameOf(f) || displayName(f.name);
    if (!years.has(y)) years.set(y, new Map());
    const g = years.get(y);
    if (!g.has(title)) g.set(title, { title, year: y, liver, files: [] });
    g.get(title).files.push(f);
  }
  const yearKeys = [...years.keys()].sort((a, b) => {
    const an = /^\d{4}$/.test(a), bn = /^\d{4}$/.test(b);
    if (an && bn) return b.localeCompare(a);
    if (an !== bn) return an ? -1 : 1;   // 연도 미분류는 맨 끝으로
    return String(a).localeCompare(String(b), 'ko');
  });
  const byYear = yearKeys.map((year) => ({
    year,
    groups: [...years.get(year).values()]
      .map((g) => ({ ...g, files: g.files.slice().sort((a, b) => displayName(a.name).localeCompare(displayName(b.name), 'ko', { numeric: true })) }))
      .sort((a, b) => a.title.localeCompare(b.title, 'ko', { numeric: true })),
  }));
  return { byYear, groups: byYear.flatMap((s) => s.groups) };
}

/** short label for a liver chip: the Korean part when the name carries it */
function liverShort(name) {
  const m = String(name || '').match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : String(name || '');
}

/** favorite livers, in the order the user pinned them */
function favLivers() {
  const set = new Set(collectLivers().map(([name]) => name));
  return (personal.favLivers || []).filter((name) => set.has(name));
}

function isFavLiver(name) { return (personal.favLivers || []).includes(name); }

function setFavLiver(name, on) {
  const list = (personal.favLivers || []).filter((n) => n !== name);
  personal.favLivers = on ? [name, ...list] : list;
  saveJSON(PERSONAL_KEY, personal);
}

/** the pinned livers, shown above everything else in the collection */
function favLiverStrip(cur) {
  const names = favLivers();
  if (!names.length) return '';
  return `<div class="fav-strip-wrap">
    <div class="fav-strip-head">즐겨찾기 라이버</div>
    <div class="fav-strip">${names.map((name) => {
      const n = state.files.filter((f) => (f.liver || '기타') === name).length;
      return `<button type="button" class="fav-liver ${name === cur ? 'is-on' : ''}" data-act="sel-liver" data-liver="${esc(name)}">
        <span class="fl-av" style="${liverTone(name)}">${esc(liverInitial(name))}</span>
        <span class="fl-name">${esc(liverShort(name))}</span>
        <span class="fl-n">${n}</span>
      </button>`;
    }).join('')}</div>
  </div>`;
}

/** the one liver the collection is showing */
function displayLivers() {
  const available = collectLivers();
  const wanted = state.collectionLiver || personal.lastLiver || '';
  const hit = available.find(([name]) => name === wanted);
  return hit ? [hit] : (available.length ? [available[0]] : []);
}

function axisBar() {
  const ax = state.collectionAxis === 'theme' ? 'theme' : 'liver';
  return `<div class="seg axis">
    <button type="button" class="${ax === 'liver' ? 'is-on' : ''}" data-act="col-axis" data-axis="liver">라이버별</button>
    <button type="button" class="${ax === 'theme' ? 'is-on' : ''}" data-act="col-axis" data-axis="theme">테마별</button>
  </div>`;
}

/** 테마 = 시리즈명·EX·내가 단 태그. 연도와 라이버명은 테마가 아니다. */
function themeOf(f) {
  const liverShort = (f.liver || '').replace(/\s*\([^)]*\)\s*$/, '');
  return tagsOf(f).filter((t) => t && !/^\d{4}$/.test(t) && t !== '연도 미분류'
    && !/^ex$/i.test(t) && t !== f.liver && t !== liverShort && !/^\d{4}_/.test(t));
}

/** every theme in the library with the voices that carry it */
function themeIndex() {
  const map = new Map();
  for (const f of state.files) {
    for (const t of themeOf(f)) {
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(f);
    }
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length
    || a[0].localeCompare(b[0], 'ko', { numeric: true }));
}

function themeTileHTML(tag, files) {
  const rep = files.find((f) => f.folderCoverId) || files.find((f) => coverInfoFor(f)) || files[0];
  const cov = coverInfoFor(rep);
  const livers = [...new Set(files.map((f) => f.liver || '기타'))];
  return `<button type="button" class="tile" data-act="open-theme" data-tag="${esc(tag)}">
    <span class="tile-cov">
      <span class="cov-box" data-cover="${esc(rep.id)}"${cov ? ' data-painted="1"' : ''}>${cov ? `<img src="${cov.thumb || cov.full}" alt="" loading="lazy" />` : ''}</span>
      <span class="tile-badge">${files.length}</span>
    </span>
    <span class="tile-name">${esc(tag)}</span>
    <span class="tile-sub">라이버 ${livers.length}명</span>
  </button>`;
}

function renderThemeDetail(tag) {
  const area = $('#listArea');
  const files = state.files.filter((f) => themeOf(f).includes(tag));
  if (!files.length) { state.openTheme = null; return renderCollection(); }
  const byLiver = new Map();
  for (const f of files) {
    const k = f.liver || '기타';
    if (!byLiver.has(k)) byLiver.set(k, []);
    byLiver.get(k).push(f);
  }
  const compact = state.themeCompact !== false;
  const shortLiver = (n) => String(n || '기타').replace(/\s*\([^)]*\)\s*$/, '');
  const playBtn = (liver) => `<button type="button" class="ttrk-play" data-act="theme-liver-play" data-liver="${esc(liver)}" aria-label="${esc(shortLiver(liver))} 전체 재생" title="이 라이버 트랙 전부 이어 듣기"><svg><use href="#i-play"/></svg></button>`;
  const cells = [...byLiver.entries()].map(([liver, list]) => `
    <div class="tcell">
      <div class="tcell-name">${playBtn(liver)}<span class="tn">${esc(shortLiver(liver))}</span><span class="tc">${list.length}</span></div>
      <div class="tcell-tracks">${list.map((f) => `
        <button type="button" class="ttrk ${player?.current?.id === f.id ? 'is-on' : ''}" data-act="theme-track" data-id="${esc(f.id)}" title="${esc(displayTitleOf(f, { short: true }))}" aria-label="${esc(liver)} ${esc(trackNoFor(f))}">${esc(trackNoFor(f))}</button>`).join('')}</div>
    </div>`).join('');
  const blocks = [...byLiver.entries()].map(([liver, list]) => `
    <h3 class="col-liver">${playBtn(liver)}<span class="tn">${esc(liver)}</span><span class="tc">${list.length}</span></h3>
    <div class="sd-tracks">${list.map((f) => cardHTML(f)).join('')}</div>`).join('');
  area.innerHTML = `
    <div class="sd-bar">
      <button type="button" class="sd-ico back" data-act="close-theme" aria-label="뒤로"><svg><use href="#i-chevron"/></svg></button>
    </div>
    <h2 class="sd-title">${esc(tag)}</h2>
    <div class="sd-meta">보이스 ${files.length}개 · 라이버 ${byLiver.size}명
      <span class="theme-view">
        <button type="button" class="${compact ? 'is-on' : ''}" data-act="theme-view" data-compact="1">요약</button>
        <button type="button" class="${compact ? '' : 'is-on'}" data-act="theme-view" data-compact="0">목록</button>
      </span>
    </div>
    <button type="button" class="sd-play" data-act="theme-play"><svg><use href="#i-play"/></svg>전체 재생</button>
    ${compact ? `<div class="theme-grid">${cells}</div>` : blocks}
  `;
  $('#listFoot').textContent = '';
}

function renderThemeIndex() {
  const area = $('#listArea');
  const themes = themeIndex();
  area.innerHTML = `<div class="libbar"><span class="colcount">${state.files.length}개 보이스</span>${axisBar()}</div>`
    + (themes.length
      ? `<div class="col-grid">${themes.map(([tag, files]) => themeTileHTML(tag, files)).join('')}</div>`
      : emptyHTML({ icon: '🏷', title: '아직 테마가 없어요', desc: '보이스 메타데이터를 읽는 중이에요. 잠시 뒤 다시 열어 주세요.' }));
  $('#listFoot').textContent = '';
  for (const [, files] of themes.slice(0, 24)) {
    const rep = files.find((f) => f.folderCoverId) || files.find((f) => coverInfoFor(f)) || files[0];
    if (rep) queueCover(rep.id);
  }
}

function renderCollection() {
  const area = $('#listArea');
  if (state.collectionAxis === 'theme') {
    if (state.themeCompact == null) state.themeCompact = personal.themeCompact !== false;
    if (state.openTheme) return renderThemeDetail(state.openTheme);
    return renderThemeIndex();
  }
  const all = state.files;
  if (!all.length) {
    area.innerHTML = `<div class="libbar"><span class="colcount">0개 보이스</span>${axisBar()}</div>`
      + emptyHTML({ icon: '📂', title: '아직 보이스가 없어요', desc: '드라이브를 연결하면 라이버·연도별로 모아 보여드려요.' });
    return;
  }

  const livers = displayLivers();
  const single = true;
  if (livers.length) state.collectionLiver = livers[0][0];

  const groupsFor = (liver) => collectionGroups(liver);
  const flat = livers.flatMap(([liver]) => groupsFor(liver).groups);

  if (state.openSeries) return renderSeriesDetail(flat);

  const totalFiles = livers.reduce((n, [, c]) => n + c, 0);
  const head = single
    ? `<div class="lib-head">
        <button type="button" class="lib-avatar" style="${liverTone(livers[0][0])}" data-act="pick-liver" aria-label="라이버 변경">${esc(liverInitial(livers[0][0]))}</button>
        <button type="button" class="lib-meta" data-act="pick-liver">
          <span class="lib-name">${esc(livers[0][0])}</span>
          <span class="lib-sub">시리즈 ${flat.length} · 보이스 ${totalFiles}</span>
        </button>
        <button type="button" class="lib-fav ${isFavLiver(livers[0][0]) ? 'is-on' : ''}" data-act="fav-liver" data-liver="${esc(livers[0][0])}" aria-label="이 라이버 즐겨찾기"><svg><use href="${isFavLiver(livers[0][0]) ? '#i-star-fill' : '#i-star'}"/></svg></button>
        <button type="button" class="lib-go" data-act="pick-liver" aria-label="라이버 변경"><svg><use href="#i-chevron"/></svg></button>
      </div>`
    : `<div class="lib-head">
        <button type="button" class="lib-meta" data-act="pick-liver">
          <span class="lib-name">라이버 ${livers.length}명</span>
          <span class="lib-sub">시리즈 ${flat.length} · 보이스 ${totalFiles}</span>
        </button>
        <button type="button" class="lib-go" data-act="pick-liver" aria-label="라이버 변경"><svg><use href="#i-chevron"/></svg></button>
      </div>`;

  const sections = livers.map(([liver]) => {
    const { byYear, groups } = groupsFor(liver);
    const blocks = byYear.map((section) => `
      <div class="col-year">${esc(section.year)}<span>${section.groups.length} 시리즈</span></div>
      <div class="col-grid">${section.groups.map(seriesTileHTML).join('')}</div>`).join('');
    const heading = single
      ? ''
      : `<h3 class="col-liver">${esc(liver)}<span>${groups.length} 시리즈</span></h3>`;
    return `<section class="col-section">${heading}${blocks}</section>`;
  }).join('');

  const cur = livers[0][0];
  const favHere = state.files.filter((f) => (f.liver || '기타') === cur && isFav(f.id));
  const favBlock = favHere.length ? `<div class="col-year">즐겨찾기 보이스<span>${favHere.length}</span></div>
    <div class="fav-tracks">${favHere.map((f) => cardHTML(f)).join('')}</div>` : '';

  area.innerHTML = `<div class="libbar"><span class="colcount">${totalFiles}개 보이스</span>${axisBar()}</div>`
    + favLiverStrip(cur) + head + favBlock + sections;
  $('#listFoot').textContent = '';
  prefetchSeriesCovers(flat);
  queueVisibleCovers();
  watchCovers();
}

/** warm the covers of the series on screen, five at a time */
function prefetchSeriesCovers(groups) {
  if (state.mode !== 'live') return;
  for (const group of groups) {
    const file = group.files.find((f) => !coverInfoFor(f)) || group.files[0];
    if (file) queueCover(file.id);
  }
}

/** 목록이 그려진 직후 화면에 있는 커버를 옵저버 없이도 바로 대기열에 넣는다 */
function queueVisibleCovers(limit = 60) {
  const els = $$('#listArea [data-cover]:not([data-painted])').slice(0, limit);
  for (const el of els) queueCover(el.dataset.cover);
}

function renderSeriesDetail(groups) {
  const area = $('#listArea');
  let idx = groups.findIndex((g) => g.title === state.openSeries.title
    && g.files.map((f) => f.id).join(',') === (state.openSeries.ids || []).join(','));
  if (idx < 0) idx = groups.findIndex((g) => g.title === state.openSeries.title);
  if (idx < 0) { state.openSeries = null; return renderCollection(); }
  const group = groups[idx];
  state.openSeries = { title: group.title, ids: group.files.map((f) => f.id) };
  const prev = groups[idx - 1] || null;
  const next = groups[idx + 1] || null;
  const coverFile = group.files.find((f) => coverInfoFor(f)) || group.files[0];
  const cov = coverInfoFor(coverFile);
  const liver = group.liver || state.collectionLiver || '';

  area.innerHTML = `
    <div class="sd-bar">
      <button type="button" class="sd-ico back" data-act="close-series" aria-label="뒤로"><svg><use href="#i-chevron"/></svg></button>
      <div class="sd-bar-actions">
        <button type="button" class="sd-ico" data-act="series-offline" aria-label="오프라인 일괄 저장"><svg><use href="#i-download"/></svg></button>
        <button type="button" class="sd-ico" data-act="series-more" aria-label="더보기"><svg><use href="#i-more"/></svg></button>
      </div>
    </div>
    <div class="sd-liver">${esc(liver)}</div>
    <div class="sd-art">
      <button type="button" class="sd-nav prev" data-act="series-move" data-dir="-1" aria-label="이전 시리즈" ${prev ? '' : 'disabled'}><svg><use href="#i-chevron"/></svg></button>
      <span class="sd-cover" data-cover="${esc(coverFile.id)}"${cov ? ' data-painted="1"' : ''}>${cov ? `<img src="${cov.full || cov.thumb}" alt="" />` : ''}</span>
      <button type="button" class="sd-nav next" data-act="series-move" data-dir="1" aria-label="다음 시리즈" ${next ? '' : 'disabled'}><svg><use href="#i-chevron"/></svg></button>
    </div>
    <h2 class="sd-title">${esc(group.title)}</h2>
    <div class="sd-meta">${group.files.length}개 보이스${group.year ? ` · ${esc(group.year)}` : ''}</div>
    <button type="button" class="sd-play" data-act="series-play"><svg><use href="#i-play"/></svg>전체 재생</button>
    <div class="sd-tracks">${group.files.map((f) => cardHTML(f)).join('')}</div>
  `;
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
    state.openSeries = null;
    closeSheet();
    renderList();
    const sc = $('#scroller');
    if (sc) sc.scrollTo({ top: 0 });
  });
}

function openSeriesSheet() {
  const files = (state.openSeries?.ids || []).map(fileById).filter(Boolean);
  if (!files.length) return;
  ui.sheet = 'series';
  const body = openSheet(state.openSeries.title || '시리즈', `
    <button type="button" class="act-item" data-act="s-play">
      <span class="ai"><svg><use href="#i-play"/></svg></span><span class="al">전체 재생</span>
    </button>
    <button type="button" class="act-item" data-act="s-offline">
      <span class="ai"><svg><use href="#i-download"/></svg></span><span class="al">오프라인 일괄 저장</span><span class="av">${files.length}개</span>
    </button>
    <button type="button" class="act-item" data-act="s-tag">
      <span class="ai"><svg><use href="#i-tag"/></svg></span><span class="al">전체에 태그</span>
    </button>
    <button type="button" class="act-item" data-act="s-pl">
      <span class="ai"><svg><use href="#i-list"/></svg></span><span class="al">재생목록에 추가</span>
    </button>
  `);
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const ids = files.map((f) => f.id);
    if (act === 's-play') { closeAllSheets(); player.playFiles(files, 0); toast(`${files.length}개 재생 시작`); }
    if (act === 's-offline') { closeAllSheets(); offlineMany(files); }
    if (act === 's-tag') { openTagSheet(ids); }
    if (act === 's-pl') { openPlaylistPicker(ids); }
  });
}

async function offlineMany(files) {
  const todo = files.filter((f) => !offlineIds.has(f.id));
  if (!todo.length) { toast('이미 모두 오프라인에 저장되어 있어요'); return; }
  if (!drive.connected) { toast('먼저 Google Drive에 연결해 주세요.', { err: true }); return; }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const t = toastProgress(`오프라인 저장 0/${todo.length}`);
  let ok = 0;
  for (const f of todo) {
    try {
      const buf = await drive.download(f.id);
      await db.put('audio', f.id, {
        fileId: f.id, name: f.name, size: buf.byteLength,
        blob: new Blob([buf], { type: 'audio/mpeg' }), savedAt: Date.now(),
        meta: offlineMetaOf(f),
      });
      offlineIds.add(f.id);
      ok += 1;
    } catch {}
    t.update({ received: ok, total: todo.length });
  }
  t.done();
  toast(`${ok}개를 오프라인에 저장했어요`);
  renderList();
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
    <div class="listhead">
      <span>폴더별 보기</span>
      <span class="listhead-acts">${folderToggleInline()}</span>
    </div>
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
      <span class="folder-meta">${n ? n + '개' : ''}${subs ? (n ? ' · ' : '') + subs + '폴더' : ''}</span>
      <svg style="width:16px;height:16px;color:var(--muted)"><use href="#i-chevron"/></svg>
    </button>`;
  }).join('');

  area.innerHTML = crumbHTML + folderHTML + (files.length ? files.map((f) => cardHTML(f)).join('') : '')
    + (!subFolders.length && !files.length ? emptyHTML({ icon: '📂', title: '빈 폴더예요', desc: '여기에는 아직 오디오 파일이 없어요.' }) : '');
  $('#listFoot').textContent = files.length ? `${files.length}개 파일` : '';
}

/** 한 메모에 달린 답글 묶음 — 답글은 쓴 사람만 지울 수 있다 */
function memoRepliesHTML(n, { own = false } = {}) {
  const replies = Array.isArray(n.replies) ? n.replies : [];
  const row = (r) => `
    <div class="memo-reply" data-reply="${esc(r.id)}">
      <span class="mr-author">${esc(r.author)}</span>
      <span class="mr-text">${esc(r.text)}</span>
      ${r.author === personal.nickname && own
        ? `<button type="button" class="mr-del" data-act="${own === 'np' ? 'np-del-reply' : 'memo-del-reply'}" data-id="${esc(n.id)}" data-file="${esc(n.fileId)}" data-reply="${esc(r.id)}">삭제</button>`
        : ''}
    </div>`;
  return `
    <div class="memo-replies">
      ${replies.map(row).join('')}
      <button type="button" class="memo-reply-open" data-act="memo-reply-open" data-note="${esc(n.id)}">
        답글${replies.length ? ` ${replies.length}` : ''}
      </button>
      <div class="memo-reply-form" hidden>
        <input type="text" maxlength="200" placeholder="답글을 남겨 보세요" data-reply-input="${esc(n.id)}" />
        <button type="button" class="send" data-act="memo-add-reply" data-id="${esc(n.id)}" data-file="${esc(n.fileId)}">등록</button>
      </div>
    </div>`;
}

function memoCardHTML(n) {
  const mine = n.author === personal.nickname;
  return `<div class="memo-card ${isNewNote(n) ? 'is-new' : ''}" data-note-card="${esc(n.id)}">
    <button type="button" class="memo-file" data-act="memo-jump" data-id="${esc(n.fileId)}" data-t="${n.t ?? ''}">
      <span class="mf-name">${esc(displayName(n.file?.name || n.fileId))}</span>
      <span class="mf-time">${n.t != null ? fmtTime(n.t) : '전체'}</span>
    </button>
    <div class="memo">
      <div class="memo-body">
        <div class="memo-text">${esc(n.text)}</div>
        <div class="memo-meta">${esc(fmtDate(n.createdAt))} ${isNewNote(n) ? '<span class="newbadge">NEW</span>' : ''}
          ${mine ? `<button type="button" class="memo-del" data-act="memo-del" data-file="${esc(n.fileId)}" data-id="${esc(n.id)}">삭제</button>` : ''}
        </div>
      </div>
    </div>
    ${memoRepliesHTML(n, { own: true })}
  </div>`;
}

function renderNotes() {
  const area = $('#listArea');
  const rows = shared.allNotes().map((n) => ({ ...n, file: fileById(n.fileId) })).filter((n) => n.file || n.fileId);
  const newN = rows.filter(isNewNote).length;

  if (!rows.length) {
    area.innerHTML = `<div class="listhead"><span>메모 <b>0</b>개</span></div>`
      + emptyHTML({ icon: '💬', title: '아직 메모가 없어요', desc: '재생 중 원하는 지점에서 메모를 남기면<br>타임스탬프와 함께 여기에 모여요.' });
    return;
  }

  // 작성자별로 묶는다 — 내 메모가 먼저, 그다음 최근에 쓴 사람 순
  const byAuthor = new Map();
  for (const n of rows) {
    const a = n.author || '익명';
    if (!byAuthor.has(a)) byAuthor.set(a, []);
    byAuthor.get(a).push(n);
  }
  const latest = (list) => Math.max(...list.map((n) => new Date(n.createdAt).getTime() || 0));
  const authors = [...byAuthor.keys()].sort((a, b) => {
    const me = a === personal.nickname, m2 = b === personal.nickname;
    if (me !== m2) return me ? -1 : 1;
    return latest(byAuthor.get(b)) - latest(byAuthor.get(a)) || a.localeCompare(b, 'ko');
  });

  const head = `<div class="listhead">
      <span>메모 <b>${rows.length}</b>개 · 작성자 <b>${authors.length}</b>명${newN ? ` · 새 메모 <b>${newN}</b>개` : ''}</span>
      ${newN ? '<button class="mini has-content" data-act="mark-seen">모두 읽음</button>' : ''}
    </div>`;

  const sections = authors.map((a) => {
    const list = byAuthor.get(a);
    const mine = a === personal.nickname;
    return `<section class="memo-group">
      <h3 class="col-liver">${esc(a)}${mine ? ' (나)' : ''}<span>${list.length}</span></h3>
      ${list.map(memoCardHTML).join('')}
    </section>`;
  }).join('');

  area.innerHTML = head + sections;
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
function inOfflineView() {
  return state.view === 'playlists' && state.openPlaylistId === 'offline';
}

function renderSelectionBar() {
  const bar = $('#selBar');
  const n = state.selected.size;
  bar.hidden = !state.selectMode;
  $('#selCount').textContent = `${n}개 선택`;
  const off = inOfflineView();
  const rm = $('#selBar [data-sel="offline-remove"]');
  if (rm) rm.hidden = !off;
  $('#selBar [data-sel="offline"]').hidden = off;
  $$('#selBar [data-sel]').forEach((b) => { b.disabled = n === 0 && b.dataset.sel !== 'cancel'; });
}

/** 고른 것만 오프라인 저장에서 지운다 */
async function offlineRemove(ids) {
  if (!ids.length) return;
  if (!confirm(`고른 ${ids.length}개를 오프라인 저장에서 지울까요?`)) return;
  for (const id of ids) {
    try { await db.del('audio', id); } catch {}
    offlineIds.delete(id);
  }
  state.selected.clear();
  state.selectMode = false;
  toast(`${ids.length}개를 오프라인 저장에서 지웠어요`);
  renderControlbar();
  renderSelectionBar();
  renderList();
}

/* ─────────────────────────── parsed ID3 & audio ─────────────────────────── */
function hydrate(rec) {
  if (!rec) return null;
  const cached = parsedCache.get(rec.fileId);
  if (cached) return cached;
  const full = rec.coverBlob ? URL.createObjectURL(rec.coverBlob) : null;
  const out = {
    title: rec.title || '',
    artist: rec.artist || '',
    album: rec.album || '',
    year: rec.year || '',
    lyrics: rec.lyrics || [],
    plainLyrics: rec.plainLyrics || '',
    coverType: rec.coverType || 'image/jpeg',
    coverUrl: full,
    thumb: rec.coverThumb || full,
  };
  parsedCache.set(rec.fileId, out);
  return out;
}

/** Downscale a cover to a light list thumbnail (canvas → JPEG data URL). */
function makeThumb(src, size = 280) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, size / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
          const w = Math.max(1, Math.round((img.naturalWidth || size) * scale));
          const h = Math.max(1, Math.round((img.naturalHeight || size) * scale));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          if (!ctx) return resolve(src);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.8));
        } catch { resolve(src); }
      };
      img.onerror = () => resolve(src);
      img.src = src;
    } catch { resolve(src); }
  });
}

async function loadParsed(file, { network = true } = {}) {
  if (!file) return null;
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
  const fullUrl = coverBlob ? URL.createObjectURL(coverBlob) : null;
  const coverThumb = fullUrl ? await makeThumb(fullUrl) : null;
  const newRec = {
    fileId: file.id,
    title: tag.title || '',
    artist: tag.artist || '',
    album: tag.album || '',
    year: tag.year || '',
    lyrics: tag.lyrics || [],
    plainLyrics: tag.plainLyrics || '',
    coverBlob,
    coverThumb,
    coverType: tag.cover?.mime || 'image/jpeg',
    tagSize: tag.tagSize || 0,
    parsedAt: Date.now(),
  };
  await db.put('parsed', file.id, newRec).catch(() => {});
  const out = hydrate({ ...newRec, coverBlob: null });
  if (out) { out.coverUrl = fullUrl; out.thumb = coverThumb || fullUrl; }
  parsedCache.set(file.id, out);
  if (out?.thumb || out?.coverUrl) rememberSeriesCover(file, { thumb: out.thumb, full: out.coverUrl });
  return out;
}

async function primeCache() {
  try {
    const rows = await db.all('parsed');
    for (const r of rows) {
      if (!r?.fileId) continue;
      if (r.empty) { cachedEmpty.add(r.fileId); continue; }
      const p = parsedCache.get(r.fileId) || hydrate(r);
      const f = fileById(r.fileId);
      if (f && (p?.thumb || p?.coverUrl)) {
        rememberSeriesCover(f, { thumb: p.thumb || p.coverUrl, full: p.coverUrl || p.thumb });
      }
    }
  } catch {}
}

function indexCount() { return parsedCache.size + cachedEmpty.size; }

const cachedEmpty = new Set();

async function resolveTrack(file) {
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
    onState: (st) => { updatePlayerUI(st); saveSession(st.isPlaying !== sessionLastPlaying); sessionLastPlaying = st.isPlaying; },
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
  // 한 트랙을 고른 건 그 트랙만 듣겠다는 뜻이다 — 목록 전체를 대기열에 넣지 않는다.
  // 여러 개를 이어 듣는 건 '전체 재생'·시리즈 재생·재생목록처럼 명시한 경우뿐.
  const queue = list && list.length ? list : [file];
  let idx = queue.findIndex((f) => f.id === file.id);
  if (idx < 0) { queue.unshift(file); idx = 0; }
  personal.lastFileId = file.id;
  saveJSON(PERSONAL_KEY, personal);
  player.playFiles(queue, idx, { startAt });
}

/* ── 마지막 재생 상태 — 앱을 나갔다 들어와도 그 목록 그 자리에서 이어 듣는다 ── */
const SESSION_KEY = 'niji.session';
let sessionSaveAt = 0;
let sessionLastPlaying = null;

const sessionFileOf = (f) => ({
  id: f.id, name: f.name || '', path: f.path || [],
  liver: f.liver || '', year: f.year || '', folderCoverId: f.folderCoverId || '',
});

function saveSession(force = false) {
  if (!player?.current) return;
  const now = Date.now();
  if (!force && now - sessionSaveAt < 2000) return;
  sessionSaveAt = now;
  const idx = player.queue.findIndex((f) => f.id === player.current.id);
  saveJSON(SESSION_KEY, {
    v: 1, at: now,
    index: idx >= 0 ? idx : 0,
    time: player.audio?.currentTime || 0,
    playing: !!player.isPlaying,
    shuffle: !!player.shuffle,
    rate: player.rate || 1,
    queue: (player.queue.length ? player.queue : [player.current]).map(sessionFileOf),
  });
}

function updatePlayerUI(st) {
  const bar = $('#playerBar');
  const cur = st.current;
  if (bar) bar.classList.toggle('is-empty', !cur);

  if (!cur) {
    const t = $('#pTitle');
    if (t) t.textContent = '재생 중인 보이스 없음';
    const s = $('#pSub');
    if (s) s.textContent = '전체 재생을 눌러 시작해 보세요';
    const th = $('#pThumb');
    if (th) th.innerHTML = '<svg><use href="#i-mic"/></svg>';
    setSeek(0, 0, true);
  } else {
    const p = parsedCache.get(cur.id) || {};
    const title = $('#pTitle');
    if (title) title.textContent = displayTitleOf(cur);
    const bits = [];
    if (p.artist) bits.push(p.artist);
    if (st.queueLength > 1) bits.push(`${player.queue.findIndex((f) => f.id === cur.id) + 1}/${st.queueLength}`);
    const sub = $('#pSub');
    if (sub) sub.textContent = bits.join(' · ') || cur.liver || '';
    const thumb = $('#pThumb');
    const cvT = coverOf(cur).thumb;
    if (thumb) thumb.innerHTML = cvT ? `<img src="${cvT}" alt="" />` : '<svg><use href="#i-mic"/></svg>';
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
const ui = { sheet: null, lyricIdx: -1, sheetFile: null, seg: 'lyrics', panelKey: '', stack: [], queueSel: new Set(), queueSelect: false };

function openSheet(title, html, { tall = false, full = false } = {}) {
  const sheetEl = $('#sheet');
  const overlay = $('#overlay');
  const old = $('#sheetBody');
  // 시트가 이미 떠 있으면 지금 화면을 접어 두고 그 위에 겹쳐 연다 (닫으면 이전 화면으로 돌아간다)
  if (!overlay.hidden && old) {
    ui.stack.push({
      body: old,
      title: $('#sheetTitle').textContent,
      sheet: old.dataset.owner || ui.sheet,
      full: sheetEl.classList.contains('is-full'),
      tall: sheetEl.classList.contains('is-tall'),
    });
    old.remove();
  } else if (old) {
    old.remove();
    ui.stack = [];
  }
  $('#sheetTitle').textContent = title;
  const body = document.createElement('div');
  body.className = 'sheet-body';
  body.id = 'sheetBody';
  body.innerHTML = html;
  sheetEl.appendChild(body);
  body.dataset.owner = ui.sheet || '';
  sheetEl.classList.toggle('is-tall', tall && !full);
  sheetEl.classList.toggle('is-full', !!full);
  const closeUse = $('#sheetClose')?.querySelector('use');
  if (closeUse) closeUse.setAttribute('href', full ? '#i-chevd' : '#i-close');
  sheetEl.style.transform = '';
  sheetEl.style.transition = '';
  overlay.style.opacity = '';
  overlay.hidden = false;
  body.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  document.body.classList.add('sheet-open');
  bindSheetSwipe(true);
  return body;
}

function refreshNowSheet() {
  if (!player?.current) return;
  updateNowSheet({
    current: player.current,
    isPlaying: player.isPlaying,
    currentTime: player.audio.currentTime || 0,
    duration: Number.isFinite(player.audio.duration) ? player.audio.duration : 0,
    ab: { ...player.ab },
    sleep: { ...player.sleep },
    shuffle: player.shuffle,
  });
}

function closeAllSheets() {
  ui.stack = [];
  closeSheet();
}

/** 위에서 아래로 쓸어내리면 시트가 내려가며 닫힌다 (미니 플레이어로 복귀) */
let sheetSwipeBound = [];
function bindSheetSwipe(enabled) {
  for (const [el, type, fn] of sheetSwipeBound) el.removeEventListener(type, fn);
  sheetSwipeBound = [];
  const on = (el, type, fn) => { el.addEventListener(type, fn); sheetSwipeBound.push([el, type, fn]); };
  const sheet = $('#sheet');
  const grab = sheet.querySelector('.sheet-grab');
  const head = sheet.querySelector('.sheet-head');
  if (!sheet || !grab) return;
  sheet.style.transform = '';
  sheet.style.transition = '';
  if (!enabled) return;

  let startY = 0, dy = 0, active = false, pid = null, lastY = 0, lastT = 0, vy = 0;
  const start = (e) => {
    active = true;
    pid = e.pointerId;
    startY = lastY = e.clientY;
    lastT = Date.now();
    vy = 0;
    dy = 0;
    sheet.style.transition = 'none';
    sheet.classList.add('is-dragging');
  };
  const move = (e) => {
    if (!active || (pid != null && e.pointerId !== pid)) return;
    dy = Math.max(0, e.clientY - startY);
    const now = Date.now();
    const dt = now - lastT;
    if (dt > 0) { vy = (e.clientY - lastY) / dt; lastY = e.clientY; lastT = now; }
    // 끌어내릴수록 살짝 무게가 붙어 부드럽게 따라온다
    sheet.style.transform = `translate3d(0, ${dy}px, 0)`;
    if (dy > 2) $('#overlay').style.opacity = String(Math.max(0.12, 1 - dy / (sheet.offsetHeight * 0.9)));
  };
  const end = (e) => {
    if (!active) return;
    active = false;
    pid = null;
    sheet.classList.remove('is-dragging');
    $('#overlay').style.opacity = '';
    const h = sheet.offsetHeight || 600;
    const flick = vy > 0.55 && dy > 24;   // 빠르게 튕기면 짧게 끌어도 닫힌다
    if (dy > h * 0.22 || flick) {
      const rest = Math.max(0, h - dy);
      sheet.style.transition = `transform ${Math.min(320, 140 + rest * 0.28)}ms cubic-bezier(.32,.72,0,1)`;
      sheet.style.transform = 'translate3d(0, 100%, 0)';
      setTimeout(() => { closeSheet(); sheet.style.transform = ''; sheet.style.transition = ''; }, 220);
    } else {
      // 손을 뗀 속도만큼 살짝 튕겨 제자리로
      sheet.style.transition = 'transform .26s cubic-bezier(.22,.9,.32,1.08)';
      sheet.style.transform = '';
    }
  };
  for (const el of [grab, head]) {
    on(el, 'pointerdown', (e) => {
      if (e.target.closest('button.sheet-x')) return;
      if (e.button != null && e.button !== 0) return;
      try { el.setPointerCapture(e.pointerId); } catch {}
      start(e);
      e.preventDefault();
    });
    on(el, 'pointermove', move);
    on(el, 'pointerup', end);
    on(el, 'pointercancel', end);
    on(el, 'lostpointercapture', end);
  }

  // 재생 화면에서는 커버를 끌어내려도 닫지 않는다 — 대신 커버가 줄어드는 데 한계를 둔다
  // (닫기는 위 손잡이·머리 부분을 끌어내리면 된다)
}

function closeSheet() {
  const sheetEl = $('#sheet');
  const overlay = $('#overlay');
  const cur = $('#sheetBody');
  const prev = ui.stack.pop();
  if (prev) {
    cur?.remove();
    sheetEl.appendChild(prev.body);
    $('#sheetTitle').textContent = prev.title;
    sheetEl.classList.toggle('is-full', prev.full);
    sheetEl.classList.toggle('is-tall', prev.tall);
    sheetEl.style.transform = '';
    sheetEl.style.transition = '';
    overlay.style.opacity = '';
    ui.sheet = prev.sheet;
    bindSheetSwipe(true);
    if (prev.sheet === 'now' && player?.current) refreshNowSheet();
    return;
  }
  overlay.hidden = true;
  ui.sheet = null;
  ui.sheetFile = null;
  ui.lyricIdx = -1;
  sheetEl.style.transform = '';
  sheetEl.style.transition = '';
  overlay.style.opacity = '';
  document.body.style.overflow = '';
  document.body.classList.remove('sheet-open');
}

/* settings */
function openSettings() {
  ui.sheet = 'settings';
  const isLive = state.mode === 'live';
  const online = drive.connected;
  const stateText = isLive
    ? (online ? `Google Drive 연결됨${drive.hint ? ` · ${drive.hint}` : ''}` : '저장된 목록 표시 중 — 연결 필요')
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
      <label>목록 새로고침</label>
      <label class="switchrow">
        <input type="checkbox" id="setAutoSync" ${personal.autoSync ? 'checked' : ''} data-instant="1" />
        <span>실행할 때 자동으로 새로 받기</span>
      </label>
      <p class="hint">꺼 두면 저장해 둔 목록을 그대로 써요. 위 새로고침 버튼을 누를 때만 드라이브를 다시 읽습니다.</p>
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
      <p class="hint">홈 화면에서 열면 주소창 없이 전체 화면으로 뜨고, 잠금화면에서도 재생/다음 보이스를 조작할 수 있어요.</p>
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
    if (el) el.textContent = `${u.count}개${u.bytes ? ` · ${fmtBytes(u.bytes)}` : ''}`;
  }).catch(() => {});

  body.addEventListener('change', (e) => {
    // 목록 새로고침 스위치는 누르는 즉시 저장한다 — 저장 버튼을 안 눌러 되돌아가던 문제
    if (e.target.id !== 'setAutoSync') return;
    personal.autoSync = !!e.target.checked;
    saveJSON(PERSONAL_KEY, personal);
    toast(personal.autoSync ? '실행할 때 목록을 새로 받아요' : '저장해 둔 목록을 그대로 써요');
  });

  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'connect') connectFromUI();
    if (act === 'save-settings') saveSettingsFromUI();
    if (act === 'detect') detectFolder();
    if (act === 'disconnect') {
      drive.signOut();
      try {
        localStorage.removeItem(treeCacheKey(settings.rootId));
        localStorage.removeItem(metaCacheKey(settings.rootId));
      } catch {}
      parsedCache.clear();
      cachedEmpty.clear();
      showDisconnected();
      toast('연결을 해제했어요.');
      closeSheet();
    }
    if (act === 'clear-offline') {
      if (!confirm('오프라인 저장한 보이스를 모두 지울까요?')) return;
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
  if (rootId !== settings.rootId) folderCoverMap = null;
  settings.rootId = rootId;
  settings.includeBackup = !!$('#setBackup')?.checked;
  const autoEl = $('#setAutoSync');
  if (autoEl) { personal.autoSync = !!autoEl.checked; saveJSON(PERSONAL_KEY, personal); }
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
        <div class="memo-card" data-note-card="${esc(n.id)}">
          <div class="memo" data-note="${esc(n.id)}">
            <button class="memo-time" data-act="jump" data-t="${n.t ?? ''}">${n.t != null ? fmtTime(n.t) : '전체'}</button>
            <div class="memo-body">
              <div class="memo-text">${esc(n.text)}</div>
              <div class="memo-meta">${esc(n.author)} · ${esc(fmtDate(n.createdAt))} ${isNewNote(n) ? '<span class="newbadge">NEW</span>' : ''}
                ${n.author === personal.nickname ? '<button class="memo-del" data-act="del" data-file="' + esc(file.id) + '" data-id="' + esc(n.id) + '">삭제</button>' : ''}
              </div>
            </div>
          </div>
          ${memoRepliesHTML({ ...n, fileId: file.id }, { own: true })}
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
      try { await shared.removeNote(file.id, b.dataset.id, { by: personal.nickname }); toast('메모를 지웠어요'); }
      catch (e) { toast(e?.message || '지울 수 없어요', { err: true }); }
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
  state.openSeries = null;
  state.filterBarOpen = false;
  renderAll();
  const sc = $('#scroller');
  if (sc) sc.scrollTo({ top: 0 });
  if (tag) toast(`#${tag} 태그로 모았어요`);
  else if (liver) toast(`${liver} 보이스만 보여드려요`);
}

/* subtitles */
function openLyricsSheet(file) {
  const rec = parsedCache.get(file.id);
  if (!rec && !cachedEmpty.has(file.id) && state.mode === 'live') {
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
  return parsedCache.get(file.id) || {};
}

/** cover for playback surfaces: prefer the full artwork, fall back to the thumb */
function coverOf(file) {
  const info = coverInfoFor(file);
  if (!info) return { thumb: '', full: '' };
  return { thumb: info.thumb || info.full || '', full: info.full || info.thumb || '' };
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
        <div class="memo-card" data-note-card="${esc(n.id)}">
          <div class="memo" data-note="${esc(n.id)}">
            <button type="button" class="memo-time" data-act="np-seek" data-t="${n.t ?? ''}">${n.t != null ? fmtTime(n.t) : '전체'}</button>
            <div class="memo-body">
              <div class="memo-text">${esc(n.text)}</div>
              <div class="memo-meta">${esc(n.author)} · ${esc(fmtDate(n.createdAt))} ${isNewNote(n) ? '<span class="newbadge">NEW</span>' : ''}
                ${n.author === personal.nickname ? `<button type="button" class="memo-del" data-act="np-del" data-id="${esc(n.id)}">삭제</button>` : ''}
              </div>
            </div>
          </div>
          ${memoRepliesHTML({ ...n, fileId: file.id }, { own: 'np' })}
        </div>`).join('')
        : '<div class="note" style="padding:14px 4px">아직 메모가 없어요. 재생 중 원하는 지점에서 남겨 보세요.</div>'}
    </div>`;
}

/** 가사·메모 시트를 끌어내려 접으면 위의 커버가 그만큼 커진다 */
/**
 * 가사·메모를 위로 끌어올려 큰 커버 자리가 사라질 만큼 좁아지면,
 * 커버를 없애지 않고 제목 정보 왼쪽의 작은 커버로 옮긴다.
 */
function syncMiniCover(npEl) {
  const wrap = npEl?.querySelector('#npArtWrap');
  if (!wrap) return;
  const wasMini = npEl.classList.contains('is-mini');
  if (wasMini) npEl.classList.remove('is-mini');
  const h = wrap.getBoundingClientRect().height;
  if (h < 64) npEl.classList.add('is-mini');
}

function bindPanelDrag(body) {
  const drag = body.querySelector('#npDrag');
  const panel = body.querySelector('#npPanel');
  const npEl = body.querySelector('.np');
  if (!drag || !panel || !npEl) return;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const minH = 46;
  // 커버가 이만큼보다 작아지지는 않는다 (가사·메모를 아무리 올려도)
  const artMin = () => Math.round(clamp(npEl.clientHeight * 0.3, 120, 200));
  const maxH = () => Math.max(minH + 40, npEl.clientHeight - artMin());

  const saved = Number(personal.panelH);
  if (saved > 0) panel.style.height = `${clamp(saved, minH, maxH())}px`;

  let miniRaf = 0;
  const queueMiniSync = () => {
    if (miniRaf) return;
    miniRaf = requestAnimationFrame(() => { miniRaf = 0; syncMiniCover(npEl); });
  };
  queueMiniSync();
  window.addEventListener('resize', queueMiniSync);

  let startY = 0;
  let startH = 0;
  let dragging = false;

  drag.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    drag.setPointerCapture?.(e.pointerId);
    drag.classList.add('is-dragging');
    panel.classList.add('is-live-drag');
    e.preventDefault();
  });
  drag.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    panel.style.height = `${clamp(startH - (e.clientY - startY), minH, maxH())}px`;
    queueMiniSync();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    drag.classList.remove('is-dragging');
    panel.classList.remove('is-live-drag');
    personal.panelH = Math.round(panel.getBoundingClientRect().height);
    saveJSON(PERSONAL_KEY, personal);
    panel.style.height = `${clamp(personal.panelH, minH, maxH())}px`;
    queueMiniSync();
  };
  drag.addEventListener('pointerup', end);
  drag.addEventListener('pointercancel', end);

  // 두 번 두드리면 펼침/접힘
  drag.addEventListener('dblclick', () => {
    const full = maxH();
    const now = panel.getBoundingClientRect().height;
    personal.panelH = now > full * 0.6 ? minH : full;
    saveJSON(PERSONAL_KEY, personal);
    panel.style.height = `${clamp(personal.panelH, minH, full)}px`;
    queueMiniSync();
  });
}

function npPanelHTML(file, seg) {
  const p = currentParsed(file);
  if (seg === 'memo') return npMemoHTML(file);
  if (seg === 'cover') {
    return `
    <div class="np-art">
      ${coverOf(file).full
        ? `<img src="${coverOf(file).full}" alt="${esc(p.title || displayName(file.name))}" data-act="np-art" />`
        : '<div class="np-art-empty"><svg><use href="#i-mic"/></svg><span>이 보이스에는 앨범 커버가 없어요.</span></div>'}
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
      : `<div class="lrc-empty">${p.plainLyrics ? esc(p.plainLyrics) : '이 보이스에는 타임싱크 자막이 없어요.'}</div>`}`;
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
  if (!url) { toast('이 보이스에는 앨범 커버가 없어요'); return; }
  const ov = document.createElement('div');
  ov.className = 'coverview';
  ov.innerHTML = `<img src="${url}" alt="앨범 커버" /><button type="button" class="cv-x" aria-label="닫기"><svg><use href="#i-close"/></svg></button>`;
  ov.addEventListener('click', () => ov.remove());
  document.body.appendChild(ov);
}

function openNowPlaying() {
  if (!player?.current) { toast('재생 중인 보이스가 없어요'); return; }
  const file = player.current;
  const p = currentParsed(file);
  const tags = tagsOf(file);
  ui.sheet = 'now';
  ui.sheetFile = file.id;
  ui.lyricIdx = -1;
  const seg0 = personal.lastSeg === 'memo' ? 'memo' : 'lyrics';
  ui.seg = seg0;
  const eyebrow = p.album || file.liver || '지금 재생 중';
  const body = openSheet(eyebrow, `
    <div class="np">
      <div class="np-art-wrap" id="npArtWrap">
        <button type="button" class="np-art-big" id="npArt" data-act="np-cover" aria-label="앨범 커버 크게 보기">
          ${coverOf(file).full || coverOf(file).thumb
            ? `<img src="${coverOf(file).full || coverOf(file).thumb}" alt="" />`
            : `<span class="np-art-empty"><svg><use href="#i-mic"/></svg></span>`}
        </button>
      </div>
      <div class="np-meta">
        <button type="button" class="np-mini" id="npMini" data-act="np-cover" aria-label="앨범 커버 크게 보기">
          ${coverOf(file).thumb || coverOf(file).full
            ? `<img src="${coverOf(file).thumb || coverOf(file).full}" alt="" />`
            : `<svg><use href="#i-mic"/></svg>`}
        </button>
        <div class="np-meta-text">
        <div class="np-title-row">
          <span class="np-trk" id="npTrk" title="트랙 번호">${esc(trackNoFor(file))}</span>
          <div class="np-title" id="npTitle">${esc(displayTitleOf(file))}</div>
          <button type="button" class="np-fav ${isFav(file.id) ? 'is-on' : ''}" id="npFav" data-act="np-fav" aria-label="즐겨찾기">
            <svg><use href="${isFav(file.id) ? '#i-star-fill' : '#i-star'}"/></svg>
          </button>
        </div>
        <div class="np-sub" id="npSub">${esc([p.artist, p.album].filter(Boolean).join(' · ') || file.liver || '')}</div>
        ${(file.liver || tags.length) ? `<div class="np-tags" id="npTags">
          ${file.liver ? `<button type="button" class="badge np-liver" data-act="np-liver" data-liver="${esc(file.liver)}">${esc(file.liver)}</button>` : ''}
          ${tags.map((t) => `<button type="button" class="badge np-tag" data-act="np-tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
        </div>` : ''}
        </div>
      </div>

      <div class="np-seekwrap">
        <input id="npSeek" type="range" min="0" max="1000" step="1" value="0" aria-label="재생 위치" />
        <div class="np-times"><span id="npCur">00:00</span><span id="npDur">-00:00</span></div>
      </div>
      <div class="np-ctrl">
        <button type="button" data-act="np-prev" aria-label="이전 보이스"><svg><use href="#i-prev"/></svg></button>
        <button type="button" data-act="np-back10" aria-label="10초 뒤로"><svg><use href="#i-back10"/></svg></button>
        <button type="button" class="np-play" id="npPlay" data-act="np-play" aria-label="재생/일시정지"><svg><use href="${player.isPlaying ? '#i-pause' : '#i-play'}"/></svg></button>
        <button type="button" data-act="np-fwd10" aria-label="10초 앞으로"><svg><use href="#i-fwd10"/></svg></button>
        <button type="button" data-act="np-next" aria-label="다음 보이스"><svg><use href="#i-next"/></svg></button>
      </div>
      <div class="np-pills">
        <button type="button" class="np-pill ${player.shuffle ? 'is-on' : ''}" id="npShuffle" data-act="np-shuffle"><svg><use href="#i-shuffle"/></svg>셔플</button>
        <button type="button" class="np-pill ${player.ab.a != null ? 'is-on' : ''}" id="npAB" data-act="np-ab">A–B</button>
        <button type="button" class="np-pill" id="npRate" data-act="np-rate">${rateLabel(player.rate)}</button>
        <button type="button" class="np-pill ${player.sleep.mode ? 'is-on' : ''}" id="npSleep" data-act="np-sleep"><svg><use href="#i-moon"/></svg>취침</button>
        <button type="button" class="np-pill" data-act="np-queue"><svg><use href="#i-list"/></svg>재생목록</button>
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
      <div class="np-drag" id="npDrag" role="separator" aria-label="가사·메모 영역 높이 조절"><span></span></div>
      <div class="np-seg" id="npSeg">
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
  bindPanelDrag(body);

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
      openCoverView(coverOf(file).full || coverOf(file).thumb);
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
      try { await shared.removeNote(file.id, b.dataset.id, { by: personal.nickname }); toast('메모를 지웠어요'); }
      catch (e) { toast(e?.message || '지울 수 없어요', { err: true }); }
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
  if (ui.sheet === 'now') {
    const titleEl = $('#sheetTitle');
    if (titleEl) titleEl.textContent = eyebrow;
  }
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
  if (title) title.textContent = displayTitleOf(cur);
  const trk = $('#npTrk');
  if (trk) {
    const no = trackNoFor(cur);
    trk.textContent = no ? `No.${no}` : '';
    trk.hidden = !no;
  }
  const sub = $('#npSub');
  if (sub) {
    const bits = [p.artist, p.album].filter(Boolean);
    const qi = player?.queue?.length > 1 ? player.queue.findIndex((f) => f.id === cur.id) + 1 : 0;
    if (qi) bits.push(`${qi} / ${player.queue.length}`);
    sub.textContent = bits.join(' · ') || cur.liver || '';
  }
  const cov = $('#npCover');
  if (cov) {
    const url = coverOf(cur).thumb || '';
    const img = cov.querySelector('img');
    if (url && (!img || img.getAttribute('src') !== url)) cov.innerHTML = `<img src="${url}" alt="" />`;
    else if (!url && !img) cov.innerHTML = '<svg><use href="#i-mic"/></svg>';
  }
}

function cycleABWithToast() {
  if (!player?.current) { toast('먼저 보이스를 재생해 주세요.'); return; }
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
    // offsetTop은 부모 기준이 달라질 수 있다 — 화면 좌표로 계산해 항상 가운데에 둔다
    const boxRect = box.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const delta = (elRect.top - boxRect.top) - (box.clientHeight - elRect.height) / 2;
    box.scrollTo({ top: Math.max(0, box.scrollTop + delta), behavior: 'smooth' });
  }
}

/* queue — 이어 듣기 목록에서 곡을 빼고, 고르고, 옮길 수 있다 */
function openQueue() {
  ui.sheet = 'queue';
  ui.queueSel = ui.queueSel || new Set();
  ui.queueSel.clear();
  ui.queueSelect = false;
  const body = openSheet('재생목록', '<div class="lrc-empty">불러오는 중…</div>', { tall: true });

  const dropAt = (indexes) => {
    if (!player || !indexes.length) return;
    player.removeMany(indexes);
    ui.queueSel.clear();
    render();
    refreshNowSheet();
    renderList();
    if (!player.queue.length) toast('재생목록이 비었어요 — 지금 곡은 계속 재생돼요');
  };

  const bindSwipe = () => {
    for (const row of body.querySelectorAll('.q-row')) {
      let sx = 0, sy = 0, dx = 0, dy = 0, active = false, horiz = false;
      row.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.q-rm, .q-check')) return;
        sx = e.clientX; sy = e.clientY; dx = dy = 0;
        active = true; horiz = false;
        row.style.transition = 'none';
      });
      row.addEventListener('pointermove', (e) => {
        if (!active) return;
        dx = e.clientX - sx; dy = e.clientY - sy;
        if (!horiz) {
          if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { active = false; row.style.transform = ''; return; }
          if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) horiz = true;
          else return;
        }
        row.style.transform = `translateX(${Math.min(0, Math.max(-110, dx))}px)`;
        row.classList.toggle('will-remove', dx < -64);
      });
      const finish = () => {
        if (!active) return;
        active = false;
        if (horiz && dx < -64) {
          row.style.transition = 'transform .16s ease, opacity .16s ease';
          row.style.transform = 'translateX(-100%)';
          row.style.opacity = '0';
          const i = Number(row.dataset.i);
          setTimeout(() => dropAt([i]), 150);
          return;
        }
        row.style.transition = 'transform .2s ease';
        row.style.transform = '';
        row.classList.remove('will-remove');
      };
      row.addEventListener('pointerup', finish);
      row.addEventListener('pointercancel', finish);
    }
  };

  const render = () => {
    const q = player?.queue || [];
    if (!q.length) {
      $('#sheetTitle').textContent = '재생목록';
      body.innerHTML = '<div class="lrc-empty">재생목록이 비어 있어요.<br>시리즈나 라이버 전체 재생을 누르면 여기에 쌓여요.</div>';
      return;
    }
    const sel = ui.queueSel;
    $('#sheetTitle').textContent = ui.queueSelect
      ? `재생목록 · ${sel.size}개 선택`
      : `재생목록 (${q.length})`;
    body.innerHTML = `
      <div class="q-head">
        <span class="q-count">${q.length}곡 · 왼쪽으로 밀면 빼요</span>
        <button type="button" class="mini ${ui.queueSelect ? 'has-content' : ''}" data-qact="sel">${ui.queueSelect ? '그만 고르기' : '선택'}</button>
      </div>
      <div class="q-list">
        ${q.map((f, i) => `
          <div class="q-row ${player?.current?.id === f.id ? 'is-cur' : ''}" data-i="${i}">
            ${ui.queueSelect ? `<button type="button" class="q-check ${sel.has(i) ? 'is-on' : ''}" data-qact="pick" data-i="${i}" aria-label="고르기"><svg><use href="#i-check"/></svg></button>` : ''}
            <button type="button" class="hit" data-qact="play" data-i="${i}">
              <span class="memo-time">${i + 1}</span>
              <span class="hit-line">
                <span class="hit-orig">${esc(displayTitleOf(f))}</span>
                <span class="hit-file">${esc([f.liver, f.year].filter(Boolean).join(' · '))}</span>
              </span>
            </button>
            ${ui.queueSelect ? '' : `<button type="button" class="q-rm" data-qact="rm" data-i="${i}" aria-label="재생목록에서 빼기"><svg><use href="#i-close"/></svg></button>`}
          </div>`).join('')}
      </div>
      ${ui.queueSelect ? `
        <div class="q-bar">
          <button type="button" class="mini" data-qact="all">${sel.size === q.length ? '전체 해제' : '전체 선택'}</button>
          <button type="button" class="btn-primary" data-qact="drop" ${sel.size ? '' : 'disabled'}>선택한 ${sel.size}곡 빼기</button>
        </div>` : ''}
    `;
    bindSwipe();
  };

  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-qact]');
    if (!b) return;
    const act = b.dataset.qact;
    const i = Number(b.dataset.i);
    if (act === 'play') {
      if (!player?.queue[i]) return;
      player.index = i;
      player.load(player.queue[i]);
      closeSheet();
      return;
    }
    if (act === 'sel') {
      ui.queueSelect = !ui.queueSelect;
      ui.queueSel.clear();
      render();
      return;
    }
    if (act === 'pick') {
      if (ui.queueSel.has(i)) ui.queueSel.delete(i); else ui.queueSel.add(i);
      render();
      return;
    }
    if (act === 'all') {
      const q = player?.queue || [];
      if (ui.queueSel.size === q.length) ui.queueSel.clear();
      else q.forEach((_, idx) => ui.queueSel.add(idx));
      render();
      return;
    }
    if (act === 'rm') { dropAt([i]); return; }
    if (act === 'drop') {
      const idx = [...ui.queueSel];
      if (!idx.length) return;
      dropAt(idx);
      ui.queueSelect = false;
      render();
    }
  });

  render();
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
      <span class="pl-count">${p.fileIds.length}개</span>
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
      toast(`${pl.name}에 ${added}개를 담았어요`);
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
  const cover = coverOf(file).thumb || '';
  const saved = offlineIds.has(file.id);
  const notes = shared.notesOf(file.id).length;
  const tags = tagsOf(file);
  const isCurrent = player?.current?.id === file.id;
  const body = openSheet('더보기', `
    <div class="act-head">
      <span class="act-cov">${cover ? `<img src="${cover}" alt="" />` : '<svg><use href="#i-mic"/></svg>'}</span>
      <span class="act-meta">
        <div class="act-title">${esc(displayTitleOf(file))}</div>
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
      <span class="al">${isCurrent ? '재생 / 일시정지' : '이 보이스 재생'}</span>
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
      closeSheet();
      openMoreSheet(file, { playlist });
      return;
    }
    if (act === 'm-play') {
      closeAllSheets();
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
  closeAllSheets();
  renderList();
  toast('재생목록에서 뺐어요');
}

/* ─────────────────────────── offline ─────────────────────────── */
async function toggleOffline(file) {
  if (offlineIds.has(file.id)) {
    if (!confirm('이 보이스의 오프라인 저장을 지울까요?')) return;
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
    state.openSeries = null;
    state.selected.clear();
    state.selectMode = false;
    renderAll();
    $('#scroller').scrollTo({ top: 0, behavior: 'smooth' });
  });

  on('#btnFilterToggle', 'click', openFilterSheet);
  on('#btnSearch', 'click', () => {
    const bar = $('#searchBar');
    const input = $('#searchInput');
    if (!bar) return;
    const opening = bar.hidden;
    bar.hidden = !opening;
    $('#btnSearch')?.classList.toggle('is-on', opening);
    if (opening) setTimeout(() => input?.focus(), 40);
    else if (state.search) {
      state.search = '';
      if (input) input.value = '';
      if ($('#btnClearSearch')) $('#btnClearSearch').hidden = true;
      renderList();
    }
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
    if (!drive.connected) { await loadLive({ interactive: true }); return; }
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
    toast(state.offlineOnly ? '오프라인 저장한 보이스만 보여드려요' : '저장한 보이스를 모두 보여드려요');
  });
  on('#btnShuffleAll', 'click', () => {
    const files = visibleFiles();
    if (!files.length) { toast('재생할 파일이 없어요.'); return; }
    player.setShuffle(true);
    const start = Math.floor(Math.random() * files.length);
    player.playFiles(files, start);
    renderControlbar();
    toast(`${files.length}개를 섞어서 재생해요`);
  });
  on('#btnPlayAll', 'click', () => {
    let files = visibleFiles();
    if (state.view === 'folders') {
      const liver = state.collectionLiver || personal.lastLiver || '';
      files = state.files.filter((f) => (f.liver || '기타') === liver);
    }
    if (state.view === 'all' && state.folderMode === 'tree') {
      files = state.files.filter((f) => f.parentId === (state.folderId || state.rootId));
    }
    if (!files.length) { toast('재생할 파일이 없어요.'); return; }
    player.playFiles(files, 0);
    toast(`${files.length}개 재생 시작`);
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
    // 스크롤·스와이프로 새로 보이는 타일의 커버를 알아서 불러온다
    clearTimeout(coverScanTimer);
    coverScanTimer = setTimeout(scanCovers, 120);
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
  state.loading = true;
  renderHeader();
  if (manual) {
    // 새로 올린 커버를 다시 찾도록 '없음' 기억을 비운다
    try {
      coverMiss().clear();
      saveJSON(folderCoverMissKey(), []);
    } catch {}
  }
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
    await mergeOfflineIntoLibrary();
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
async function onListClick(e) {
  const action = e.target.closest('[data-act]');
  const card = e.target.closest('.card');

  // 선택 모드에서는 카드 어디를 눌러도 선택된다 (커버·체크원 포함)
  if (card && state.selectMode) {
    const a = action?.dataset.act;
    if (!a || a === 'open' || a === 'play' || a === 'sel') {
      e.preventDefault();
      toggleSelect(card.dataset.id);
      return;
    }
  }

  // views that are not plain card lists
  if (!action) return;
  const act = action.dataset.act;

  if (act === 'connect') { openSettings(); return; }
  if (act === 'select-mode') { toggleSelectMode(); return; }
  if (act === 'pick-liver') { openLiverSheet(); return; }
  if (act === 'fav-liver') {
    const name = action.dataset.liver || '';
    if (!name) return;
    const on = !isFavLiver(name);
    setFavLiver(name, on);
    renderList();
    toast(on ? `${liverShort(name)} 라이버를 즐겨찾기에 두었어요` : '즐겨찾기에서 뺐어요');
    return;
  }
  if (act === 'sel-liver') {
    const name = action.dataset.liver || '';
    if (!name) return;
    state.collectionLiver = name;
    personal.lastLiver = name;
    saveJSON(PERSONAL_KEY, personal);
    state.folderMode = 'collection';
    state.openSeries = null;
    renderList();
    const sc = $('#scroller');
    if (sc) sc.scrollTo({ top: 0 });
    return;
  }
  if (act === 'open-series') {
    state.openSeries = {
      title: action.dataset.title || '',
      ids: (action.dataset.ids || '').split(',').filter(Boolean),
    };
    renderList();
    const sc = $('#scroller');
    if (sc) sc.scrollTo({ top: 0 });
    return;
  }
  if (act === 'close-series') { state.openSeries = null; renderList(); return; }
  if (act === 'col-axis') {
    state.collectionAxis = action.dataset.axis === 'theme' ? 'theme' : 'liver';
    state.openTheme = null;
    state.openSeries = null;
    renderList();
    const sc = $('#scroller');
    if (sc) sc.scrollTo({ top: 0 });
    return;
  }
  if (act === 'open-theme') { state.openTheme = action.dataset.tag || ''; renderList(); return; }
  if (act === 'close-theme') { state.openTheme = null; renderList(); return; }
  if (act === 'theme-view') {
    state.themeCompact = action.dataset.compact === '1';
    personal.themeCompact = state.themeCompact;
    saveJSON(PERSONAL_KEY, personal);
    renderList();
    return;
  }
  if (act === 'theme-liver-play') {
    const liver = action.dataset.liver || '';
    const list = state.files.filter((f) => (f.liver || '기타') === liver && themeOf(f).includes(state.openTheme || ''));
    if (!list.length) { toast('재생할 보이스가 없어요.'); return; }
    if (player.shuffle) player.setShuffle(false);
    player.playFiles(list, 0);
    toast(`${list.length}개를 이어서 들어요`);
    return;
  }
  if (act === 'theme-track') {
    const f = fileById(action.dataset.id);
    if (!f) return;
    playFile(f);          // 고른 트랙 하나만 재생한다
    return;
  }
  if (act === 'theme-play') {
    const list = state.files.filter((f) => themeOf(f).includes(state.openTheme || ''));
    if (!list.length) { toast('재생할 보이스가 없어요.'); return; }
    player.playFiles(list, 0);
    toast(`${list.length}개 재생 시작`);
    return;
  }
  if (act === 'series-move') {
    const dir = Number(action.dataset.dir) || 0;
    if (!dir || !state.openSeries) return;
    const groups = displayLivers().flatMap(([liver]) => collectionGroups(liver).groups);
    const idx = groups.findIndex((g) => g.title === state.openSeries.title);
    const target = groups[idx + dir];
    if (!target) return;
    state.openSeries = { title: target.title, ids: target.files.map((f) => f.id) };
    renderList();
    const sc = $('#scroller');
    if (sc) sc.scrollTo({ top: 0 });
    return;
  }
  if (act === 'series-offline') {
    offlineMany((state.openSeries?.ids || []).map(fileById).filter(Boolean));
    return;
  }
  if (act === 'series-more') { openSeriesSheet(); return; }
  if (act === 'series-play') {
    const list = (state.openSeries?.ids || []).map(fileById).filter(Boolean);
    if (!list.length) { toast('재생할 보이스가 없어요.'); return; }
    player.playFiles(list, 0);
    toast(`${list.length}개 재생 시작`);
    return;
  }
  if (act === 'offline-clear-all') {
    // 통째로 비우지 않는다 — 선택 모드에서 고른 것만 지운다
    if (!state.selectMode) toggleSelectMode();
    toast('지울 항목을 고르고 오프라인 삭제를 눌러 주세요');
    return;
  }
  if (act === 'folder-mode') {
    const el = action.matches('input') ? action : action.querySelector('input');
    const on = el ? !!el.checked : state.folderMode !== 'tree';
    state.folderMode = on ? 'tree' : 'collection';
    state.openSeries = null;
    state.openTheme = null;
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
  if (act === 'memo-del') {
    try {
      await shared.removeNote(action.dataset.file, action.dataset.id, { by: personal.nickname });
      toast('메모를 지웠어요');
    } catch (e) { toast(e?.message || '지울 수 없어요', { err: true }); }
    renderTabs(); renderList(); return;
  }
  if (act === 'memo-reply-open') {
    const card = action.closest('[data-note-card]') || action.closest('.memo');
    const form = card?.querySelector('.memo-reply-form');
    if (!form) return;
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('input')?.focus();
    return;
  }
  if (act === 'memo-add-reply' || act === 'np-add-reply') {
    const noteId = action.dataset.id;
    const fileId = action.dataset.file;
    const scope = action.closest('.memo-replies');
    const inp = scope?.querySelector('input');
    const text = (inp?.value || '').trim();
    if (!text) { toast('답글 내용을 입력해 주세요.', { err: true }); return; }
    await shared.addReply(fileId, noteId, { author: personal.nickname, text });
    toast('답글을 남겼어요');
    renderTabs();
    if (act === 'np-add-reply' && ui.sheetFile) renderNowPanel(fileById(ui.sheetFile), 'memo');
    else renderList();
    return;
  }
  if (act === 'memo-del-reply' || act === 'np-del-reply') {
    try {
      await shared.removeReply(action.dataset.file, action.dataset.id, action.dataset.reply, { by: personal.nickname });
      toast('답글을 지웠어요');
    } catch (e) { toast(e?.message || '지울 수 없어요', { err: true }); }
    renderTabs();
    if (act === 'np-del-reply' && ui.sheetFile) renderNowPanel(fileById(ui.sheetFile), 'memo');
    else renderList();
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
  if (act === 'pl-offline') { state.openPlaylistId = 'offline'; renderList(); return; }
  if (act === 'pl-fav') { state.openPlaylistId = 'fav'; renderList(); return; }
  if (act === 'fav-play') {
    const files = state.files.filter((f) => isFav(f.id));
    if (!files.length) { toast('즐겨찾기한 보이스가 없어요.'); return; }
    player.playFiles(files, 0);
    toast(`즐겨찾기 ${files.length}개 재생 시작`);
    return;
  }
  if (act === 'offline-play') {
    const files = state.files.filter((f) => offlineIds.has(f.id));
    if (!files.length) { toast('오프라인 저장한 보이스가 없어요.'); return; }
    player.playFiles(files, 0);
    toast(`${files.length}개 재생 시작`);
    return;
  }
  if (act === 'pl-back') {
    state.openPlaylistId = null;
    state.selectMode = false;
    state.selected.clear();
    renderSelectionBar();
    renderList();
    return;
  }
  if (act === 'pl-play') {
    const pl = personal.playlists.find((p) => p.id === state.openPlaylistId);
    const files = (pl?.fileIds || []).map(fileById).filter(Boolean);
    if (!files.length) { toast('재생할 보이스가 없어요.'); return; }
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
  if (act === 'offline') {
    offlineMany(ids.map(fileById).filter(Boolean));
    state.selectMode = false;
    state.selected.clear();
    renderControlbar(); renderSelectionBar();
    return;
  }
  if (act === 'offline-remove') { offlineRemove(ids); return; }
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

  // 1) paint the last saved library first — no spinner flash
  const cached = loadTreeCache();
  const fromCache = !!(cached && cached.files?.length);
  if (fromCache) startFromCache(cached);
  else startFromOffline();

  bindEvents();
  initPlayer();
  restoreLast();
  watchCovers();

  // 2) offline markers and cached ID3 come from IndexedDB; repaint once known
  Promise.all([refreshOfflineIds(), primeCache()])
    .then(async () => {
      if (fromCache) { await mergeOfflineIntoLibrary(); renderList(); }
      else if (!state.files.length) {
        const offline = await offlineLibrary();
        if (offline.length) { state.files = offline; renderAll(); }
      }
    })
    .catch(() => {});

  // 3) reconnect quietly on launch: a held token talks to Drive at once, and an
  //    expired one is renewed without a popup when Google still remembers the user.
  if (settings.clientId) {
    (async () => {
      try {
        await drive.loadGis();
        await drive.client();
      } catch {}
      if (!drive.connected) {
        try { await drive.requestToken({ prompt: '' }); } catch {}
      }
      renderHeader();
      if (drive.connected) {
        // 토큰이 늦게 붙어도 커버는 이때부터 그린다
        coverRetries = 0;
        watchCovers();
        // 저장해 둔 목록은 영구 캐시로 쓴다 — 새로 받는 건 자동 새로고침을 켠 경우뿐
        if (fromCache) {
          if (personal.autoSync) loadLive({ interactive: false, silent: true }).catch(() => {});
        } else if (personal.autoSync || !state.files.length) {
          syncQuietly();
        }
      }
    })();
    keepTokenFresh();
  }

  if ('serviceWorker' in navigator) {
    const registerSw = () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); };
    if (document.readyState === 'complete') registerSw();
    else window.addEventListener('load', registerSw, { once: true });
  }
  window.__appReady = true;
}

/** renew the hour-long token in the background so relaunch rarely asks again */
function keepTokenFresh() {
  clearInterval(freshTimer);
  freshTimer = setInterval(async () => {
    if (!settings.clientId || !drive.tokenClient) return;
    if (drive.connected && drive.expiresAt - Date.now() > 10 * 60_000) return;
    try { await drive.requestToken({ prompt: '' }); } catch {}
  }, 5 * 60_000);
}
let freshTimer = 0;

/** 앱을 다시 열면 마지막으로 듣던 목록의 그 자리에서 이어 듣는다 */
function restoreLast() {
  const sess = loadJSON(SESSION_KEY, null);
  const savedQueue = Array.isArray(sess?.queue) ? sess.queue.filter((f) => f && f.id) : [];
  if (savedQueue.length) {
    // 화면에 이미 있는 목록 캐시의 객체를 쓰면 커버·태그가 그대로 살아 있다
    const files = savedQueue.map((f) => fileById(f.id) || f);
    const idx = Math.min(Math.max(0, Number(sess.index) || 0), files.length - 1);
    player.setQueue(files, idx);
    player.shuffle = !!sess.shuffle;
    player.rate = sess.rate || 1;
    personal.lastFileId = files[idx].id;
    saveJSON(PERSONAL_KEY, personal);
    player.load(files[idx], { startAt: Number(sess.time) || 0, autoplay: false })
      .then(() => {
        player.emit();
        if (sess.playing) player.audio.play?.().catch(() => {});
      })
      .catch(() => {});
    return;
  }
  const id = personal.lastFileId;
  if (!id) return;
  const f = fileById(id);
  if (!f) return;
  player.current = f;
  player.emit();
}

boot();
