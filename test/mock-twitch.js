// Simulierter Twitch (HTTP + EventSub-WebSocket) für Tests. Nicht für den Produktivbetrieb.
import http from 'node:http';
import crypto from 'node:crypto';

export const VALID_CLIENT_ID = 'a'.repeat(30);

function frame(text) {
  const payload = Buffer.from(text);
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, payload]);
}

export async function startMock({ broadcasterType = 'affiliate', pendingPolls = 2 } = {}) {
  const st = {
    rewards: [], nextId: 1, sockets: new Set(), subscriptions: 0, polls: 0, refreshes: 0,
    redemptionStatus: {}, rewardPatches: [], stale: {}, accessToken: 'AT1', refreshToken: 'RT1', calls: [],
    // Zuschauer-Rollen für Zugriffsregeln - per Test über mock.setRole() gesetzt.
    moderators: new Set(), vips: new Set(), subscribers: new Set(),
  };
  const scopes = ['channel:read:redemptions', 'channel:manage:redemptions', 'bits:read', 'channel:manage:broadcast', 'clips:edit', 'moderator:read:followers', 'channel:read:hype_train', 'channel:read:subscriptions'];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString();
    const ct = req.headers['content-type'] || '';
    let body = {};
    if (raw) body = ct.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    st.calls.push(`${req.method} ${url.pathname}`);
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    const p = url.pathname;

    if (p === '/oauth2/device') {
      if (body.client_id !== VALID_CLIENT_ID) return send(400, { status: 400, message: 'invalid client' });
      return send(200, { device_code: 'DC1', user_code: 'TEST1234', verification_uri: 'http://localhost/activate?device-code=TEST1234', expires_in: 600, interval: 1 });
    }
    if (p === '/oauth2/token') {
      if (body.grant_type === 'refresh_token') {
        // Twitch-App mit Client-Typ "Vertraulich": Verlängern geht ohne Client-Secret nicht.
        if (st.confidential) return send(400, { status: 400, message: 'missing client secret' });
        if (body.refresh_token !== st.refreshToken) return send(400, { status: 400, message: 'Invalid refresh token' });
        st.refreshes++;
        st.accessToken = `AT${st.refreshes + 1}`; st.refreshToken = `RT${st.refreshes + 1}`;
        return send(200, { access_token: st.accessToken, refresh_token: st.refreshToken, expires_in: 14400, scope: scopes, token_type: 'bearer' });
      }
      st.polls++;
      if (st.polls <= pendingPolls) return send(400, { status: 400, message: 'authorization_pending' });
      return send(200, { access_token: st.accessToken, refresh_token: st.refreshToken, expires_in: 14400, scope: scopes, token_type: 'bearer' });
    }
    if (p === '/oauth2/validate') {
      if (req.headers.authorization !== `OAuth ${st.accessToken}`) return send(401, { status: 401, message: 'invalid access token' });
      return send(200, { client_id: VALID_CLIENT_ID, login: 'testcaster', scopes, user_id: '123', expires_in: 14000 });
    }

    // ----- Helix -----
    if (p.startsWith('/helix/')) {
      if (req.headers.authorization !== `Bearer ${st.accessToken}`) return send(401, { error: 'Unauthorized', status: 401, message: 'Invalid OAuth token' });
      if (req.headers['client-id'] !== VALID_CLIENT_ID) return send(401, { status: 401, message: 'Client-Id mismatch' });
      const h = p.slice('/helix'.length);
      if (h === '/users') return send(200, { data: [{ id: '123', login: 'testcaster', display_name: 'TestCaster', broadcaster_type: broadcasterType }] });
      if (h === '/channel_points/custom_rewards') {
        if (req.method === 'GET') return send(200, { data: st.rewards });
        if (req.method === 'POST') {
          // Seit Mai 2026 öffnet Twitch Kanalpunkte-Belohnungen für jeden Kanal, unabhängig vom
          // Affiliate-/Partner-Status - der Mock bildet also absichtlich KEINE 403-Sperre dafür
          // mehr nach (anders als früher).
          if (st.rewards.some((r) => r.title.toLowerCase() === String(body.title).toLowerCase())) return send(400, { status: 400, message: 'CREATE_CUSTOM_REWARD_DUPLICATE_REWARD' });
          if (!body.title || body.title.length > 45 || !(body.cost >= 1)) return send(400, { status: 400, message: 'invalid reward' });
          const r = { id: `rw${st.nextId++}`, ...body };
          st.rewards.push(r);
          return send(200, { data: [r] });
        }
        if (req.method === 'PATCH') {
          const r = st.rewards.find((x) => x.id === url.searchParams.get('id'));
          if (!r) return send(404, { status: 404, message: 'not found' });
          Object.assign(r, body); st.rewardPatches.push({ id: r.id, ...body });
          return send(200, { data: [r] });
        }
        if (req.method === 'DELETE') {
          const id = url.searchParams.get('id');
          const i = st.rewards.findIndex((x) => x.id === id);
          if (i < 0) return send(404, { status: 404, message: 'not found' });
          st.rewards.splice(i, 1);
          st.rewardDeletes = st.rewardDeletes || []; st.rewardDeletes.push(id);
          return send(204);
        }
      }
      if (h === '/channel_points/custom_rewards/redemptions') {
        if (req.method === 'GET') return send(200, { data: st.stale[url.searchParams.get('reward_id')] || [] });
        if (req.method === 'PATCH') {
          st.redemptionStatus[url.searchParams.get('id')] = body.status;
          return send(200, { data: [{ id: url.searchParams.get('id'), status: body.status }] });
        }
      }
      if (h === '/moderation/moderators') return send(200, { data: st.moderators.has(url.searchParams.get('user_id')) ? [{ user_id: url.searchParams.get('user_id') }] : [] });
      if (h === '/channels/vips') return send(200, { data: st.vips.has(url.searchParams.get('user_id')) ? [{ user_id: url.searchParams.get('user_id') }] : [] });
      if (h === '/subscriptions') return send(200, { data: st.subscribers.has(url.searchParams.get('user_id')) ? [{ user_id: url.searchParams.get('user_id'), tier: '1000' }] : [] });
      if (h === '/eventsub/subscriptions' && req.method === 'POST') {
        const okType = ['channel.channel_points_custom_reward_redemption.add', 'channel.cheer', 'channel.chat.message', 'stream.online', 'stream.offline',
          'channel.raid', 'channel.follow', 'channel.subscribe', 'channel.subscription.message', 'channel.subscription.gift', 'channel.hype_train.begin'].includes(body.type);
        if (body.type === 'channel.hype_train.begin' && body.version === '2' && st.hypeV2Missing) return send(400, { status: 400, message: 'unsupported version' });
        if (['channel.raid', 'channel.follow', 'channel.subscribe', 'channel.subscription.message', 'channel.subscription.gift', 'channel.hype_train.begin'].includes(body.type)) (st.eventTypes ||= []).push(`${body.type}@${body.version}`);
        if (!okType || !body.transport?.session_id) return send(400, { status: 400, message: 'bad subscription' });
        if (body.type === 'channel.cheer') st.cheerSubscriptions = (st.cheerSubscriptions || 0) + 1;
        if (body.type === 'channel.chat.message') st.chatSubscriptions = (st.chatSubscriptions || 0) + 1;
        if (body.type.startsWith('stream.')) st.streamSubscriptions = (st.streamSubscriptions || 0) + 1;
        st.subscriptions++;
        return send(202, { data: [{ id: `sub${st.subscriptions}` }] });
      }
      if (h === '/streams') return send(200, { data: st.live ? [{ user_id: '123', type: 'live', started_at: st.startedAt || new Date(Date.now() - 3600000).toISOString() }] : [] });
      // Highlights & Stream-Infos
      if (h === '/streams/markers' && req.method === 'POST') {
        if (!st.live) return send(404, { status: 404, message: 'user is not live' });
        st.markers = st.markers || []; st.markers.push(body.description);
        return send(200, { data: [{ id: `mk${st.markers.length}`, description: body.description, position_seconds: 120 }] });
      }
      if (h === '/clips' && req.method === 'POST') {
        st.clips = (st.clips || 0) + 1;
        return send(202, { data: [{ id: `clip${st.clips}`, edit_url: `https://clips.twitch.tv/clip${st.clips}/edit` }] });
      }
      if (h === '/clips' && req.method === 'GET') return send(200, { data: [{ id: url.searchParams.get('id'), url: `https://clips.twitch.tv/${url.searchParams.get('id')}` }] });
      if (h === '/videos') return send(200, { data: st.noVods ? [] : [{ id: 'v1', type: 'archive' }] });
      if (h === '/channels' && req.method === 'GET') return send(200, { data: [{ broadcaster_id: '123', title: st.channelTitle || 'Testtitel', game_id: st.gameId || '32399', game_name: 'Counter-Strike', tags: st.tags || [] }] });
      if (h === '/channels' && req.method === 'PATCH') { if (body.title) st.channelTitle = body.title; if (body.game_id) st.gameId = body.game_id; if (body.tags) st.tags = body.tags; return send(204); }
      if (h === '/search/categories') return send(200, { data: [{ id: '32399', name: 'Counter-Strike' }, { id: '33214', name: 'Fortnite' }].filter((c) => c.name.toLowerCase().includes(String(url.searchParams.get('query')).toLowerCase())) });
      if (h === '/chat/messages' && req.method === 'POST') {
        st.chatMessages = st.chatMessages || [];
        st.chatMessages.push(body.message);
        return send(200, { data: [{ message_id: `cm${st.chatMessages.length}`, is_sent: true }] });
      }
    }
    send(404, { status: 404, message: `mock: ${req.method} ${p}` });
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    st.sockets.add(socket);
    socket.on('close', () => st.sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (buf) => { if ((buf[0] & 0x0f) === 0x8) { try { socket.end(); } catch { /* egal */ } } });
    const meta = (type, extra = {}) => ({ message_id: crypto.randomUUID(), message_type: type, message_timestamp: new Date().toISOString(), ...extra });
    socket.write(frame(JSON.stringify({ metadata: meta('session_welcome'), payload: { session: { id: `S${Date.now()}`, status: 'connected', keepalive_timeout_seconds: 10 } } })));
    socket._meta = meta;
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  return {
    port, base, st,
    env: { UCC_TWITCH_ID: base, UCC_TWITCH_API: `${base}/helix`, UCC_EVENTSUB_URL: `ws://127.0.0.1:${port}/ws` },
    redeem({ id, rewardId, user = 'viewer1', userId, status = 'unfulfilled' }) {
      const msg = {
        metadata: { message_id: crypto.randomUUID(), message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: 'channel.channel_points_custom_reward_redemption.add' },
        payload: { event: { id, user_id: userId || `u_${user}`, user_login: user.toLowerCase(), user_name: user, status, reward: { id: rewardId, title: 'x', cost: 100, prompt: '' }, redeemed_at: new Date().toISOString() } },
      };
      for (const s of st.sockets) s.write(frame(JSON.stringify(msg)));
    },
    cheer({ bits, user = 'cheerer1', userId, isAnonymous = false, message = 'Test' }) {
      const msg = {
        metadata: { message_id: crypto.randomUUID(), message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: 'channel.cheer' },
        payload: { event: { is_anonymous: isAnonymous, user_id: isAnonymous ? null : (userId || `u_${user}`), user_login: isAnonymous ? null : user.toLowerCase(), user_name: isAnonymous ? null : user, broadcaster_user_id: '123', bits, message } },
      };
      for (const s of st.sockets) s.write(frame(JSON.stringify(msg)));
    },
    // simuliert eine eingehende Chat-Nachricht über den EventSub-Mock,
    // genauso wie redeem()/cheer() oben eine echte Twitch-Notification nachbilden.
    chat({ text, user = 'chatter1', userId, mod = false, broadcaster = false }) {
      const msg = {
        metadata: { message_id: crypto.randomUUID(), message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: 'channel.chat.message' },
        payload: { event: {
          broadcaster_user_id: '123', chatter_user_id: userId || `u_${user}`, chatter_user_login: user.toLowerCase(), chatter_user_name: user,
          message: { text }, message_id: crypto.randomUUID(),
          badges: [...(mod ? [{ set_id: 'moderator' }] : []), ...(broadcaster ? [{ set_id: 'broadcaster' }] : [])],
        } },
      };
      for (const s of st.sockets) s.write(frame(JSON.stringify(msg)));
    },
    // Raid/Follow/Sub/Hype Train als EventSub-Notification (Typ wie bei Twitch, event wie bei Twitch).
    event(type, event) {
      const msg = { metadata: { message_id: crypto.randomUUID(), message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: type },
        payload: { event: { broadcaster_user_id: '123', ...event } } };
      for (const s of st.sockets) s.write(frame(JSON.stringify(msg)));
    },
    // Session Stats: Stream geht online/offline (EventSub-Notification + Helix /streams).
    stream(online) {
      st.live = !!online;
      const type = online ? 'stream.online' : 'stream.offline';
      const msg = { metadata: { message_id: crypto.randomUUID(), message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: type },
        payload: { event: { broadcaster_user_id: '123', broadcaster_user_login: 'testcaster', ...(online ? { type: 'live' } : {}) } } };
      for (const s of st.sockets) s.write(frame(JSON.stringify(msg)));
    },
    rewardIdByTitle: (t) => st.rewards.find((r) => r.title === t)?.id,
    // Rolle eines Zuschauers für den Rest des Tests setzen/entfernen.
    setRole(userId, role, on = true) {
      const set = { moderator: st.moderators, vip: st.vips, subscriber: st.subscribers }[role];
      if (!set) throw new Error(`unbekannte Rolle: ${role}`);
      if (on) set.add(userId); else set.delete(userId);
    },
    dropSockets() { for (const s of [...st.sockets]) s.destroy(); },
    stop: () => new Promise((r) => { for (const s of st.sockets) s.destroy(); server.close(r); server.closeAllConnections?.(); }),
  };
}
