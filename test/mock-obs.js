// Nachbau von OBS-WebSocket (Protokoll v5) für die Tests: Hello/Identify mit Passwort, Anfragen,
// Ereignisse. Speichert der "Wiederholungspuffer", legt der Mock eine kleine Datei an.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function frame(text) {
  const payload = Buffer.from(text);
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, payload]);
}

// Client-Frames sind maskiert; liefert [Texte, Rest]
function parse(buf) {
  const out = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const op = buf[off] & 0x0f;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length < p + 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length < p + 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const masked = buf[off + 1] & 0x80;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (buf.length < p + len) break;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    out.push({ op, text: data.toString('utf8') });
    off = p + len;
  }
  return [out, buf.subarray(off)];
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');

export async function startObsMock({ password = 'geheim', dir }) {
  const st = {
    password, scenes: ['Spiel', 'Pause', 'Ende'], current: 'Spiel', items: { Spiel: [{ id: 1, name: 'Kamera', enabled: true }, { id: 2, name: 'Chaos-Overlay', enabled: true }] },
    replayActive: true, streaming: true, profile: { 'Output.Mode': 'Simple', 'SimpleOutput.RecRBTime': '20' }, saved: [], requests: [], sockets: new Set(), authFails: 0,
  };
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: obswebsocket.json\r\n\r\n`);
    st.sockets.add(socket);
    socket.on('close', () => st.sockets.delete(socket));
    socket.on('error', () => {});
    const salt = crypto.randomBytes(8).toString('base64');
    const challenge = crypto.randomBytes(8).toString('base64');
    const send = (op, d) => socket.write(frame(JSON.stringify({ op, d })));
    send(0, { obsStudioVersion: '31.0.0', obsWebSocketVersion: '5.5.0', rpcVersion: 1, ...(st.password ? { authentication: { salt, challenge } } : {}) });
    let rest = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const [msgs, r] = parse(Buffer.concat([rest, chunk]));
      rest = r;
      for (const m of msgs) {
        if (m.op === 0x8) { try { socket.end(); } catch { /* egal */ } return; }
        if (m.op !== 0x1) continue;
        const msg = JSON.parse(m.text);
        if (msg.op === 1) {
          if (st.password && msg.d.authentication !== sha(sha(st.password + salt) + challenge)) {
            st.authFails++;
            // Schließen mit Code 4009 (Authentifizierung fehlgeschlagen)
            const reason = Buffer.from('Authentication failed.');
            const payload = Buffer.concat([Buffer.from([0x0f, 0xa9]), reason]);
            socket.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
            socket.end();
            return;
          }
          socket._ident = true;
          send(2, { negotiatedRpcVersion: 1 });
        } else if (msg.op === 6 && socket._ident) {
          const { requestType, requestId, requestData = {} } = msg.d;
          st.requests.push({ requestType, requestData });
          const ok = (responseData = {}) => send(7, { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData });
          const fail = (code, comment) => send(7, { requestType, requestId, requestStatus: { result: false, code, comment } });
          const items = st.items[requestData.sceneName] || [];
          switch (requestType) {
            case 'GetReplayBufferStatus': ok({ outputActive: st.replayActive }); break;
            case 'StartReplayBuffer': st.replayActive = true; ok(); send(5, { eventType: 'ReplayBufferStateChanged', eventData: { outputActive: true } }); break;
            case 'GetSceneList': ok({ currentProgramSceneName: st.current, scenes: [...st.scenes].reverse().map((sceneName) => ({ sceneName })) }); break;
            case 'SetCurrentProgramScene': if (!st.scenes.includes(requestData.sceneName)) fail(600, 'No source was found'); else { st.current = requestData.sceneName; ok(); } break;
            case 'GetSceneItemList': ok({ sceneItems: items.map((i) => ({ sceneItemId: i.id, sourceName: i.name, sceneItemEnabled: i.enabled })) }); break;
            case 'GetSceneItemId': { const i = items.find((x) => x.name === requestData.sourceName); if (i) ok({ sceneItemId: i.id }); else fail(600, 'No scene items were found'); break; }
            case 'GetSceneItemEnabled': ok({ sceneItemEnabled: items.find((x) => x.id === requestData.sceneItemId)?.enabled }); break;
            case 'SetSceneItemEnabled': { const i = items.find((x) => x.id === requestData.sceneItemId); if (i) i.enabled = requestData.sceneItemEnabled; ok(); break; }
            case 'GetProfileParameter': ok({ parameterValue: st.profile[`${requestData.parameterCategory}.${requestData.parameterName}`] ?? null, defaultParameterValue: null }); break;
            case 'SetProfileParameter': st.profile[`${requestData.parameterCategory}.${requestData.parameterName}`] = String(requestData.parameterValue); ok(); break;
            case 'StopReplayBuffer': st.replayActive = false; ok(); break;
            case 'StopStream': st.streaming = false; ok(); break;
            case 'SaveReplayBuffer': {
              if (!st.replayActive) { fail(501, 'Replay buffer is not active'); break; }
              const file = path.join(dir, `Replay ${Date.now()}-${st.saved.length}.mkv`);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(file, 'fake video');
              st.saved.push(file);
              ok();
              setTimeout(() => send(5, { eventType: 'ReplayBufferSaved', eventIntent: 64, eventData: { savedReplayPath: file } }), 20);
              break;
            }
            default: fail(204, `Unknown request ${requestType}`);
          }
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { st, port: server.address().port, close: () => { for (const s of st.sockets) s.destroy(); server.close(); } };
}
