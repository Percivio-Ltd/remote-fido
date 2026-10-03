#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import {FrameDecoder, encodeFrame} from '../protocol.mjs';
import {call} from './http.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2]));
const session = crypto.randomUUID();
const pending = new Map(); const decoder = new FrameDecoder('LE');
let closing = false;
const send = value => { if (!closing) process.stdout.write(encodeFrame(value, 'LE')); };
const api = (route, body) => call(config.endpoint, config.token, route, {...body, session});
const ready = api('/session', {});
const beat = setInterval(() => api('/session', {}).catch(() => shutdown()), 4000);
const poll = setInterval(async () => {
  for (const [requestId, item] of pending) {
    if (item.polling) continue; item.polling = true;
    try {
      const value = await api('/result', {id: item.id});
      if (!pending.has(requestId)) continue;
      if (value.state === 'completed') {
        pending.delete(requestId); send({type: 'result', requestId, responseJson: JSON.stringify(value.result)});
      } else if (value.state === 'cancelled') {
        pending.delete(requestId); send({type: 'result', requestId, error: 'Request cancelled or expired'});
      }
    } catch { pending.delete(requestId); send({type: 'result', requestId, error: 'Target unavailable; start a new login'}); }
    finally { item.polling = false; }
  }
}, 500);
async function shutdown() {
  if (closing) return; closing = true; clearInterval(beat); clearInterval(poll);
  await api('/close', {}).catch(() => {}); process.exit(0);
}
process.stdin.on('data', chunk => {
  let messages; try { messages = decoder.push(chunk); } catch { shutdown(); return; }
  for (const m of messages) (async () => {
    await ready;
    if (m.type === 'hello') { send({type: 'ready'}); return; }
    if (m.type === 'cancel') {
      const r = pending.get(m.requestId); pending.delete(m.requestId);
      if (r) await api('/cancel', {id: r.id}); return;
    }
    if (m.type !== 'get' || !Number.isSafeInteger(m.requestId) || pending.has(m.requestId)) return;
    const item = {id: crypto.randomUUID(), polling: true}; pending.set(m.requestId, item);
    try { await api('/create', {id: item.id, raw: m.requestDetailsJson}); }
    catch { if (pending.has(m.requestId)) send({type: 'result', requestId: m.requestId, error: 'Could not queue request'}); pending.delete(m.requestId); }
    finally { item.polling = false; }
    if (!pending.has(m.requestId)) await api('/cancel', {id: item.id}).catch(() => {});
  })().catch(() => shutdown());
});
process.stdin.on('end', shutdown); process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
ready.catch(() => shutdown());
