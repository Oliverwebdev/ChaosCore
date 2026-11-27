// Nachbau der Google-/YouTube- und TikTok-Schnittstellen für die Upload-Tests (UCC_UPLOAD_API).
// Pfade: /youtube/<Originalpfad> und /tiktok/<Originalpfad> (siehe apiUrl in src/uploads.js).
import http from 'node:http';
import crypto from 'node:crypto';

export async function startUploadMock() {
  const st = { codes: new Map(), tokens: new Set(), yt: [], tt: [], ttInbox: 0, tokenCalls: [], revoked: [], failNext: 0, ttPending: 0, aiKey: 'AIzaTestKey_1234567890abcdef', openaiKey: 'sk-test-openai-1234567890abcdef', anthropicKey: 'sk-ant-test-1234567890abcdef', aiFail: 0, aiRejectVideo: false, compatVision: false, aiPrompts: [] };
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
    // ---- KI-Anbieter (Gemini, OpenAI, Anthropic, OpenAI-kompatibel) ----
    const aiAnswer = (prompt) => {
      if (prompt.includes('{"ok": true}')) return { ok: true };
      if (prompt.includes('Twitch-Stream-Titel')) return { title: 'Chaos-Abend: Ihr steuert mein CS2!', tags: ['CS2', 'Deutsch', 'Chaos Control', 'Interaktiv!'] };
      return { title: 'Vier auf einen Streich #wow', hashtags: ['#CS2', 'Ace', '#Clutch', '#Shorts'], description: 'Eine Runde, vier Kills, null Gnade.', summary: 'Der Streamer holt vier Kills in einer Runde.' };
    };
    const aiFailNow = () => { if (st.aiFail) { const c = st.aiFail; json(c, { error: { code: c, message: 'nope', status: c === 429 ? 'RESOURCE_EXHAUSTED' : 'X' } }); return true; } return false; };
    if (p === '/gemini/v1beta/models' && req.method === 'GET') {
      if (req.headers['x-goog-api-key'] !== st.aiKey) return json(400, { error: { code: 400, message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } });
      return json(200, { models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }, { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] }] });
    }
    if (p.startsWith('/gemini/v1beta/models/') && p.endsWith(':generateContent') && req.method === 'POST') {
      if (req.headers['x-goog-api-key'] !== st.aiKey) return json(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
      if (aiFailNow()) return;
      const parts = JSON.parse(raw.toString()).contents[0].parts;
      const prompt = parts.find((x) => x.text).text;
      const video = parts.find((x) => x.inline_data?.mime_type === 'video/mp4');
      if (video && st.aiRejectVideo) return json(400, { error: { code: 400, message: 'video not supported here' } });
      st.aiPrompts.push({ provider: 'gemini', model: decodeURIComponent(p.split('/').pop().split(':')[0]), prompt, video: video ? Buffer.from(video.inline_data.data, 'base64').length : 0, images: parts.filter((x) => x.inline_data?.mime_type === 'image/jpeg').length });
      return json(200, { candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(aiAnswer(prompt)) + '\n```' }] } }] });
    }
    if ((p === '/openai/v1/models' || p === '/compat/v1/models') && req.method === 'GET') {
      if (p.startsWith('/openai') && req.headers.authorization !== `Bearer ${st.openaiKey}`) return json(401, { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } });
      return json(200, { data: p.startsWith('/openai') ? [{ id: 'gpt-5-nano' }, { id: 'gpt-5-mini' }, { id: 'gpt-realtime' }, { id: 'text-embedding-3-small' }, { id: 'gpt-image-1' }] : [{ id: 'llama-test' }] });
    }
    if ((p === '/openai/v1/chat/completions' || p === '/compat/v1/chat/completions') && req.method === 'POST') {
      const compat = p.startsWith('/compat');
      if (!compat && req.headers.authorization !== `Bearer ${st.openaiKey}`) return json(401, { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } });
      if (aiFailNow()) return;
      const b = JSON.parse(raw.toString());
      const c = b.messages[0].content;
      const prompt = typeof c === 'string' ? c : c.find((x) => x.type === 'text').text;
      const images = typeof c === 'string' ? 0 : c.filter((x) => x.type === 'image_url').length;
      if (compat && images && !st.compatVision) return json(400, { error: { message: 'model does not support images' } });
      st.aiPrompts.push({ provider: compat ? 'compatible' : 'openai', model: b.model, prompt, images, maxTokens: b.max_completion_tokens || b.max_tokens, json: b.response_format?.type });
      return json(200, { choices: [{ message: { role: 'assistant', content: JSON.stringify(aiAnswer(prompt)) } }] });
    }
    if (p === '/anthropic/v1/models' && req.method === 'GET') {
      if (req.headers['x-api-key'] !== st.anthropicKey) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      return json(200, { data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }] });
    }
    if (p === '/anthropic/v1/messages' && req.method === 'POST') {
      if (req.headers['x-api-key'] !== st.anthropicKey || !req.headers['anthropic-version']) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (aiFailNow()) return;
      const b = JSON.parse(raw.toString());
      const c = b.messages[0].content;
      const prompt = c.find((x) => x.type === 'text').text;
      st.aiPrompts.push({ provider: 'anthropic', model: b.model, prompt, images: c.filter((x) => x.type === 'image').length });
      return json(200, { content: [{ type: 'text', text: 'Hier ist das JSON: ' + JSON.stringify(aiAnswer(prompt)) }] });
    }
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
