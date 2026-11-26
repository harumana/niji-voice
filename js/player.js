/**
 * Audio engine: queue, MediaSession, A–B repeat, sleep timer.
 * Source resolution (offline cache / Drive download) is injected by the app.
 */

/** A fraction of a second of silence: unlocks iOS audio inside a tap. */
const SILENT_WAV = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

export class Player {
  constructor(audio, { resolve, onState, onError } = {}) {
    this.audio = audio;
    this.resolve = resolve;
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.queue = [];
    this.index = -1;
    this.current = null;
    this.isPlaying = false;
    this.shuffle = false;
    this.ab = { a: null, b: null };
    this.sleep = { mode: null, endsAt: null };
    this.loading = false;
    this.loaded = false;
    this.rate = 1;
    this._objectUrl = null;
    this._unlocked = false;
    this._token = 0;
    this._sleepTimer = null;

    this.audio.addEventListener('play', () => { this.isPlaying = true; this._mediaState(); this.emit(); });
    this.audio.addEventListener('pause', () => { this.isPlaying = false; this._mediaState(); this.emit(); });
    this.audio.addEventListener('timeupdate', () => this._tick());
    this.audio.addEventListener('durationchange', () => this.emit());
    this.audio.addEventListener('ended', () => this._ended());
    this.audio.addEventListener('loadedmetadata', () => { this._mediaMeta(); this.emit(); });
    this.audio.addEventListener('error', () => {
      if (this.audio.src) this.onError(new Error('이 파일을 재생하지 못했어요.'));
    });
    this._setupMediaSession();
  }

  emit() {
    this.onState({
      current: this.current,
      isPlaying: this.isPlaying,
      loading: this.loading,
      currentTime: this.audio.currentTime || 0,
      duration: Number.isFinite(this.audio.duration) ? this.audio.duration : 0,
      ab: { ...this.ab },
      sleep: { ...this.sleep },
      shuffle: this.shuffle,
      rate: this.rate,
      queueLength: this.queue.length,
    });
  }

  _tick() {
    const { a, b } = this.ab;
    if (a != null && b != null && b > a) {
      if (this.audio.currentTime >= b - 0.02 || this.audio.currentTime < a - 0.4) {
        this.audio.currentTime = a;
      }
    }
    this._positionState();
    this.emit();
  }

  /* ── queue ── */
  setQueue(files, startIndex = 0) {
    this.queue = files.slice();
    this.index = startIndex >= 0 && startIndex < files.length ? startIndex : -1;
  }

  playFiles(files, startIndex = 0, { startAt = 0 } = {}) {
    if (!files.length) return;
    this.setQueue(files, startIndex);
    return this.load(files[startIndex], { startAt });
  }

  async load(file, { startAt = 0, autoplay = true } = {}) {
    if (!file) return;
    const token = ++this._token;
    this.current = file;
    this.loading = true;
    this.emit();

    let resolved;
    try {
      resolved = await this.resolve(file);
    } catch (e) {
      if (token !== this._token) return;
      this.loading = false;
      this.emit();
      this.onError(e);
      return;
    }
    if (token !== this._token) return;

    if (this._objectUrl && this._objectUrl !== resolved.url) {
      try { URL.revokeObjectURL(this._objectUrl); } catch {}
    }
    this._objectUrl = resolved.url;
    this.audio.src = resolved.url;
    this.loaded = true;
    this.audio.currentTime = 0;
    try { this.audio.playbackRate = this.rate || 1; } catch {}
    this._parsed = resolved.parsed || null;
    this.ab = { a: null, b: null };
    this.loading = false;
    this._mediaMeta();

    if (startAt > 0) {
      const seek = () => { try { this.audio.currentTime = startAt; } catch {} };
      if (this.audio.readyState >= 1) seek();
      else this.audio.addEventListener('loadedmetadata', seek, { once: true });
    }
    if (autoplay) {
      try {
        await this.audio.play();
      } catch (e) {
        // Autoplay blocked or the URL expired — surfacing is enough here.
        this.isPlaying = false;
      }
    }
    this.emit();
  }

  toggle() {
    if (!this.current) return false;
    if (this.audio.paused) {
      this.audio.play().catch((e) => this.onError(e));
    } else {
      this.audio.pause();
    }
    return true;
  }

  pause() { this.audio.pause(); }

  /** Unlock the audio element inside a user gesture so later async play() works. */
  unlock() {
    if (this._unlocked) return;
    this._unlocked = true;
    try {
      if (!this.audio.src) {
        this.audio.src = SILENT_WAV;
        const p = this.audio.play();
        if (p?.catch) p.catch(() => {});
      }
    } catch {}
  }

  seek(seconds) {
    if (!this.current) return;
    const d = Number.isFinite(this.audio.duration) ? this.audio.duration : Infinity;
    this.audio.currentTime = Math.max(0, Math.min(seconds, d - 0.05));
    this.emit();
  }

  next({ auto = false } = {}) {
    if (!this.queue.length) return;
    let idx;
    if (this.shuffle && this.queue.length > 1) {
      do { idx = Math.floor(Math.random() * this.queue.length); } while (idx === this.index);
    } else {
      idx = this.index + 1;
      if (idx >= this.queue.length) {
        if (auto) return false;
        idx = 0;
      }
    }
    this.index = idx;
    this.load(this.queue[idx]);
    return true;
  }

  prev() {
    if (!this.queue.length) return;
    if (this.audio.currentTime > 4) { this.seek(0); return; }
    let idx = this.index - 1;
    if (idx < 0) idx = this.queue.length - 1;
    this.index = idx;
    this.load(this.queue[idx]);
  }

  _ended() {
    if (this.sleep.mode === 'track') {
      this.clearSleep();
      this.isPlaying = false;
      this.emit();
      return;
    }
    const moved = this.next({ auto: true });
    if (!moved) { this.isPlaying = false; this.emit(); }
  }

  /* ── A–B repeat ── */
  cycleAB() {
    const t = this.audio.currentTime || 0;
    if (this.ab.a == null) {
      this.ab = { a: t, b: null };
      this.emit();
      return { step: 'a', t };
    }
    if (this.ab.b == null) {
      if (t <= this.ab.a + 0.8) {
        this.ab = { a: null, b: null };
        this.emit();
        return { step: 'reset', t };
      }
      this.ab = { a: this.ab.a, b: t };
      this.emit();
      return { step: 'b', t };
    }
    this.ab = { a: null, b: null };
    this.emit();
    return { step: 'reset', t };
  }

  clearAB() {
    this.ab = { a: null, b: null };
    this.emit();
  }

  /* ── sleep timer ── */
  setSleep(mode) {
    clearInterval(this._sleepTimer);
    if (!mode) { this.clearSleep(); return; }
    if (mode === 'track') {
      this.sleep = { mode: 'track', endsAt: null };
    } else {
      const minutes = Number(mode);
      this.sleep = { mode: minutes, endsAt: Date.now() + minutes * 60_000 };
    }
    this._sleepTimer = setInterval(() => {
      if (this.sleep.endsAt && Date.now() >= this.sleep.endsAt) {
        this.pause();
        this.clearSleep();
      } else {
        this.emit();
      }
    }, 1000);
    this.emit();
  }

  clearSleep() {
    clearInterval(this._sleepTimer);
    this._sleepTimer = null;
    this.sleep = { mode: null, endsAt: null };
    this.emit();
  }

  setShuffle(on) {
    this.shuffle = !!on;
    this.emit();
  }

  setRate(rate) {
    const r = Number(rate) || 1;
    this.rate = r;
    try { this.audio.playbackRate = r; } catch {}
    this.emit();
    return r;
  }

  get parsed() { return this._parsed || null; }

  /* ── MediaSession (lock screen / control center) ── */
  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const safe = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };
    safe('play', () => this.toggle());
    safe('pause', () => this.pause());
    safe('previoustrack', () => this.prev());
    safe('nexttrack', () => this.next());
    safe('seekbackward', () => this.seek((this.audio.currentTime || 0) - 15));
    safe('seekforward', () => this.seek((this.audio.currentTime || 0) + 15));
    safe('seekto', (d) => { if (d.seekTime != null) this.seek(d.seekTime); });
  }

  _mediaMeta() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    const p = this._parsed || {};
    const title = p.title || (this.current?.name || 'NIJI VOICE').replace(/\.[a-z0-9]+$/i, '');
    const artist = p.artist || p.albumArtist || 'NIJI VOICE';
    const album = p.album || '';
    const artwork = p.coverUrl ? [{ src: p.coverUrl, sizes: '512x512', type: p.coverType || 'image/jpeg' }] : undefined;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork });
    } catch {}
    this._mediaState();
  }

  _mediaState() {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused'; } catch {}
  }

  _positionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = this.audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        position: Math.min(this.audio.currentTime || 0, d),
        playbackRate: this.audio.playbackRate || 1,
      });
    } catch {}
  }
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return h ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}
