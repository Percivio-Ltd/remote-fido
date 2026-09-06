import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {MobileController, validateMobileConfig} from './ios/mobile-controller.js';

function fixture() {
  const endpoint = 'https://tintagel.tailbb0f71.ts.net:9473';
  const store = {config: {id: 'iphone', name: 'iPhone', coordinator: 'https://tidepool.tailbb0f71.ts.net:9472', token: 'a'.repeat(43), targetTokens: {[endpoint]: 'b'.repeat(43)}}};
  const raw = JSON.stringify({rpId: 'google.com', challenge: crypto.randomBytes(32).toString('base64url'), userVerification: 'required',
    extensions: {remoteDesktopClientOverride: {origin: 'https://accounts.google.com', sameOriginWithAncestors: true}}});
  const summary = {id: crypto.randomUUID(), target: 'tintagel', origin: 'https://accounts.google.com', rpId: 'google.com',
    digest: crypto.createHash('sha256').update(raw).digest('hex'), expires: Date.now() + 30000};
  const request = {id: summary.id, raw, origin: summary.origin, page: `${summary.origin}/robots.txt`, expires: summary.expires, execution: crypto.randomUUID()};
  const calls = []; let completesFail = 0;
  const call = async (url, token, route, body) => {
    calls.push({route, body: structuredClone(body)});
    if (route === '/status') return {selected: 'iphone', revision: 1, mode: 'selected', requests: [summary]};
    if (route === '/claim') return {ticket: 'signed-ticket', endpoint};
    if (route === '/start') return request;
    if (route === '/inspect') return {state: 'started'};
    if (route === '/complete') { if (completesFail-- > 0) throw new Error('Network unavailable'); return {ok: true}; }
    return {ok: true};
  };
  const browser = {
    runtime: {id: 'extension', getURL: path => `safari-web-extension://fixture/${path}`},
    storage: {local: {async get() { return structuredClone(store); }, async set(values) { Object.assign(store, structuredClone(values)); }}},
    tabs: {async create() { return {id: 7}; }, async get() { return {id: 7, status: 'complete', url: request.page}; }},
    scripting: {async executeScript(opts) { return opts.args ? [{result: {mounted: true}}] : [{result: request.page, documentId: 'document'}]; }}
  };
  const app = {id: 'extension', url: browser.runtime.getURL('app.html')};
  const content = () => ({id: 'extension', tab: {id: 7}, frameId: 0, url: request.page, documentId: 'document'});
  return {store, browser, call, summary, request, app, content, calls, failCompletions(n) { completesFail = n; }, controller: new MobileController(browser, call)};
}
async function mount(f) { return f.controller.handle({type: 'mobile-approve', id: f.summary.id}, f.app); }
function outcome(f) { return {type: 'mobile-finish', id: f.summary.id, nonce: f.store.mobileActive.nonce, outcome: {error: 'AbortError'}}; }
test('mobile approval mounts once; background restart retains claim without dashboard', async () => {
  const f = fixture(); await mount(f);
  const restarted = new MobileController(f.browser, f.call);
  const active = f.store.mobileActive;
  assert.equal(active.phase, 'mounted');
  const pulse = await restarted.handle({type: 'mobile-pulse', id: active.id, nonce: active.nonce}, f.content());
  assert.equal(pulse.state, 'started'); await restarted.handle(outcome(f), f.content());
  assert.equal(f.store.mobileActive.phase, 'cancelled');
  assert.equal(f.store.mobileActive.token, undefined);
  assert.equal(f.calls.filter(c => c.route === '/start').length, 1);
});
test('mobile foreground result authenticates tab, frame, document, URL and random nonce', async () => {
  const f = fixture(); await mount(f); const m = outcome(f);
  for (const wrong of [{tab: {id: 8}}, {frameId: 1}, {url: 'https://accounts.google.com/login'}, {documentId: 'replacement'}, {id: 'other-extension'}]) {
    await assert.rejects(f.controller.handle(m, {...f.content(), ...wrong}), /binding/);
  }
  await assert.rejects(f.controller.handle({...m, nonce: 'wrong'}, f.content()), /binding/);
  assert.equal(f.calls.filter(c => c.route === '/complete').length, 0);
});
test('mobile serializes competing dashboard requests and never repeats a started ceremony', async () => {
  const f = fixture(); const r = await Promise.allSettled([mount(f), mount(f)]);
  assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
  await assert.rejects(mount(f), /Another approval/);
  assert.equal(f.calls.filter(c => c.route === '/start').length, 1);
});
test('mobile retries identical delivery only; interrupted delivery fails closed', async () => {
  const f = fixture(); await mount(f); f.failCompletions(2); const m = outcome(f);
  await assert.rejects(f.controller.handle(m, f.content()), /Network/);
  assert.equal(f.store.mobileActive.phase, 'delivering');
  const sent = f.calls.filter(c => c.route === '/complete'); assert.deepEqual(sent[0].body, sent[1].body);
  const restarted = new MobileController(f.browser, f.call);
  await assert.rejects(restarted.handle({type: 'mobile-approve', id: f.summary.id}, f.app), /Another approval/);
  await assert.rejects(restarted.handle(m, f.content()), /no longer active/);
});
test('mobile expiry, cancellation and config replacement cannot cross active execution', async () => {
  const f = fixture(); await mount(f);
  await assert.rejects(f.controller.handle({type: 'mobile-configure', config: f.store.config}, f.app), /Cancel/);
  const old = outcome(f); await f.controller.handle({type: 'mobile-cancel'}, f.app);
  await assert.rejects(f.controller.handle(old, f.content()), /binding/);
  await mount(f); f.store.mobileActive.expires = Date.now() - 1;
  await assert.rejects(f.controller.handle(outcome(f), f.content()), /no longer active/);
});
test('mobile internal status/config commands cannot be called by an RP content script', async () => {
  const f = fixture();
  await assert.rejects(f.controller.handle({type: 'mobile-status'}, f.content()), /Dashboard/);
  assert.throws(() => validateMobileConfig({...f.store.config, coordinator: 'https://evil.example'}), /tailnet/);
  assert.throws(() => validateMobileConfig({...f.store.config, targetTokens: {}}), /configuration/);
  const status = await f.controller.handle({type: 'mobile-status'}, f.app);
  assert.equal(JSON.stringify(status).includes(f.store.config.token), false);
});
test('mobile interrupted opening survives worker restart and is not blindly retried', async () => {
  const f = fixture(); f.store.mobileActive = {id: f.summary.id, expires: f.summary.expires, phase: 'opening'};
  await assert.rejects(mount(f), /Another approval/);
  await assert.rejects(f.controller.handle({type: 'mobile-cancel'}, f.app), /interrupted/);
  assert.equal(f.calls.length, 0);
});
