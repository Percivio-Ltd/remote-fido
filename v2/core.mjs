import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function check(ok, message, status = 400) {
  if (!ok) throw Object.assign(new Error(message), {status});
}
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function bytes(value, limit = 65536) {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'Invalid base64url');
  const result = Buffer.from(value, 'base64url');
  check(result.length <= limit && result.toString('base64url') === value, 'Noncanonical or oversized bytes');
  return result;
}
export function atomicJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), {recursive: true, mode: 0o700});
  const tmp = `${filename}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filename);
  const dir = fs.openSync(path.dirname(filename), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export function parseRequest(raw, origins, now = Date.now()) {
  check(typeof raw === 'string' && Buffer.byteLength(raw) <= 131072, 'Invalid request');
  const p = JSON.parse(raw);
  const override = p.extensions?.remoteDesktopClientOverride;
  check(override?.sameOriginWithAncestors === true, 'Only same-origin requests supported');
  const origin = override.origin;
  const policy = origins[origin];
  check(policy && policy.rpIds.includes(p.rpId), 'Origin / RP not explicitly allowed', 403);
  check(new URL(policy.page).origin === origin, 'Approval page origin mismatch');
  check(bytes(p.challenge).length >= 16, 'Challenge too short');
  check(['required', 'preferred', 'discouraged', undefined].includes(p.userVerification), 'Invalid UV');
  check(!p.hints?.length, 'Hints are not supported in this prototype');
  check(Object.keys(p.extensions ?? {}).every(k => k === 'remoteDesktopClientOverride'), 'Unsupported extension');
  check(p.allowCredentials === undefined || (Array.isArray(p.allowCredentials) && p.allowCredentials.length <= 128), 'Invalid credential list');
  for (const c of p.allowCredentials ?? []) {
    check(c.type === 'public-key', 'Invalid credential type'); bytes(c.id, 4096);
  }
  check(p.timeout === undefined || (Number.isFinite(p.timeout) && p.timeout > 0), 'Invalid timeout');
  const timeout = Math.min(p.timeout ?? 120000, 300000);
  return {origin, rpId: p.rpId, page: policy.page, digest: hash(raw), expires: now + timeout,
    options: {challenge: p.challenge, rpId: p.rpId, timeout,
      userVerification: p.userVerification ?? 'preferred', allowCredentials: p.allowCredentials ?? []}};
}
// Structural binding only. The relying party verifies the signature with its
// registered public key; this transport intentionally does not possess it.
export function validateAssertion(request, result) {
  check(result?.type === 'public-key' && result.id === result.rawId, 'Invalid credential');
  bytes(result.rawId, 4096);
  const allowed = request.options.allowCredentials;
  check(!allowed.length || allowed.some(c => c.id === result.id), 'Credential not allowed');
  const r = result.response;
  const client = JSON.parse(bytes(r?.clientDataJSON).toString());
  check(client.type === 'webauthn.get' && client.origin === request.origin &&
    client.challenge === request.options.challenge && client.crossOrigin === false &&
    client.topOrigin === undefined, 'Client data binding mismatch');
  const auth = bytes(r.authenticatorData);
  check(auth.length >= 37 && auth.subarray(0, 32).equals(crypto.createHash('sha256').update(request.rpId).digest()), 'RP hash mismatch');
  check((auth[32] & 1) !== 0, 'User presence missing');
  check(request.options.userVerification !== 'required' || (auth[32] & 4) !== 0, 'User verification missing');
  check(bytes(r.signature).length > 0, 'Missing signature');
  if (r.userHandle != null) bytes(r.userHandle, 64);
  check(Object.keys(result.clientExtensionResults ?? {}).length === 0, 'Unexpected extension output');
  return result;
}
export function signTicket(value, key) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${crypto.sign(null, Buffer.from(payload), key).toString('base64url')}`;
}
export function verifyTicket(ticket, key, now = Date.now()) {
  check(typeof ticket === 'string' && ticket.length < 4096, 'Invalid assignment', 403);
  const parts = ticket.split('.');
  check(parts.length === 2 && crypto.verify(null, Buffer.from(parts[0]), key, bytes(parts[1])), 'Invalid assignment signature', 403);
  const value = JSON.parse(bytes(parts[0]).toString());
  check(value.v === 2 && value.expires > now, 'Assignment expired', 410);
  return value;
}
