import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {enrollTarget} from './prepare-target-enrollment.mjs';
function fixture() {
  const {privateKey, publicKey} = crypto.generateKeyPairSync('ed25519');
  const endpoint = 'https://tintagel.tailbb0f71.ts.net:9473', coordinator = 'https://tidepool.tailbb0f71.ts.net:9472';
  return [{privateKey: privateKey.export({type: 'pkcs8', format: 'pem'}), stateFile: '/keep/state.json', tokens: {nimue: 'keep', tintagel: 'keep-target'}, origins: ['chrome-extension://existing'],
    devices: {tintagel: {roles: ['target'], endpoint}, nimue: {roles: ['approver'], targets: ['tintagel']}}},
  {id: 'tintagel', role: 'target', publicKey: publicKey.export({type: 'spki', format: 'pem'}), coordinator, tokens: {nimue: 'keep-direct'}, rpOrigins: {'https://accounts.google.com': {rpIds: ['google.com']}}},
  {id: 'nimue', token: 'keep', coordinator, targetTokens: {[endpoint]: 'keep-direct'}}];
}
const args = ['agent-02', 'agent-02', 'https://agent-02.tailbb0f71.ts.net:9473', 19473];
test('target enrollment retains existing credentials, policy and selection state path without mutating inputs', () => {
  const f = fixture(), before = structuredClone(f), x = enrollTarget(...f, ...args);
  assert.deepEqual(f, before);
  assert.equal(x.coordinator.privateKey, f[0].privateKey);
  assert.equal(x.coordinator.stateFile, f[0].stateFile);
  assert.equal(x.coordinator.tokens.nimue, f[0].tokens.nimue);
  assert.equal(x.coordinator.tokens.tintagel, f[0].tokens.tintagel);
  assert.deepEqual(x.coordinator.devices.tintagel, f[0].devices.tintagel);
  assert.deepEqual(x.coordinator.devices.nimue.targets, ['tintagel', 'agent-02']);
  assert.equal(x.approver.targetTokens[f[0].devices.tintagel.endpoint], 'keep-direct');
  assert.deepEqual(x.target.rpOrigins, f[1].rpOrigins);
  assert.equal(x.target.tokens.nimue, x.approver.targetTokens[args[2]]);
  assert.equal(x.bridge.token, x.target.tokens.bridge);
  assert.equal(new Set([x.bridge.token, x.target.tokens.nimue, x.target.coordinatorToken]).size, 3);
});
test('target enrollment rejects duplicate identities/endpoints and mismatched credentials', () => {
  const f = fixture();
  assert.throws(() => enrollTarget(...f, 'nimue', ...args.slice(1)), /already exists/);
  for (const endpoint of [f[0].devices.tintagel.endpoint, 'https://example.com', `${args[2]}/`, `https://user@agent-02.tailbb0f71.ts.net:9473`])
    assert.throws(() => enrollTarget(...f, args[0], args[1], endpoint, args[3]));
  assert.throws(() => enrollTarget(f[0], {...f[1], publicKey: 'wrong'}, f[2], ...args), /key does not match/);
  assert.throws(() => enrollTarget(f[0], f[1], {...f[2], token: 'wrong'}, ...args), /identity mismatch/);
  assert.throws(() => enrollTarget(f[0], f[1], {...f[2], targetTokens: {}}, ...args), /credential mismatch/);
  assert.throws(() => enrollTarget(...f, ...args.slice(0, 3), 0), /port/);
});
