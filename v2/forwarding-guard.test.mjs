import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireForwardingGuard, TARGET_ID, LEGACY_ID} from './approver-extension/forwarding-guard.js';
class Event {
  callbacks = [];
  addListener(f) { this.callbacks.push(f); }
  removeListener(f) { this.callbacks = this.callbacks.filter(x => x !== f); }
  emit(m) { this.callbacks.forEach(f => f(m)); }
}
function api(installed, reply) {
  const port = {onMessage: new Event(), onDisconnect: new Event(), postMessage() {}, disconnect() { this.onDisconnect.emit(); }};
  return {port, management: {async getAll() { return installed; }, onEnabled: new Event(), onInstalled: new Event()}, runtime: {
    connect(id, options) { assert.equal(id, TARGET_ID); assert.equal(options.name, 'remote-fido-local-approval-v1'); queueMicrotask(() => reply?.(port)); return port; }}};
}
test('approver works without target and aborts if a proxy is enabled during signing', async () => {
  const a = api([]), guard = await acquireForwardingGuard(a); guard.assertHeld();
  a.management.onEnabled.emit({id: TARGET_ID, enabled: true}); await guard.lost;
  assert.throws(() => guard.assertHeld(), /enabled/); guard.release(); assert.equal(a.management.onEnabled.callbacks.length, 0);
});
test('missing inspection permission and active legacy proxy fail closed', async () => {
  await assert.rejects(acquireForwardingGuard({}), /permission/);
  await assert.rejects(acquireForwardingGuard(api([{id: LEGACY_ID, enabled: true}])), /legacy/);
});
test('approver requires acknowledgement; old, busy or failed target prevents signing', async () => {
  await assert.rejects(acquireForwardingGuard(api([{id: TARGET_ID, enabled: true}], p => p.onDisconnect.emit())), /disconnected/);
  await assert.rejects(acquireForwardingGuard(api([{id: TARGET_ID, enabled: true}], p => p.onMessage.emit({type: 'refused', error: 'busy'}))), /busy/);
});
test('a silent or incompatible target times out instead of allowing local signing', async () => {
  const a = api([{id: TARGET_ID, enabled: true}], p => p.onMessage.emit({type: 'suspended', protocol: 99}));
  await assert.rejects(acquireForwardingGuard(a), /did not confirm/);
  assert.equal(a.management.onEnabled.callbacks.length, 0);
});
test('guard loss aborts active approval but normal release does not report loss', async () => {
  const a = api([{id: TARGET_ID, enabled: true}], p => p.onMessage.emit({type: 'suspended', protocol: 1}));
  const guard = await acquireForwardingGuard(a); guard.assertHeld(); a.port.onDisconnect.emit(); await guard.lost;
  assert.throws(() => guard.assertHeld(), /lost/); guard.release();
  const b = api([{id: TARGET_ID, enabled: true}], p => p.onMessage.emit({type: 'suspended', protocol: 1}));
  const released = await acquireForwardingGuard(b); let lost = false; released.lost.then(() => { lost = true; });
  released.release(); await Promise.resolve(); assert.equal(lost, false);
});
