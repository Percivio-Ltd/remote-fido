import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {enrollment} from './prepare-mobile-enrollment.mjs';
function fixture() {
  const {privateKey, publicKey} = crypto.generateKeyPairSync('ed25519');
  const c = {privateKey: privateKey.export({type: 'pkcs8', format: 'pem'}), tokens: {approver: 'keep-coordinator-token'}, origins: ['chrome-extension://existing'],
    devices: {target: {roles: ['target'], endpoint: 'https://target.example.ts.net:9473'}, approver: {roles: ['approver'], targets: ['target']}}};
  const t = {id: 'target', role: 'target', publicKey: publicKey.export({type: 'spki', format: 'pem'}), tokens: {bridge: 'keep-bridge', approver: 'keep-source'},
    approvers: ['approver'], origins: c.origins, coordinator: 'https://coordinator.example.ts.net:9472'};
  return {c, t};
}
test('mobile enrollment preserves existing identities, assignment key, bridge token and input configs', () => {
  const {c, t} = fixture(); const before = structuredClone({c, t});
  const x = enrollment(c, [t], 'iphone', 'iPhone', 'safari-web-extension://iphone-uuid');
  assert.deepEqual({c, t}, before);
  assert.equal(x.coordinator.privateKey, c.privateKey); assert.equal(x.coordinator.tokens.approver, c.tokens.approver);
  assert.equal(x.targets[0].tokens.bridge, t.tokens.bridge); assert.equal(x.targets[0].tokens.approver, t.tokens.approver);
  assert.notEqual(x.approver.token, x.targets[0].tokens.iphone);
  assert.deepEqual(x.targets[0].approvers, ['approver', 'iphone']);
  const second = enrollment(x.coordinator, x.targets, 'ipad', 'iPad', 'safari-web-extension://ipad-uuid');
  assert.equal(second.coordinator.tokens.iphone, x.approver.token); assert.notEqual(second.approver.token, x.approver.token);
  assert.deepEqual(second.targets[0].approvers, ['approver', 'iphone', 'ipad']);
});
test('mobile enrollment rejects reused IDs, wildcard origins and mismatched target key', () => {
  const {c, t} = fixture();
  assert.throws(() => enrollment(c, [t], 'approver', 'Phone', 'safari-web-extension://uuid'), /already exists/);
  for (const origin of ['*', 'safari-web-extension://*', 'safari-web-extension://uuid/path', 'https://example.com'])
    assert.throws(() => enrollment(c, [t], 'iphone', 'iPhone', origin), /Exact Safari/);
  assert.throws(() => enrollment(c, [{...t, publicKey: 'wrong'}], 'iphone', 'iPhone', 'safari-web-extension://uuid'), /does not match/);
});
