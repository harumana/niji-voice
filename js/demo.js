/**
 * Demo mode — lets every screen and feature be tried before a Google
 * account is connected. Audio is synthesised in the browser (a soft
 * pentatonic loop), so no audio file is stored in this repository.
 */

const ROOT = { id: 'demo-root', name: 'NIJI VOICE', parentId: null };

const FOLDERS = [
  { id: 'f-haru', name: '甲斐田晴(카이다 하루)', parentId: 'demo-root' },
  { id: 'f-haru-2026', name: '2026_誕生日ボイス', parentId: 'f-haru' },
  { id: 'f-haru-2025', name: '2025_ASMR', parentId: 'f-haru' },
  { id: 'f-mana', name: '02_緋八 マナ(히바치 마나)', parentId: 'demo-root' },
  { id: 'f-mana-2026', name: '2026_全肯定ボイス', parentId: 'f-mana' },
  { id: 'f-mana-2025', name: '2025_エスコートボイス', parentId: 'f-mana' },
  { id: 'f-drama', name: '03_ボイスドラマ', parentId: 'demo-root' },
  { id: 'f-drama-2026', name: '2026_アニコブ', parentId: 'f-drama' },
];

const LRC_HARU = `[00:00.00] 誕生日おめでとう。 / 생일 축하해.
[00:04.20] 今日は君が主役の日だよ。 / 오늘은 네가 주인공인 날이야.
[00:08.60] ゆっくり休んで、好きなものを食べてね。 / 푹 쉬고 좋아하는 거 먹어.
[00:13.40] 一年、本当にお疲れさま。 / 1년 동안 정말 수고했어.
[00:18.00] また来年も、こうして祝わせてね。 / 내년에도 이렇게 축하하게 해 줘.
[00:23.10] おやすみ、いい夢を。 / 잘 자, 좋은 꿈 꿔.`;

const LRC_MANA = `[00:00.00] マナはぜんぶ肯定しちゃうよ。 / 마나는 전부 긍정해 버릴 거야.
[00:03.80] 今日ちょっと疲れたんでしょ？ / 오늘 조금 피곤했지?
[00:07.50] そういう日があってもいいんだよ。 / 그런 날이 있어도 괜찮아.
[00:11.90] よく頑張ったね、えらいえらい。 / 잘했어, 기특해 기특해.
[00:16.40] 一緒に深呼吸しようか。 / 같이 심호흡해 볼까.
[00:20.80] すーっと吸って、はーっと吐いて。 / 스읍 들이쉬고, 후우 내쉬고.
[00:26.00] また明日も、マナがそばにいるよ。 / 내일도 마나가 옆에 있을게.`;

const LRC_DRAMA = `[00:00.00] おい、ちょっと待ってくれ。 / 야, 잠깐만 기다려 봐.
[00:02.60] その書類、俺が持ってる。 / 그 서류, 내가 들고 있어.
[00:05.80] ああ、ありがとう。助かった。 / 아, 고마워. 살았다.
[00:09.00] それより、昼は何にする？ / 그보다 점심은 뭐 먹을까?
[00:12.50] んー、そこの定食屋はどうだ？ / 음, 저기 정식집은 어때?
[00:16.00] いいね、行こう行こう。 / 좋아, 가자 가자.`;

const LRC_NONE = '';

function track(o) {
  return {
    id: o.id,
    name: o.name,
    size: o.size,
    createdTime: o.createdTime,
    modifiedTime: o.createdTime,
    parentId: o.parentId,
    demo: true,
    demoMeta: {
      title: o.title,
      artist: o.artist,
      album: o.album,
      year: o.year,
      lrc: o.lrc || '',
      cover: o.cover,
      seed: o.seed,
      duration: o.duration || 32,
    },
  };
}

export const DEMO_FILES = [
  track({
    id: 'demo-1', name: '01_Kaida Haru_2026_Birthday_Voice.mp3', size: 5_812_000,
    createdTime: '2026-11-19T03:20:00.000Z', parentId: 'f-haru-2026',
    title: '01_誕生日ボイス_甲斐田晴', artist: '甲斐田晴', album: '2026 誕生日ボイス', year: '2026',
    lrc: LRC_HARU, cover: ['#6d5efc', '#c4b5fd', 'HARU'], seed: 3, duration: 33,
  }),
  track({
    id: 'demo-2', name: '02_Kaida Haru_2026_Birthday_Voice_Ex.mp3', size: 2_431_000,
    createdTime: '2026-11-19T03:21:00.000Z', parentId: 'f-haru-2026',
    title: '02_誕生日ボイス_甲斐田晴(EX)', artist: '甲斐田晴', album: '2026 誕生日ボイス', year: '2026',
    lrc: LRC_HARU, cover: ['#3b82f6', '#93c5fd', 'HARU EX'], seed: 5, duration: 29,
  }),
  track({
    id: 'demo-3', name: '01_Hibachi Mana_2026_Zenkoutei.mp3', size: 3_110_000,
    createdTime: '2026-11-15T10:05:00.000Z', parentId: 'f-mana-2026',
    title: '01_全肯定ボイス_緋八マナ', artist: '緋八マナ', album: '2026 全肯定ボイス', year: '2026',
    lrc: LRC_MANA, cover: ['#0ea5a4', '#99f6e4', 'MANA'], seed: 7, duration: 36,
  }),
  track({
    id: 'demo-4', name: '02_Hibachi Mana_2026_Zenkoutei_Yoru.mp3', size: 2_120_000,
    createdTime: '2026-11-15T10:07:00.000Z', parentId: 'f-mana-2026',
    title: '02_全肯定ボイス_夜', artist: '緋八マナ', album: '2026 全肯定ボイス', year: '2026',
    lrc: LRC_MANA, cover: ['#8b5cf6', '#ddd6fe', 'MANA NIGHT'], seed: 11, duration: 31,
  }),
  track({
    id: 'demo-5', name: '01_Anikobu_ep03_scene2.mp3', size: 12_400_000,
    createdTime: '2026-10-28T14:00:00.000Z', parentId: 'f-drama-2026',
    title: 'アニコブ 3話 — Scene 2', artist: '甲斐田晴 / 緋八マナ', album: 'アニコブ', year: '2026',
    lrc: LRC_DRAMA, cover: ['#f97316', '#fed7aa', 'DRAMA'], seed: 13, duration: 34,
  }),
  track({
    id: 'demo-6', name: '01_Haru_ASMR_Vol1_track1.mp3', size: 24_900_000,
    createdTime: '2026-11-15T22:10:00.000Z', parentId: 'f-haru-2025',
    title: 'ASMR Vol.1 — 01', artist: '甲斐田晴', album: 'ASMR Vol.1', year: '2025',
    lrc: LRC_NONE, cover: ['#334155', '#94a3b8', 'ASMR'], seed: 17, duration: 30,
  }),
  track({
    id: 'demo-7', name: '01_Mana_Escort_Voice.mp3', size: 6_020_000,
    createdTime: '2026-11-16T09:30:00.000Z', parentId: 'f-mana-2025',
    title: 'エスコートボイス — 緋八マナ', artist: '緋八マナ', album: 'エスコートボイス', year: '2025',
    lrc: LRC_NONE, cover: ['#db2777', '#fbcfe8', 'ESCORT'], seed: 19, duration: 28,
  }),
  track({
    id: 'demo-8', name: '01_Haru_ASMR_Vol2_track1.mp3', size: 18_200_000,
    createdTime: '2026-11-16T01:15:00.000Z', parentId: 'f-haru-2025',
    title: 'ASMR Vol.2 — 01', artist: '甲斐田晴', album: 'ASMR Vol.2', year: '2025',
    lrc: LRC_NONE, cover: ['#475569', '#cbd5e1', 'ASMR 2'], seed: 23, duration: 30,
  }),
];

/* ── covers ── */
const coverCache = new Map();
function coverUrl(meta) {
  if (coverCache.has(meta.title)) return coverCache.get(meta.title);
  const [c1, c2, label] = meta.cover;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="600" height="600" fill="url(#g)"/>
  <circle cx="470" cy="130" r="150" fill="#ffffff" opacity=".16"/>
  <circle cx="120" cy="500" r="190" fill="#000000" opacity=".10"/>
  <text x="48" y="300" font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif" font-size="64"
        font-weight="800" fill="#ffffff" opacity=".95">${label}</text>
  <text x="48" y="348" font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif" font-size="24"
        fill="#ffffff" opacity=".8">NIJI VOICE · sample cover</text>
</svg>`;
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  coverCache.set(meta.title, url);
  return url;
}

export function demoParsed(file) {
  const m = file.demoMeta;
  return {
    title: m.title,
    artist: m.artist,
    album: m.album,
    year: m.year,
    coverUrl: coverUrl(m),
    coverType: 'image/svg+xml',
    lyrics: parseLrc(m.lrc),
    duration: m.duration,
  };
}

function parseLrc(text) {
  const out = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/);
    if (!m) continue;
    const time = +m[1] * 60 + +m[2] + (m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0);
    const body = m[4];
    const sep = body.indexOf(' / ');
    out.push({
      time,
      orig: sep >= 0 ? body.slice(0, sep) : body,
      trans: sep >= 0 ? body.slice(sep + 3) : '',
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/* ── synthesised audio ── */
const audioCache = new Map();
export function demoAudioUrl(file) {
  if (audioCache.has(file.id)) return audioCache.get(file.id);
  const url = URL.createObjectURL(makeWav(file.demoMeta.seed || 1, file.demoMeta.duration || 32));
  audioCache.set(file.id, url);
  return url;
}

function makeWav(seed, seconds) {
  const SR = 22050;
  const n = Math.floor(SR * seconds);
  const data = new Int16Array(n);
  const penta = [0, 2, 4, 7, 9, 12, 14, 16];
  const base = 196 * Math.pow(2, (seed % 5) / 12);
  let rnd = seed * 9301 + 49297;
  const rndNext = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };

  const noteLen = SR * 1.05;
  const notes = [];
  for (let t = 0; t < seconds; t += 1.05) {
    const deg = penta[Math.floor(rndNext() * penta.length)];
    notes.push({ start: t, freq: base * Math.pow(2, deg / 12) });
  }

  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // pick the note that is currently ringing (with a small tail)
    let v = 0;
    for (const nt of notes) {
      const dt = t - nt.start;
      if (dt < -0.02 || dt > 1.6) continue;
      const env = Math.min(1, Math.max(0, dt / 0.06)) * Math.exp(-Math.max(0, dt) * 1.9);
      const vib = 1 + 0.0022 * Math.sin(2 * Math.PI * 5.2 * dt);
      const w = Math.sin(2 * Math.PI * nt.freq * vib * dt) * 0.62 +
        Math.sin(2 * Math.PI * nt.freq * 2 * dt) * 0.22 +
        Math.sin(2 * Math.PI * nt.freq * 3 * dt) * 0.08;
      v += w * env;
    }
    // soft pad
    v += Math.sin(2 * Math.PI * base / 2 * t) * 0.05;
    const fade = Math.min(1, t / 0.8) * Math.min(1, (seconds - t) / 1.2);
    const s = Math.max(-1, Math.min(1, v * 0.16 * fade));
    data[i] = s * 32767;
  }

  // WAV header
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + data.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SR, true);
  view.setUint32(28, SR * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, data.length * 2, true);
  return new Blob([header, data.buffer], { type: 'audio/wav' });
}

/* ── demo shared metadata ── */
export function demoMeta() {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  return {
    version: 1,
    updatedAt: iso(now),
    tags: {
      'demo-1': ['생일', '카이다 하루'],
      'demo-3': ['전긍정', '가사 있음'],
      'demo-5': ['드라마', '화자 분리'],
      'demo-6': ['ASMR', '장편'],
    },
    notes: {
      'demo-1': [
        { id: 'dn1', author: '친구', text: '08.6초 "ゆっくり休んで" 부분 목소리 진짜 좋다', t: 8.6, createdAt: iso(now - 1000 * 60 * 95) },
        { id: 'dn2', author: '게스트', text: '여기부터가 하이라이트', t: 13.4, createdAt: iso(now - 1000 * 60 * 60 * 30) },
      ],
      'demo-3': [
        { id: 'dn3', author: '친구', text: '잠들기 전에 듣기 좋음', t: 16.4, createdAt: iso(now - 1000 * 60 * 12) },
      ],
      'demo-6': [
        { id: 'dn4', author: '친구', text: '볼륨 30%로 듣는 게 딱이야', t: 0, createdAt: iso(now - 1000 * 60 * 60 * 6) },
      ],
    },
    durations: { 'demo-1': 33, 'demo-2': 29, 'demo-3': 36, 'demo-4': 31, 'demo-5': 34, 'demo-6': 30, 'demo-7': 28, 'demo-8': 30 },
    transcripts: {},
  };
}

export const DEMO_TREE = { root: ROOT, folders: FOLDERS, files: DEMO_FILES };
