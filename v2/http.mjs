import http from 'node:http';
import crypto from 'node:crypto';
import {check} from './core.mjs';

export async function call(endpoint, token, route, body, timeout = 5000) {
  const response = await fetch(`${endpoint}${route}`, {method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(timeout), redirect: 'error'});
  const value = await response.json();
  check(response.ok, value.error ?? `HTTP ${response.status}`, response.status); return value;
}
function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function serve(config, handler) {
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const origin = req.headers.origin;
      if (origin) {
        check(config.origins.includes(origin), 'Browser origin not allowed', 403);
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST'); res.writeHead(204); res.end(); return;
      }
      const id = Object.entries(config.tokens).find(([, token]) => equal(req.headers.authorization, `Bearer ${token}`))?.[0];
      check(id, 'Authentication required', 401);
      check(['GET', 'POST'].includes(req.method), 'Method not allowed', 405);
      let body;
      if (req.method === 'POST') {
        check(req.headers['content-type']?.split(';')[0] === 'application/json', 'JSON required', 415);
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; check(size <= 262144, 'Payload too large', 413); chunks.push(chunk); }
        body = JSON.parse(Buffer.concat(chunks).toString());
      }
      const value = await handler({id, route: `${req.method} ${req.url}`, body, req});
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
    } catch (e) {
      res.writeHead(e.status ?? 400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: e.status ? e.message : 'Invalid request'}));
    }
  });
}
