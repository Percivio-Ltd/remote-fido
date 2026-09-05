#!/usr/bin/env node
// Explicit synthetic cancellation test. Never opens a browser, prompts a user,
// fabricates a successful assertion, or changes the persistent selection.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {FrameDecoder, encodeFrame} from '../protocol.mjs';
import {call} from './http.mjs';

const [role, configPath, nonce] = process.argv.slice(2);
assert.match(nonce ?? '', /^[0-9a-f-]{36}$/);
const raw = JSON.stringify({rpId: 'google.com', challenge: crypto.createHash('sha256').update(`remote-fido-smoke:${nonce}`).digest('base64url'),
  timeout: 60000, userVerification: 'required', extensions: {remoteDesktopClientOverride: {origin: 'https://accounts.google.com', sameOriginWithAncestors: true}}});
if (role === 'target') {
  const child = spawn(process.execPath, [fileURLToPath(new URL('native-host.mjs', import.meta.url)), configPath], {stdio: ['pipe', 'pipe', 'inherit']});
  const decoder = new FrameDecoder('LE');
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Smoke test timed out')); }, 65000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); if (code) reject(new Error(`Native host exited ${code}`)); });
    child.stdout.on('data', chunk => {
      for (const m of decoder.push(chunk)) {
        if (m.type === 'ready') { child.stdin.write(encodeFrame({type: 'get', requestId: 501, requestDetailsJson: raw}, 'LE')); console.log('Synthetic native request queued; waiting for approver cancellation.'); }
        if (m.type === 'result') {
          clearTimeout(timer);
          if (m.error === 'Request cancelled or expired') { console.log('PASS: cancellation returned through native framing to the correct browser request ID.'); resolve(); }
          else reject(new Error(`Unexpected native result: ${m.error ?? 'success'}`));
          child.stdin.end();
        }
      }
    });
  });
  child.stdin.write(encodeFrame({type: 'hello'}, 'LE')); await done;
} else if (role === 'approver') {
  const config = JSON.parse(fs.readFileSync(configPath));
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  const state = await call(config.coordinator, config.token, '/status');
  const request = state.requests.find(r => r.digest === digest);
  assert.ok(request, 'Synthetic pending request not found');
  const claim = await call(config.coordinator, config.token, '/claim', {requestId: request.id, oneOff: true});
  const token = config.targetTokens[claim.endpoint]; assert.ok(token);
  const r = await call(claim.endpoint, token, '/start', {ticket: claim.ticket});
  assert.equal(r.raw, raw);
  await assert.rejects(call(claim.endpoint, token, '/start', {ticket: claim.ticket}), /already started/);
  await call(claim.endpoint, token, '/complete', {ticket: claim.ticket, execution: r.execution, error: true});
  const after = await call(config.coordinator, config.token, '/status');
  assert.equal(after.selected, state.selected); assert.equal(after.revision, state.revision);
  console.log('PASS: tailnet HTTPS authentication, coordinator claim, direct target payload, duplicate-start rejection and cancellation. Selection unchanged; no passkey used.');
} else throw new Error('Usage: node smoke.mjs target|approver private-config.json shared-random-uuid');
