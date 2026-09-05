import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Coordinator} from './coordinator.mjs';
import {Target} from './target.mjs';
import {parseRequest, validateAssertion, signTicket, verifyTicket, hash} from './core.mjs';
import {serve, call} from './http.mjs';
import {bindRequest} from './approver-extension/request.js';

const scratch = fileURLToPath(new URL('../.scratch/', import.meta.url));
fs.mkdirSync(scratch, {recursive: true});
const origins = {'https://accounts.google.com': {page: 'https://accounts.google.com/robots.txt', rpIds: ['google.com']}};
function raw(overrides = {}) {
  return JSON.stringify({rpId: 'google.com', challenge: crypto.randomBytes(32).toString('base64url'), timeout: 60000,
    userVerification: 'required', extensions: {remoteDesktopClientOverride: {origin: 'https://accounts.google.com', sameOriginWithAncestors: true}}, ...overrides});
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(scratch, 'core-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const {privateKey, publicKey} = crypto.generateKeyPairSync('ed25519');
  const config = {stateFile: path.join(dir, 'state.json'), privateKey,
    devices: {t: {roles: ['target'], name: 'Target', endpoint: 'https://target.example'},
      a: {roles: ['approver', 'target'], name: 'A', targets: ['t'], endpoint: 'https://a.example'},
      b: {roles: ['approver'], name: 'B', targets: ['t']}, x: {roles: ['approver'], name: 'X', targets: []}}};
  const c = new Coordinator(config);
  const target = new Target({id: 't', rpOrigins: origins, publicKey, approvers: ['a', 'b']}, async (route, body) => {
    if (route === '/requests') return c.register('t', body);
    if (route === '/finish') return c.finish('t', body);
    throw new Error('Unknown route');
  });
  const session = crypto.randomUUID(); target.session(session);
  return {dir, config, c, target, session, privateKey, publicKey};
}
async function queued(f) { const id = crypto.randomUUID(); await f.target.create(f.session, {id, raw: raw()}); return id; }
function assertion(r, uv = true) {
  const auth = Buffer.alloc(37); crypto.createHash('sha256').update(r.rpId).digest().copy(auth); auth[32] = uv ? 5 : 1;
  const id = r.options.allowCredentials[0]?.id ?? 'AQID';
  return {type: 'public-key', id, rawId: id, authenticatorAttachment: 'platform', clientExtensionResults: {},
    response: {authenticatorData: auth.toString('base64url'), signature: 'AQ', userHandle: null,
      clientDataJSON: Buffer.from(JSON.stringify({type: 'webauthn.get', origin: r.origin, challenge: r.options.challenge, crossOrigin: false})).toString('base64url')}};
}
test('manual selection is CAS-persisted; heartbeat never changes it; multi-role is valid', t => {
  const f = fixture(t); f.c.select('a', {revision: 0}); f.c.status('b');
  assert.equal(f.c.state.selected, 'a'); assert.throws(() => f.c.select('b', {revision: 0}), /changed/);
  assert.equal(new Coordinator(f.config).state.selected, 'a');
  assert.equal(fs.statSync(f.config.stateFile).mode & 0o777, 0o600);
  assert.throws(() => f.c.select('t', {revision: 1}), /Role/);
});
test('exclusive claim survives coordinator restart and selection change', async t => {
  const f = fixture(t); f.c.select('a', {revision: 0}); const id = await queued(f);
  const first = f.c.claim('a', {requestId: id}); f.c.select('b', {revision: 1});
  const restarted = new Coordinator(f.config);
  assert.throws(() => restarted.claim('b', {requestId: id, oneOff: true}), /Already claimed/);
  assert.equal(restarted.claim('a', {requestId: id}).ticket, first.ticket);
  assert.equal(f.target.start('a', first).id, id);
  assert.throws(() => f.target.start('a', first), /already started/);
});
test('one-off does not change selection; any-device mode still assigns only one signer', async t => {
  const f = fixture(t); f.c.select('a', {revision: 0}); const id = await queued(f);
  assert.throws(() => f.c.claim('b', {requestId: id}), /Another approver/);
  f.c.claim('b', {requestId: id, oneOff: true}); assert.equal(f.c.state.selected, 'a');
  f.c.select('a', {revision: 1, mode: 'any'}); const second = await queued(f);
  f.c.claim('b', {requestId: second}); assert.throws(() => f.c.claim('a', {requestId: second}), /Already claimed/);
  assert.throws(() => f.c.claim('x', {requestId: second}), /not allowed/);
});
test('signed assignments bind target, approver, digest, expiry and cannot be modified', async t => {
  const f = fixture(t); const id = await queued(f); const {ticket} = f.c.claim('a', {requestId: id, oneOff: true});
  assert.throws(() => f.target.start('b', {ticket}), /audience/);
  const value = verifyTicket(ticket, f.publicKey);
  for (const change of [{target: 'a'}, {digest: '0'.repeat(64)}, {expires: Date.now() - 1}]) {
    assert.throws(() => f.target.start('a', {ticket: signTicket({...value, ...change}, f.privateKey)}));
  }
  assert.throws(() => verifyTicket(`${ticket.slice(0, -2)}AA`, f.publicKey));
  assert.equal(f.target.start('a', {ticket}).id, id);
});
test('assigned operation can complete while coordinator is unavailable; identical delivery retry is safe', async t => {
  const f = fixture(t); const id = await queued(f); const claim = f.c.claim('a', {requestId: id, oneOff: true});
  f.target.coordinator = async () => { throw new Error('Offline'); };
  const r = f.target.start('a', claim); const body = {...claim, execution: r.execution, result: assertion(r)};
  f.target.complete('a', body); f.target.complete('a', body);
  assert.equal(f.target.result(f.session, id).state, 'completed');
  assert.throws(() => f.target.complete('a', {...body, result: {...body.result, id: 'BA'}}), /Different duplicate/);
});
test('cancel, session loss, deadline, and target restart all invalidate outstanding execution', async t => {
  for (const mode of ['cancel', 'session', 'deadline', 'restart']) {
    const f = fixture(t); const id = await queued(f); const claim = f.c.claim('a', {requestId: id, oneOff: true});
    const r = f.target.start('a', claim);
    const result = assertion(r);
    if (mode === 'cancel') f.target.cancel(id);
    if (mode === 'session') f.target.close(f.session);
    if (mode === 'deadline') f.target.requests.get(id).expires = Date.now() - 1;
    if (mode === 'restart') f.target.requests.clear();
    assert.throws(() => f.target.complete('a', {...claim, execution: r.execution, result}), /cancelled|expired|Unknown/);
  }
});
test('browser session identity prevents local numeric-ID confusion and cancellation crosses no session', async t => {
  const f = fixture(t); const id = await queued(f);
  assert.throws(() => f.target.result(crypto.randomUUID(), id), /Unknown browser/);
  await assert.rejects(f.target.create(crypto.randomUUID(), {id, raw: raw()}), /Unknown browser/);
});
test('coordinator never stores or relays challenge / credential / assertion payloads', async t => {
  const f = fixture(t); const id = await queued(f); const r = f.target.requests.get(id);
  assert.ok(!fs.readFileSync(f.config.stateFile, 'utf8').includes(r.options.challenge));
  assert.equal(f.c.status('a').requests[0].digest, hash(r.raw));
  assert.equal(f.c.status('x').requests.length, 0);
});
test('request policy rejects cross-origin, unsupported extensions and malformed options', () => {
  for (const override of [{rpId: 'evil.com'}, {challenge: 'AA=='}, {timeout: -1}, {allowCredentials: {}},
    {extensions: {remoteDesktopClientOverride: {origin: 'https://accounts.google.com', sameOriginWithAncestors: false}}},
    {extensions: {prf: {}, remoteDesktopClientOverride: {origin: 'https://accounts.google.com', sameOriginWithAncestors: true}}}]) {
    assert.throws(() => parseRequest(raw(override), origins));
  }
  const r = parseRequest(raw({timeout: 1234}), origins, 100); assert.equal(r.expires, 1334);
});
test('assertion validation binds origin, challenge, RP hash, UP, required UV and credential', () => {
  const r = parseRequest(raw(), origins); const result = assertion(r); validateAssertion(r, result);
  assert.throws(() => validateAssertion(r, assertion(r, false)), /verification/);
  for (const field of ['origin', 'challenge', 'type', 'crossOrigin']) {
    const changed = structuredClone(result); const data = JSON.parse(Buffer.from(changed.response.clientDataJSON, 'base64url'));
    data[field] = field === 'crossOrigin' ? true : 'bad';
    changed.response.clientDataJSON = Buffer.from(JSON.stringify(data)).toString('base64url');
    assert.throws(() => validateAssertion(r, changed), /binding/);
  }
  const changed = structuredClone(result); changed.response.authenticatorData = Buffer.alloc(37).toString('base64url');
  assert.throws(() => validateAssertion(r, changed), /RP hash/);
});
test('approver reconstructs exact raw options and rejects raw / page / summary tampering', async t => {
  const f = fixture(t); const id = await queued(f); const claim = f.c.claim('a', {requestId: id, oneOff: true});
  const r = f.target.start('a', claim); const summary = f.c.status('a').requests[0];
  const bound = await bindRequest({...r, options: {challenge: 'fake'}}, summary);
  assert.equal(bound.options.challenge, JSON.parse(r.raw).challenge);
  for (const change of [{raw: raw()}, {page: 'https://accounts.google.com/login'}, {expires: r.expires + 1}]) {
    await assert.rejects(bindRequest({...r, ...change}, summary), /binding/);
  }
});
test('HTTP authentication, CORS, bounded payloads and concurrent claims', async t => {
  const f = fixture(t); f.c.select('a', {revision: 0, mode: 'any'}); const id = await queued(f);
  const tokens = {a: crypto.randomBytes(32).toString('hex'), b: crypto.randomBytes(32).toString('hex')};
  const server = serve({tokens, origins: ['chrome-extension://test']}, ({id, route, body}) => {
    if (route === 'POST /claim') return f.c.claim(id, body);
    return f.c.status(id);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(call(endpoint, 'wrong', '/status'), /Authentication/);
  const foreign = await fetch(`${endpoint}/status`, {headers: {Origin: 'https://evil.example', Authorization: `Bearer ${tokens.a}`}});
  assert.equal(foreign.status, 403);
  const replies = await Promise.allSettled(['a', 'b'].map(x => call(endpoint, tokens[x], '/claim', {requestId: id})));
  assert.equal(replies.filter(x => x.status === 'fulfilled').length, 1);
  const large = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${tokens.a}`}, body: JSON.stringify({padding: 'x'.repeat(263000)})});
  assert.equal(large.status, 413);
});
