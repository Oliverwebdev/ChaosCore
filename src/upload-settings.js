// Upload-Einstellungen (ohne Abhängigkeit zu config.js, damit config.js sie einbinden kann).
export const UPLOAD_PLATFORMS = ['youtube', 'tiktok'];
export const UPLOAD_WHEN = ['manual', 'after_stream', 'immediate'];
export const YT_PRIVACY = ['private', 'unlisted', 'public'];
export const TIKTOK_DAILY = 5; // offene Entwürfe pro 24 h (TikTok-Regel)

export const UPLOADS_DEFAULT = {
  when: 'manual',
  minScore: 4,
  maxPerStream: 3,
  youtube: { auto: true, privacy: 'private', hashtags: '#Shorts #CS2', description: '' },
  tiktok: { auto: true },
};

const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

export function normalizeUploads(v) {
  const o = v && typeof v === 'object' ? v : {};
  const n = (x, d, lo, hi) => { const k = Math.round(Number(x ?? d)); return k >= lo && k <= hi ? k : d; };
  const yt = o.youtube && typeof o.youtube === 'object' ? o.youtube : {};
  const tt = o.tiktok && typeof o.tiktok === 'object' ? o.tiktok : {};
  return {
    when: UPLOAD_WHEN.includes(o.when) ? o.when : UPLOADS_DEFAULT.when,
    minScore: n(o.minScore, UPLOADS_DEFAULT.minScore, 1, 8),
    maxPerStream: n(o.maxPerStream, UPLOADS_DEFAULT.maxPerStream, 0, 20),
    youtube: {
      auto: yt.auto !== false,
      privacy: YT_PRIVACY.includes(yt.privacy) ? yt.privacy : 'private',
      hashtags: cleanText(yt.hashtags ?? UPLOADS_DEFAULT.youtube.hashtags, 120),
      description: cleanText(yt.description, 1000),
    },
    tiktok: { auto: tt.auto !== false },
  };
}

