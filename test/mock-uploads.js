// Nachbau der Google-/YouTube- und TikTok-Schnittstellen für die Upload-Tests (UCC_UPLOAD_API).
// Pfade: /youtube/<Originalpfad> und /tiktok/<Originalpfad> (siehe apiUrl in src/uploads.js).
import http from 'node:http';
import crypto from 'node:crypto';

export async function startUploadMock() {
  const st = { codes: new Map(), tokens: new Set(), yt: [], tt: [], ttInbox: 0, tokenCalls: [], revoked: [], failNext: 0, ttPending: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const form = () => Object.fromEntries(new URLSearchParams(raw.toString()));
    const json = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    const authed = () => st.tokens.has(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    const p = url.pathname;
    if (st.failNext > 0 && /upload|init/.test(p) && req.method !== 'PUT') { st.failNext--; return json(503, { error: { message: 'kurz weg' } }); }
    // ---- Google ----
    if (p === '/youtube/token' && req.method === 'POST') {
      const f = form(); st.tokenCalls.push(f);
      if (f.grant_type === 'authorization_code') {
        const c = st.codes.get(f.code);
        const ok = c && crypto.createHash('sha256').update(f.code_verifier || '').digest('base64url') === c.challenge && f.redirect_uri === c.redirect;
        if (!ok) return json(400, { error: 'invalid_grant', error_description: 'Bad code or verifier' });
        st.codes.delete(f.code);
      } else if (f.grant_type !== 'refresh_token' || f.refresh_token !== 'yt-refresh') return json(400, { error: 'invalid_grant' });
      const at = `yt-at-${crypto.randomBytes(4).toString('hex')}`; st.tokens.add(at);
      return json(200, { access_token: at, expires_in: 3599, ...(f.grant_type === 'authorization_code' ? { refresh_token: 'yt-refresh' } : {}), token_type: 'Bearer' });
    }
    if (p === '/youtube/revoke') { st.revoked.push('youtube'); return json(200, {}); }
    if (p === '/youtube/upload/youtube/v3/videos' && req.method === 'POST') {
      if (!authed()) return json(401, { error: { message: 'Invalid Credentials' } });
      const meta = JSON.parse(raw.toString() || '{}');
      const id = `vid${st.yt.length + 1}`;
      st.yt.push({ id, meta, size: Number(req.headers['x-upload-content-length']), bytes: 0 });
      return json(200, {}, { Location: `http://127.0.0.1:${server.address().port}/youtube/session/${id}` });
    }
    if (p.startsWith('/youtube/session/') && req.method === 'PUT') {
      const v = st.yt.find((x) => x.id === p.split('/').pop());
      v.bytes = raw.length;
      return json(200, { id: v.id, status: { privacyStatus: v.meta.status.privacyStatus } });
    }
    // ---- TikTok ----
    if (p === '/tiktok/v2/oauth/token/' && req.method === 'POST') {
      const f = form(); st.tokenCalls.push(f);
      if (f.client_secret !== 'tt-secret') return json(401, { error: 'invalid_client', error_description: 'Client secret is wrong' });
      if (f.grant_type === 'authorization_code') {
        const c = st.codes.get(f.code);
        const ok = c && crypto.createHash('sha256').update(f.code_verifier || '').digest('hex') === c.challenge && f.redirect_uri === c.redirect;
        if (!ok) return json(400, { error: 'invalid_grant', error_description: 'Bad code or verifier' });
        st.codes.delete(f.code);
      }
      const at = `tt-at-${crypto.randomBytes(4).toString('hex')}`; st.tokens.add(at);
      return json(200, { access_token: at, expires_in: 86400, refresh_token: 'tt-refresh', refresh_expires_in: 31536000, open_id: 'oid1', scope: 'user.info.basic,video.upload', token_type: 'Bearer' });
    }
    if (p === '/tiktok/v2/oauth/revoke/') { st.revoked.push('tiktok'); return json(200, {}); }
    if (p === '/tiktok/v2/user/info/') return authed() ? json(200, { data: { user: { display_name: 'UnknownGER' } }, error: { code: 'ok' } }) : json(401, { error: { code: 'access_token_invalid' } });
    if (p === '/tiktok/v2/post/publish/inbox/video/init/' && req.method === 'POST') {
      if (!authed()) return json(401, { error: { code: 'access_token_invalid', message: 'bad token' } });
      if (st.ttPending >= 5) return json(403, { error: { code: 'spam_risk_too_many_pending_share', message: 'too many' } });
      const b = JSON.parse(raw.toString());
      const id = `pub${st.tt.length + 1}`;
      st.tt.push({ id, info: b.source_info, bytes: 0, ranges: [] });
      return json(200, { data: { publish_id: id, upload_url: `http://127.0.0.1:${server.address().port}/tiktok/put/${id}` }, error: { code: 'ok' } });
    }
    if (p.startsWith('/tiktok/put/') && req.method === 'PUT') {
      const v = st.tt.find((x) => x.id === p.split('/').pop());
      v.bytes += raw.length; v.ranges.push(req.headers['content-range']);
      return json(201, {});
    }
    if (p === '/tiktok/v2/post/publish/status/fetch/' && req.method === 'POST') {
      const b = JSON.parse(raw.toString());
      const v = st.tt.find((x) => x.id === b.publish_id);
      const done = v && v.bytes === v.info.video_size;
      if (done && !v.counted) { v.counted = true; st.ttPending++; st.ttInbox++; }
      return json(200, { data: { status: done ? 'SEND_TO_USER_INBOX' : 'PROCESSING_UPLOAD' }, error: { code: 'ok' } });
    }
    json(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    st,
    base: `http://127.0.0.1:${server.address().port}`,
    // Simuliert den Browser: Anmeldeseite "bestätigt" und leitet mit Code auf die Loopback-Adresse um.
    async approve(authUrl) {
      const u = new URL(authUrl);
      const code = `code-${crypto.randomBytes(4).toString('hex')}`;
      st.codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri') });
      const back = new URL(u.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state'));
      const r = await fetch(back);
      return { status: r.status, text: await r.text(), params: u.searchParams };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
