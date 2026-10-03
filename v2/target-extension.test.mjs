import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
class Event {
  callbacks = [];
  addListener(f) { this.callbacks.push(f); }
  async emit(...args) { await Promise.all(this.callbacks.map(f => f(...args))); }
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function harness(attachGate) {
  const calls = {attach: 0, detach: 0, badges: [], completed: [], ports: []};
  const proxy = {onGetRequest: new Event(), onCreateRequest: new Event(), onIsUvpaaRequest: new Event(), onRequestCanceled: new Event(),
    async attach() { calls.attach++; await attachGate; }, async detach() { calls.detach++; },
    async completeGetRequest(r) { calls.completed.push(r); }, async completeCreateRequest(r) { calls.completed.push(r); }, async completeIsUvpaaRequest(r) { calls.completed.push(r); }};
  const chrome = {webAuthenticationProxy: proxy, action: {onClicked: new Event(), async setBadgeText({text}) { calls.badges.push(text); }, async setTitle() {}},
    runtime: {connectNative() { const p = {onMessage: new Event(), onDisconnect: new Event(), posted: [], postMessage(m) { this.posted.push(m); }, disconnect() { this.onDisconnect.emit(); }}; calls.ports.push(p); return p; }}};
  vm.runInNewContext(fs.readFileSync(new URL('target-extension/worker.js', import.meta.url), 'utf8'), {chrome});
  await settle(); return {calls, chrome, proxy};
}
test('v2 target starts disabled and only attaches after explicit click and native ready', async () => {
  const h = await harness(); assert.equal(h.calls.attach, 0); assert.equal(h.calls.ports.length, 0);
  await h.chrome.action.onClicked.emit(); await settle(); const p = h.calls.ports[0];
  assert.equal(p.posted[0].type, 'hello'); assert.equal(h.calls.attach, 0);
  await p.onMessage.emit({type: 'ready'}); assert.equal(h.calls.attach, 1); assert.equal(h.calls.badges.at(-1), 'ON');
});
test('v2 target preserves signed IDs, discards a cancelled late response, and cannot auto-reattach after disconnect', async () => {
  const h = await harness(); await h.chrome.action.onClicked.emit(); await settle(); const p = h.calls.ports[0];
  await p.onMessage.emit({type: 'ready'});
  await h.proxy.onGetRequest.emit({requestId: -42, requestDetailsJson: '{}'});
  assert.equal(p.posted.at(-1).requestId, -42);
  await h.proxy.onRequestCanceled.emit(-42); assert.equal(p.posted.at(-1).type, 'cancel');
  await p.onMessage.emit({type: 'result', requestId: -42, responseJson: '{}'}); assert.equal(h.calls.completed.length, 0);
  await p.onDisconnect.emit(); await settle(); assert.equal(h.calls.ports.length, 1); assert.equal(h.calls.badges.at(-1), 'ERR');
});
test('v2 target disable wins a late attach completion', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const h = await harness(gate);
  await h.chrome.action.onClicked.emit(); await settle(); const p = h.calls.ports[0];
  const ready = p.onMessage.emit({type: 'ready'}); await settle();
  await h.chrome.action.onClicked.emit(); release(); await ready; await settle();
  assert.notEqual(h.calls.badges.at(-1), 'ON');
  await h.proxy.onIsUvpaaRequest.emit({requestId: 9}); assert.equal(h.calls.completed.at(-1).isUvpaa, false);
});
test('v2 target rejects registration and disabled assertions', async () => {
  const h = await harness(); await h.proxy.onCreateRequest.emit({requestId: 1});
  assert.equal(h.calls.completed.at(-1).error.name, 'NotSupportedError');
  await h.proxy.onGetRequest.emit({requestId: 2, requestDetailsJson: '{}'});
  assert.equal(h.calls.completed.at(-1).error.name, 'NotAllowedError');
});
