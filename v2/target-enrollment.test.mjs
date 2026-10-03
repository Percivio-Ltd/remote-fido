import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {enrollTarget} from './prepare-target-enrollment.mjs';
function fixture() {
  const {privateKey, publicKey} = crypto.generateKeyPairSync('ed25519');
  const endpoint = 'https://target.example.ts.net:9473', coordinator = 'https://coordinator.example.ts.net:9472';
  return [{privateKey: privateKey.export({type: 'pkcs8', format: 'pem'}), stateFile: '/keep/state.json', tokens: {approver: 'keep', target: 'keep-target'}, origins: ['chrome-extension://existing'],
    devices: {target: {roles: ['target'], endpoint}, approver: {roles: ['approver'], targets: ['target']}}},
  {id: 'target', role: 'target', publicKey: publicKey.export({type: 'spki', format: 'pem'}), coordinator, tokens: {approver: 'keep-direct'}, rpOrigins: {'https://accounts.google.com': {rpIds: ['google.com']}}},
  {id: 'approver', token: 'keep', coordinator, targetTokens: {[endpoint]: 'keep-direct'}}];
}
const args = ['target3', 'target3', 'https://target3.example.ts.net:9473', 19473];
test('target enrollment retains existing credentials, policy and selection state path without mutating inputs', () => {
  const f = fixture(), before = structuredClone(f), x = enrollTarget(...f, ...args);
  assert.deepEqual(f, before);
  assert.equal(x.coordinator.privateKey, f[0].privateKey);
  assert.equal(x.coordinator.stateFile, f[0].stateFile);
  assert.equal(x.coordinator.tokens.approver, f[0].tokens.approver);
  assert.equal(x.coordinator.tokens.target, f[0].tokens.target);
  assert.deepEqual(x.coordinator.devices.target, f[0].devices.target);
  assert.deepEqual(x.coordinator.devices.approver.targets, ['target', 'target3']);
  assert.equal(x.approver.targetTokens[f[0].devices.target.endpoint], 'keep-direct');
  assert.deepEqual(x.target.rpOrigins, f[1].rpOrigins);
  assert.equal(x.target.tokens.approver, x.approver.targetTokens[args[2]]);
  assert.equal(x.bridge.token, x.target.tokens.bridge);
  assert.equal(new Set([x.bridge.token, x.target.tokens.approver, x.target.coordinatorToken]).size, 3);
});
test('target enrollment rejects duplicate identities/endpoints and mismatched credentials', () => {
  const f = fixture();
  assert.throws(() => enrollTarget(...f, 'approver', ...args.slice(1)), /already exists/);
  for (const endpoint of [f[0].devices.target.endpoint, 'https://example.com', `${args[2]}/`, `https://user@target3.example.ts.net:9473`])
    assert.throws(() => enrollTarget(...f, args[0], args[1], endpoint, args[3]));
  assert.throws(() => enrollTarget(f[0], {...f[1], publicKey: 'wrong'}, f[2], ...args), /key does not match/);
  assert.throws(() => enrollTarget(f[0], f[1], {...f[2], token: 'wrong'}, ...args), /identity mismatch/);
  assert.throws(() => enrollTarget(f[0], f[1], {...f[2], targetTokens: {}}, ...args), /credential mismatch/);
  assert.throws(() => enrollTarget(...f, ...args.slice(0, 3), 0), /port/);
});
