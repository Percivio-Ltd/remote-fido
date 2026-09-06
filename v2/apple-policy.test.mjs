import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {parseRequest, validateAssertion} from './core.mjs';
import {rpOrigins, bindRequest} from './approver-extension/request.js';
import {addApplePolicy} from './update-apple-policy.mjs';

const origin = 'https://idmsa.apple.com';
function raw(changes = {}) {
  return JSON.stringify({rpId: 'apple.com', challenge: crypto.randomBytes(32).toString('base64url'), timeout: 60000,
    userVerification: 'required', allowCredentials: [],
    extensions: {remoteDesktopClientOverride: {origin, sameOriginWithAncestors: true}}, ...changes});
}
test('Apple policy update preserves existing credentials and unrelated origins; conflicts are refused', () => {
  const config = {role: 'target', tokens: {bridge: 'private', nimue: 'private2'}, publicKey: 'unchanged',
    rpOrigins: {'https://accounts.google.com': rpOrigins['https://accounts.google.com'], 'https://custom.example': {page: 'keep', rpIds: []}}};
  const before = structuredClone(config); const result = addApplePolicy(config);
  assert.deepEqual(config, before); assert.deepEqual(result.tokens, config.tokens);
  assert.equal(result.publicKey, config.publicKey);
  for (const key of Object.keys(config.rpOrigins)) assert.deepEqual(result.rpOrigins[key], config.rpOrigins[key]);
  assert.deepEqual(addApplePolicy(result), result);
  assert.throws(() => addApplePolicy({...result, rpOrigins: {...result.rpOrigins, [origin]: {rpIds: ['evil.com']}}}), /Conflicting/);
});
test('Apple request binds exact origin, RP, raw challenge, page and returned assertion', async () => {
  const rawRequest = raw(); const parsed = parseRequest(rawRequest, rpOrigins);
  const request = {id: crypto.randomUUID(), raw: rawRequest, ...parsed};
  const summary = {id: request.id, digest: parsed.digest, origin, rpId: 'apple.com', expires: parsed.expires};
  const bound = await bindRequest(request, summary);
  assert.deepEqual(bound.options.allowCredentials, []); assert.equal(bound.options.challenge, JSON.parse(rawRequest).challenge);
  const auth = Buffer.alloc(37); crypto.createHash('sha256').update('apple.com').digest().copy(auth); auth[32] = 5;
  const result = {id: 'AQID', rawId: 'AQID', type: 'public-key', clientExtensionResults: {}, response: {
    authenticatorData: auth.toString('base64url'), signature: 'AQ', userHandle: null,
    clientDataJSON: Buffer.from(JSON.stringify({type: 'webauthn.get', origin, crossOrigin: false, challenge: bound.options.challenge})).toString('base64url')}};
  validateAssertion(bound, result); // Structural test only; browser test verifies a real synthetic signature.
  await assert.rejects(bindRequest({...request, page: 'https://www.apple.com/filenotfound'}, summary), /binding/);
  await assert.rejects(bindRequest({...request, page: `${parsed.page}?different=1`}, summary), /binding/);
  for (const rpId of ['google.com', 'idmsa.apple.com', 'apple.com.evil.example']) assert.throws(() => parseRequest(raw({rpId}), rpOrigins), /not explicitly allowed/);
  for (const foreign of ['https://apple.com', 'https://account.apple.com', 'https://idmsa.apple.com.evil.example']) {
    assert.throws(() => parseRequest(raw({extensions: {remoteDesktopClientOverride: {origin: foreign, sameOriginWithAncestors: true}}}), rpOrigins));
  }
  assert.throws(() => parseRequest(raw({extensions: {remoteDesktopClientOverride: {origin, sameOriginWithAncestors: false}}}), rpOrigins), /same-origin/);
});
test('Apple and Google policies match manifest permissions and new target topology', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./approver-extension/manifest.json', import.meta.url)));
  const topology = JSON.parse(fs.readFileSync(new URL('./topology.example.json', import.meta.url)));
  assert.deepEqual(topology.rpOrigins, rpOrigins);
  for (const key of Object.keys(rpOrigins)) assert.ok(manifest.host_permissions.includes(`${key}/*`));
  assert.ok(!manifest.host_permissions.includes('https://*.apple.com/*'));
  assert.equal(parseRequest(raw({rpId: 'google.com', extensions: {remoteDesktopClientOverride: {origin: 'https://accounts.google.com', sameOriginWithAncestors: true}}}), rpOrigins).rpId, 'google.com');
});
