import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {enrollDesktopApprover} from './prepare-desktop-enrollment.mjs';

function fixture() {
  const {privateKey, publicKey} = crypto.generateKeyPairSync('ed25519');
  const origins = ['chrome-extension://hccloojihlmnnpmdkknnloknfbbbelba'];
  const ids = ['target', 'target2', 'target3'];
  const c = {privateKey: privateKey.export({type: 'pkcs8', format: 'pem'}), stateFile: '/keep/state.json', origins, tokens: {approver: 'keep-guest'}, devices: {approver: {name: 'Approver', roles: ['approver'], targets: ids}}};
  const targets = ids.map(id => {
    c.tokens[id] = `keep-${id}`; c.devices[id] = {name: id, roles: ['target'], endpoint: `https://${id}.example.ts.net:9473`, port: 19473};
    return {role: 'target', id, coordinator: 'https://coordinator2.example.ts.net:9472', coordinatorToken: c.tokens[id], origins: [...origins], publicKey: publicKey.export({type: 'spki', format: 'pem'}), tokens: {approver: 'keep-guest-direct', bridge: 'keep-bridge'}, approvers: ['approver'], rpOrigins: {'https://accounts.google.com': {rpIds: ['google.com']}}};
  });
  return [c, targets.slice(1)];
}
test('new desktop approver is authorized only for explicit targets and preserves guest credentials', () => {
  const f = fixture(), before = structuredClone(f), x = enrollDesktopApprover(...f, 'desktop', 'Desktop');
  assert.deepEqual(f, before);
  assert.equal(x.coordinator.privateKey, f[0].privateKey); assert.equal(x.coordinator.stateFile, f[0].stateFile);
  for (const [id, value] of Object.entries(f[0].tokens)) assert.equal(x.coordinator.tokens[id], value);
  for (const [id, value] of Object.entries(f[0].devices)) assert.deepEqual(x.coordinator.devices[id], value);
  assert.deepEqual(x.coordinator.devices.desktop.targets, ['target2', 'target3']);
  for (const [i, t] of x.targets.entries()) {
    const original = f[1][i];
    assert.deepEqual(t, {...original, tokens: {...original.tokens, desktop: t.tokens.desktop}, approvers: ['approver', 'desktop']});
    assert.equal(t.tokens.desktop, x.approver.targetTokens[x.coordinator.devices[t.id].endpoint]);
  }
  assert.equal(new Set([x.approver.token, ...Object.values(x.approver.targetTokens)]).size, 3);
});
test('explicit dual-role enrollment preserves the existing target identity and never changes selection', () => {
  const f = fixture();
  assert.throws(() => enrollDesktopApprover(...f, 'target', 'Target'), /explicit target-role/);
  const x = enrollDesktopApprover(...f, 'target', 'Target', {reuseTargetIdentity: true});
  assert.deepEqual(x.coordinator.tokens, f[0].tokens);
  assert.deepEqual(x.coordinator.devices.target, {...f[0].devices.target, roles: ['target', 'approver'], targets: ['target2', 'target3']});
  assert.equal(x.approver.token, f[0].tokens.target);
  assert.ok(!Object.hasOwn(x, 'state'));
  assert.throws(() => enrollDesktopApprover(x.coordinator, x.targets, 'target', 'Target', {reuseTargetIdentity: true}), /explicit target-role/);
});
test('desktop enrollment refuses stale credentials, keys, endpoints, missing origins and duplicated targets', () => {
  const f = fixture();
  assert.throws(() => enrollDesktopApprover(f[0], [], 'desktop', 'Desktop'), /distinct targets/);
  assert.throws(() => enrollDesktopApprover(f[0], [f[1][0], f[1][0]], 'desktop', 'Desktop'), /distinct targets/);
  for (const change of [{publicKey: 'wrong'}, {coordinatorToken: 'wrong'}, {origins: []}, {tokens: {desktop: 'exists'}}, {approvers: ['desktop']}])
    assert.throws(() => enrollDesktopApprover(f[0], [{...f[1][0], ...change}], 'desktop', 'Desktop'));
  assert.throws(() => enrollDesktopApprover(f[0], [f[1][0], {...f[1][1], coordinator: 'https://wrong.example.ts.net:9472'}], 'desktop', 'Desktop'), /endpoint mismatch/);
  assert.throws(() => enrollDesktopApprover({...f[0], tokens: {...f[0].tokens, desktop: 'orphan'}}, f[1], 'desktop', 'Desktop'), /Orphan/);
  const c = structuredClone(f[0]); c.devices['target2'].endpoint = 'https://example.com';
  assert.throws(() => enrollDesktopApprover(c, f[1], 'desktop', 'Desktop'), /tailnet/);
});
