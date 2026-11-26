/**
 * Google Drive access for NIJI VOICE.
 *
 * - OAuth 2.0 through Google Identity Services (token model, no server)
 * - Lists a folder tree inside a (shared) drive with supportsAllDrives
 * - Reads just an MP3's ID3 tag with a ranged request
 * - Keeps the shared `_niji_voice_meta.json` (tags / notes / durations / subtitles)
 *
 * Everything happens in the browser with the user's own Google account;
 * no token, key or file content is ever stored in this repository.
 */

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|ogg|opus|mp4)$/i;

export const SCOPES = 'https://www.googleapis.com/auth/drive';

const DRIVE_PARAMS = {
  supportsAllDrives: 'true',
  includeItemsFromAllDrives: 'true',
};

export function isImage(file) {
  if (!file) return false;
  const mime = file.mimeType || '';
  const name = String(file.name || '').toLowerCase();
  return mime.startsWith('image/') || /\.(png|jpe?g|webp)$/.test(name);
}

/** a Drive image's own thumbnail, big enough to fill a series tile */
export function coverUrlOf(file) {
  const link = file && file.thumbnailLink;
  if (!link) return null;
  return link.replace(/=s\d+(-c)?$/, '=s640');
}

export function isAudio(file) {
  if (!file) return false;
  const mime = file.mimeType || '';
  if (mime.startsWith('audio/')) return true;
  if (mime === 'application/octet-stream' && AUDIO_RE.test(file.name || '')) return true;
  if (file.name && AUDIO_RE.test(file.name) && mime !== FOLDER_MIME) return true;
  return false;
}

export class NeedsAuth extends Error {
  constructor(message = 'Google 계정 연결이 필요합니다.') {
    super(message);
    this.name = 'NeedsAuth';
  }
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.set(k, v);
  }
  return u.toString();
}

export class Drive {
  constructor() {
    this.clientId = '';
    this.token = '';
    this.expiresAt = 0;
    this.hint = '';
    this.tokenClient = null;
    this.gisLoading = null;
    this.pending = null;
  }

  /* token kept in localStorage so a reload / app relaunch stays signed in */
  static get TOKEN_KEY() { return 'niji.token'; }

  _persistToken() {
    try {
      localStorage.setItem(Drive.TOKEN_KEY, JSON.stringify({
        token: this.token,
        expiresAt: this.expiresAt,
        hint: this.hint || '',
      }));
    } catch {}
  }

  async _rememberHint() {
    if (this.hint) return this.hint;
    try {
      const res = await this.raw(`${API}/about?${qs({ fields: 'user(emailAddress,displayName)' })}`);
      const json = await res.json();
      this.hint = json?.user?.emailAddress || '';
      if (this.hint) this._persistToken();
    } catch {}
    return this.hint;
  }

  setClientId(clientId) {
    if (clientId && clientId !== this.clientId) {
      this.clientId = clientId;
      this.tokenClient = null;
      this.token = '';
      this.expiresAt = 0;
    }
  }

  get connected() {
    return !!this.token && Date.now() < this.expiresAt - 30_000;
  }

  loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (this.gisLoading) return this.gisLoading;
    this.gisLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Google 로그인 스크립트를 불러오지 못했어요. 네트워크를 확인해 주세요.'));
      document.head.appendChild(s);
    });
    return this.gisLoading;
  }

  async client() {
    if (!this.clientId) throw new NeedsAuth('OAuth Client ID가 설정되지 않았어요.');
    await this.loadGis();
    if (!this.tokenClient) {
      this.tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPES,
        callback: () => {},
      });
    }
    return this.tokenClient;
  }

  requestToken({ prompt, hint } = {}) {
    const client = this.tokenClient;
    if (!client) return Promise.reject(new NeedsAuth());
    return new Promise((resolve, reject) => {
      client.callback = (resp) => {
        if (resp?.access_token) {
          this.token = resp.access_token;
          const ttl = Number(resp.expires_in || 3500) * 1000;
          this.expiresAt = Date.now() + ttl;
          this._persistToken();
          this._rememberHint();
          resolve(this.token);
        } else {
          reject(new NeedsAuth(resp?.error === 'access_denied' ? '연결이 취소되었어요.' : 'Google 계정 연결에 실패했어요.'));
        }
      };
      client.error_callback = (err) => reject(new NeedsAuth(err?.message || 'Google 계정 연결에 실패했어요.'));
      const override = {};
      if (prompt !== undefined) override.prompt = prompt;
      const h = hint !== undefined ? hint : this.hint;
      if (h) override.login_hint = h;
      try {
        client.requestAccessToken(override);
      } catch (e) {
        reject(e);
      }
    });
  }

  restore() {
    try {
      let raw = localStorage.getItem(Drive.TOKEN_KEY);
      if (!raw) raw = sessionStorage.getItem(Drive.TOKEN_KEY);
      if (!raw) return false;
      const { token, expiresAt, hint } = JSON.parse(raw);
      this.hint = hint || '';
      if (token && Date.now() < expiresAt - 30_000) {
        this.token = token;
        this.expiresAt = expiresAt;
        this._persistToken();
        try { sessionStorage.removeItem(Drive.TOKEN_KEY); } catch {}
        return true;
      }
      // keep the hint for a silent refresh later
      this._persistToken();
      return false;
    } catch {}
    return false;
  }

  /** Make sure there is a usable token; silent refresh first when possible. */
  async ensure({ interactive = false } = {}) {
    if (this.connected) return this.token;
    await this.client();
    try {
      // one quiet refresh attempt with the saved login hint
      return await this.requestToken({ prompt: '' });
    } catch (e) {
      if (!interactive) throw new NeedsAuth();
      return this.requestToken({ prompt: 'select_account' });
    }
  }

  signOut() {
    const token = this.token;
    this.token = '';
    this.expiresAt = 0;
    try { localStorage.removeItem(Drive.TOKEN_KEY); } catch {}
    try { sessionStorage.removeItem(Drive.TOKEN_KEY); } catch {}
    try {
      if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token);
    } catch {}
  }

  async raw(url, opts = {}, retried = false) {
    await this.ensure();
    const headers = new Headers(opts.headers || {});
    headers.set('Authorization', `Bearer ${this.token}`);
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 401 && !retried) {
      this.token = '';
      this.expiresAt = 0;
      await this.ensure();
      return this.raw(url, opts, true);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch {}
      const err = new Error(detail || `Drive 요청 실패 (${res.status})`);
      err.status = res.status;
      if (res.status === 401 || res.status === 403 && /invalid/i.test(detail)) throw new NeedsAuth();
      throw err;
    }
    return res;
  }

  async listChildren(folderId) {
    const out = [];
    let pageToken = '';
    do {
      const query = qs({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id,name,mimeType,size,createdTime,modifiedTime,parents,driveId,thumbnailLink)',
        pageSize: '1000',
        ...DRIVE_PARAMS,
        pageToken,
        orderBy: 'name_natural',
      });
      const res = await this.raw(`${API}/files?${query}`);
      const json = await res.json();
      out.push(...(json.files || []));
      pageToken = json.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  /**
   * Walk a folder tree.
   * @returns {Promise<{folders: Array, files: Array, root: object}>}
   */
  async tree(rootId, { onProgress, concurrency = 4, skipFolder } = {}) {
    const root = { id: rootId, name: 'NIJI VOICE', parentId: null, driveId: null };
    const folders = [];
    const files = [];
    let done = 0;
    const queue = [root];
    const seen = new Set();

    const worker = async () => {
      while (queue.length) {
        const folder = queue.shift();
        if (seen.has(folder.id)) continue;
        seen.add(folder.id);
        let children = [];
        try {
          children = await this.listChildren(folder.id);
        } catch (e) {
          if (e instanceof NeedsAuth) throw e;
          children = [];
        }
        const img = children.find((f) => isImage(f));
        for (const f of children) {
          if (f.mimeType === FOLDER_MIME) {
            if (skipFolder && skipFolder(f.name)) continue;
            const entry = { id: f.id, name: f.name, parentId: folder.id, driveId: f.driveId || folder.driveId || null };
            folders.push(entry);
            queue.push(entry);
          } else if (isAudio(f)) {
            files.push({
              id: f.id,
              name: f.name,
              size: Number(f.size || 0),
              createdTime: f.createdTime,
              modifiedTime: f.modifiedTime,
              parentId: folder.id,
              driveId: f.driveId || folder.driveId || null,
              folderCover: img ? coverUrlOf(img) : null,
            });
          }
        }
        done += 1;
        onProgress?.({ done, folders: folders.length, files: files.length });
        if (onProgress && queue.length) await new Promise((r) => setTimeout(r, 0));
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, 4) }, worker));
    return { root, folders, files };
  }

  async listDrives() {
    const out = [];
    let pageToken = '';
    do {
      const query = qs({ pageSize: '100', fields: 'nextPageToken, drives(id,name)', pageToken });
      const res = await this.raw(`${API}/drives?${query}`);
      const json = await res.json();
      out.push(...(json.drives || []));
      pageToken = json.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  async findFolderByName(name) {
    const query = qs({
      q: `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: 'files(id,name,driveId,parents)',
      pageSize: '50',
      corpora: 'allDrives',
      ...DRIVE_PARAMS,
    });
    const res = await this.raw(`${API}/files?${query}`);
    const json = await res.json();
    return json.files || [];
  }

  async getFileMeta(fileId, fields = 'id,name,size,mimeType,modifiedTime') {
    const res = await this.raw(`${API}/files/${fileId}?${qs({ fields, ...DRIVE_PARAMS })}`);
    return res.json();
  }

  /** Download a byte range (or the whole file) with progress reporting. */
  async download(fileId, { range, onProgress, signal } = {}) {
    const headers = {};
    if (range) headers.Range = range;
    const res = await this.raw(`${API}/files/${fileId}?${qs({ alt: 'media', ...DRIVE_PARAMS })}`, { headers, signal });
    const total = Number(res.headers.get('Content-Length') || 0);
    if (!onProgress || !res.body || !total) return res.arrayBuffer();

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress({ received, total });
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out.buffer;
  }

  /** Fetch only the ID3v2 tag at the head of a file. */
  async readId3(fileId, { signal } = {}) {
    const headBuf = await this.download(fileId, { range: 'bytes=0-15', signal });
    const head = new Uint8Array(headBuf);
    const { id3TagLength } = await import('./id3.js');
    let total = 0;
    try { total = id3TagLength(head); } catch {}
    if (!total) return null;
    const need = Math.min(total, 8 * 1024 * 1024);
    const buf = await this.download(fileId, { range: `bytes=0-${need - 1}`, signal });
    return buf;
  }

  async getText(fileId) {
    const res = await this.raw(`${API}/files/${fileId}?${qs({ alt: 'media', ...DRIVE_PARAMS })}`);
    return res.text();
  }

  async findChildByName(folderId, name) {
    const query = qs({
      q: `'${folderId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
      fields: 'files(id,name,mimeType,modifiedTime,size)',
      pageSize: '10',
      ...DRIVE_PARAMS,
    });
    const res = await this.raw(`${API}/files?${query}`);
    const json = await res.json();
    return json.files?.[0] || null;
  }

  async createJsonFile(folderId, name, text) {
    const boundary = 'niji' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' });
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n` +
      `--${boundary}--`;
    const res = await this.raw(`${UPLOAD}/files?${qs({ uploadType: 'multipart', fields: 'id,name,modifiedTime', ...DRIVE_PARAMS })}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.json();
  }

  async updateJsonFile(fileId, text) {
    const res = await this.raw(`${UPLOAD}/files/${fileId}?${qs({ uploadType: 'media', fields: 'id,name,modifiedTime', ...DRIVE_PARAMS })}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: text,
    });
    return res.json();
  }
}

/* ─────────────────────────── shared metadata ─────────────────────────── */

export const META_NAME = '_niji_voice_meta.json';

function emptyMeta() {
  return { version: 1, updatedAt: '', tags: {}, notes: {}, durations: {}, transcripts: {} };
}

function noteId(n) {
  if (n.id) return n.id;
  return 'n_' + Math.abs(hash(`${n.author}|${n.createdAt}|${n.text}`)).toString(36);
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}

export function normalizeMeta(raw) {
  const m = emptyMeta();
  if (raw && typeof raw === 'object') {
    if (raw.tags && typeof raw.tags === 'object') {
      for (const [k, v] of Object.entries(raw.tags)) if (Array.isArray(v)) m.tags[k] = [...new Set(v.filter(Boolean).map(String))];
    }
    if (raw.notes && typeof raw.notes === 'object') {
      for (const [k, v] of Object.entries(raw.notes)) {
        if (!Array.isArray(v)) continue;
        m.notes[k] = v.filter((n) => n && typeof n.text === 'string').map((n) => ({
          id: noteId(n),
          author: String(n.author || '익명').slice(0, 30),
          text: String(n.text || '').slice(0, 500),
          t: typeof n.t === 'number' ? n.t : (typeof n.timestampSeconds === 'number' ? n.timestampSeconds : null),
          createdAt: n.createdAt || new Date(0).toISOString(),
        }));
      }
    }
    if (raw.durations && typeof raw.durations === 'object') {
      for (const [k, v] of Object.entries(raw.durations)) if (Number.isFinite(Number(v))) m.durations[k] = Number(v);
    }
    if (raw.transcripts && typeof raw.transcripts === 'object') {
      for (const [k, v] of Object.entries(raw.transcripts)) {
        if (!v || typeof v !== 'object') continue;
        m.transcripts[k] = {
          original: String(v.original || '').slice(0, 20000),
          translated: String(v.translated || '').slice(0, 20000),
          source: v.source || 'manual',
          author: String(v.author || '').slice(0, 30),
          updatedAt: v.updatedAt || new Date(0).toISOString(),
        };
      }
    }
    m.updatedAt = raw.updatedAt || '';
  }
  return m;
}

export class SharedMeta {
  constructor(drive, rootId) {
    this.drive = drive;
    this.rootId = rootId;
    this.data = emptyMeta();
    this.fileId = null;
    this.modifiedTime = '';
    this.queue = Promise.resolve();
    this.removedTags = new Map();   // fileId -> Set(tag)
    this.removedNotes = new Set();  // note ids
    this.lastError = null;
    this.onError = null;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) { try { fn(this.data); } catch {} } }

  async load() {
    const meta = await this.drive.findChildByName(this.rootId, META_NAME);
    if (!meta) {
      this.data = emptyMeta();
      this.fileId = null;
      return this.data;
    }
    this.fileId = meta.id;
    this.modifiedTime = meta.modifiedTime || '';
    try {
      const text = await this.drive.getText(meta.id);
      this.data = normalizeMeta(JSON.parse(text));
    } catch {
      this.data = emptyMeta();
    }
    this.emit();
    return this.data;
  }

  /** Apply a mutation locally and persist it, merged with the latest remote copy. */
  commit(mutate) {
    mutate(this.data);
    this.data.updatedAt = new Date().toISOString();
    this.emit();
    this.queue = this.queue.then(() => this.flush()).catch((e) => {
      this.lastError = e;
      console.warn('[meta] save failed', e);
      try { this.onError?.(e); } catch {}
      this.emit();
    });
    return this.queue;
  }

  mergeWith(remote) {
    const local = this.data;
    const out = normalizeMeta(remote);

    for (const [fileId, tags] of Object.entries(local.tags)) {
      const set = new Set(out.tags[fileId] || []);
      for (const t of tags) set.add(t);
      for (const t of this.removedTags.get(fileId) || []) set.delete(t);
      if (set.size) out.tags[fileId] = [...set]; else delete out.tags[fileId];
    }

    for (const [fileId, notes] of Object.entries(local.notes)) {
      const byId = new Map((out.notes[fileId] || []).map((n) => [n.id, n]));
      for (const n of notes) if (!byId.has(n.id)) byId.set(n.id, n);
      const merged = [...byId.values()]
        .filter((n) => !this.removedNotes.has(n.id))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      if (merged.length) out.notes[fileId] = merged; else delete out.notes[fileId];
    }

    for (const [fileId, v] of Object.entries(local.transcripts)) {
      const r = out.transcripts[fileId];
      if (!r || String(v.updatedAt) >= String(r.updatedAt)) out.transcripts[fileId] = v;
    }

    Object.assign(out.durations, local.durations);
    out.updatedAt = new Date().toISOString();
    return out;
  }

  async flush() {
    if (!this.drive.connected && !this.drive.token) return;
    let remote = emptyMeta();
    if (this.fileId) {
      try {
        remote = normalizeMeta(JSON.parse(await this.drive.getText(this.fileId)));
      } catch {
        remote = emptyMeta();
      }
    } else {
      const found = await this.drive.findChildByName(this.rootId, META_NAME);
      if (found) {
        this.fileId = found.id;
        try { remote = normalizeMeta(JSON.parse(await this.drive.getText(found.id))); } catch {}
      }
    }

    const merged = this.mergeWith(remote);
    this.data = merged;
    const text = JSON.stringify(merged, null, 1);

    if (this.fileId) {
      const r = await this.drive.updateJsonFile(this.fileId, text);
      this.modifiedTime = r.modifiedTime || '';
    } else {
      const r = await this.drive.createJsonFile(this.rootId, META_NAME, text);
      this.fileId = r.id;
      this.modifiedTime = r.modifiedTime || '';
    }
    this.emit();
  }

  /* convenience mutations */
  tagsOf(fileId) { return this.data.tags[fileId] || []; }

  async addTags(fileIds, tag) {
    const t = String(tag || '').trim();
    if (!t) return;
    return this.commit((d) => {
      for (const id of fileIds) {
        const set = new Set(d.tags[id] || []);
        set.add(t);
        d.tags[id] = [...set];
        this.removedTags.get(id)?.delete(t);
      }
    });
  }

  async removeTag(fileId, tag) {
    return this.commit((d) => {
      if (!d.tags[fileId]) return;
      d.tags[fileId] = d.tags[fileId].filter((x) => x !== tag);
      if (!d.tags[fileId].length) delete d.tags[fileId];
      if (!this.removedTags.has(fileId)) this.removedTags.set(fileId, new Set());
      this.removedTags.get(fileId).add(tag);
    });
  }

  notesOf(fileId) { return (this.data.notes[fileId] || []).slice().sort((a, b) => (a.t ?? 0) - (b.t ?? 0)); }

  async addNote(fileId, { author, text, t }) {
    const note = {
      id: 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      author: String(author || '익명').slice(0, 30),
      text: String(text || '').slice(0, 500),
      t: Number.isFinite(t) ? Math.round(t * 10) / 10 : null,
      createdAt: new Date().toISOString(),
    };
    await this.commit((d) => {
      d.notes[fileId] = [...(d.notes[fileId] || []), note];
    });
    return note;
  }

  async removeNote(fileId, noteIdValue) {
    this.removedNotes.add(noteIdValue);
    return this.commit((d) => {
      d.notes[fileId] = (d.notes[fileId] || []).filter((n) => n.id !== noteIdValue);
      if (!d.notes[fileId].length) delete d.notes[fileId];
    });
  }

  async setDuration(fileId, seconds) {
    const v = Math.round(Number(seconds) || 0);
    if (!v) return;
    if (this.data.durations[fileId] === v) return;
    this.data.durations[fileId] = v;
    this.queue = this.queue.then(() => this.flush()).catch(() => {});
  }

  async setTranscript(fileId, { original, translated, author }) {
    return this.commit((d) => {
      d.transcripts[fileId] = {
        original: String(original || '').slice(0, 20000),
        translated: String(translated || '').slice(0, 20000),
        source: 'manual',
        author: String(author || '').slice(0, 30),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  allNotes() {
    const rows = [];
    for (const [fileId, notes] of Object.entries(this.data.notes)) {
      for (const n of notes) rows.push({ ...n, fileId });
    }
    return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
}
