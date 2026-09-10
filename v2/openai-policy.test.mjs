import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {parseRequest, validateAssertion} from './core.mjs';
import {rpOrigins, bindRequest} from './approver-extension/request.js';
import {addOpenAIPolicy} from './update-openai-policy.mjs';
const origin = 'https://auth.openai.com';
function raw(changes = {}) {
  return JSON.stringify({rpId: 'openai.com', challenge: crypto.randomBytes(32).toString('base64url'), timeout: 180000,
    userVerification: 'required', allowCredentials: [{id: 'FBUW', type: 'public-key', transports: ['usb']}],
    extensions: {remoteDesktopClientOverride: {origin, sameOriginWithAncestors: true}}, ...changes});
}
test('OpenAI policy update preserves credentials and unrelated settings, is idempotent and refuses conflicts', () => {
  const config = {role: 'target', tokens: {bridge: 'keep', nimue: 'keep2'}, publicKey: 'keep-key',
    rpOrigins: {'https://accounts.google.com': rpOrigins['https://accounts.google.com'], 'https://custom.example': {page: 'keep', rpIds: []}}};
  const before = structuredClone(config), result = addOpenAIPolicy(config);
  assert.deepEqual(config, before); assert.deepEqual(result.tokens, config.tokens); assert.equal(result.publicKey, config.publicKey);
  for (const key of Object.keys(config.rpOrigins)) assert.deepEqual(result.rpOrigins[key], config.rpOrigins[key]);
  assert.deepEqual(addOpenAIPolicy(result), result);
  assert.throws(() => addOpenAIPolicy({...result, rpOrigins: {...result.rpOrigins, [origin]: {rpIds: ['chatgpt.com']}}}), /Conflicting/);
});
test('OpenAI request preserves exact origin, challenge, UV and credentials while rejecting unrelated origins/RPs/extensions', async () => {
  const rawRequest = raw(), parsed = parseRequest(rawRequest, rpOrigins);
  const request = {id: crypto.randomUUID(), raw: rawRequest, ...parsed};
  const summary = {id: request.id, digest: parsed.digest, origin, rpId: 'openai.com', expires: parsed.expires};
  const bound = await bindRequest(request, summary);
  assert.equal(bound.page, 'https://auth.openai.com/log-in');
  assert.deepEqual(bound.options.allowCredentials, JSON.parse(rawRequest).allowCredentials);
  assert.equal(bound.options.challenge, JSON.parse(rawRequest).challenge); assert.equal(bound.options.userVerification, 'required');
  const auth = Buffer.alloc(37); crypto.createHash('sha256').update('openai.com').digest().copy(auth); auth[32] = 5;
  const result = {id: 'FBUW', rawId: 'FBUW', type: 'public-key', clientExtensionResults: {}, response: {
    authenticatorData: auth.toString('base64url'), signature: 'AQ', userHandle: null,
    clientDataJSON: Buffer.from(JSON.stringify({type: 'webauthn.get', origin, crossOrigin: false, challenge: bound.options.challenge})).toString('base64url')}};
  validateAssertion(bound, result); // Structural fixture, not a signature or real-login proof.
  await assert.rejects(bindRequest({...request, page: `${bound.page}?different=1`}, summary), /binding/);
  await assert.rejects(bindRequest({...request, raw: raw()}, summary), /binding/);
  for (const rpId of ['chatgpt.com', 'auth.openai.com', 'openai.com.evil.example'])
    assert.throws(() => parseRequest(raw({rpId}), rpOrigins), /not explicitly allowed/);
  for (const foreign of ['https://chatgpt.com', 'https://openai.com', 'https://auth.openai.com.evil.example'])
    assert.throws(() => parseRequest(raw({extensions: {remoteDesktopClientOverride: {origin: foreign, sameOriginWithAncestors: true}}}), rpOrigins));
  assert.throws(() => parseRequest(raw({extensions: {remoteDesktopClientOverride: {origin, sameOriginWithAncestors: false}}}), rpOrigins), /same-origin/);
  assert.throws(() => parseRequest(raw({extensions: {remoteDesktopClientOverride: {origin, sameOriginWithAncestors: true}, prf: {}}}), rpOrigins), /Unsupported extension/);
  auth[32] = 1;
  assert.throws(() => validateAssertion(bound, {...result, response: {...result.response, authenticatorData: auth.toString('base64url')}}), /verification missing/);
});
