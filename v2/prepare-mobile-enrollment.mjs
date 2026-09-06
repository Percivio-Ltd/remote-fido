#!/usr/bin/env node
// Prepare new configs without mutating a running deployment or its selection.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {check, atomicJSON} from './core.mjs';

export function enrollment(coordinator, targetConfigs, id, name, origin) {
  check(/^[a-z][a-z0-9-]{1,40}$/.test(id), 'Invalid device ID');
  check(!Object.hasOwn(coordinator.devices, id), 'Device identity already exists');
  check(typeof name === 'string' && name.length > 0 && name.length < 100, 'Invalid device name');
  check(/^safari-web-extension:\/\/[A-Za-z0-9-]+$/.test(origin), 'Exact Safari extension origin required; no path or wildcard');
  check(targetConfigs.length > 0, 'At least one target required');
  check(new Set(targetConfigs.map(t => t.id)).size === targetConfigs.length, 'Duplicate target');
  const c = structuredClone(coordinator); const targets = targetConfigs.map(t => structuredClone(t));
  const token = () => crypto.randomBytes(32).toString('base64url');
  const coordinatorToken = token();
  const targetTokens = {};
  for (const t of targets) {
    check(t.role === 'target' && c.devices[t.id]?.roles.includes('target'), 'Unknown target');
    check(!Object.hasOwn(t.tokens, id) && !t.approvers.includes(id), 'Target already has this identity');
    check(t.publicKey === crypto.createPublicKey(c.privateKey).export({type: 'spki', format: 'pem'}), 'Target assignment key does not match coordinator');
    t.tokens[id] = token(); t.approvers.push(id);
    if (!t.origins.includes(origin)) t.origins.push(origin);
    targetTokens[c.devices[t.id].endpoint] = t.tokens[id];
  }
  c.tokens[id] = coordinatorToken; c.devices[id] = {name, roles: ['approver'], targets: targets.map(t => t.id)};
  if (!c.origins.includes(origin)) c.origins.push(origin);
  return {coordinator: c, targets, approver: {id, name, coordinator: targets[0].coordinator, token: coordinatorToken, targetTokens}};
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [deployment, id, name, origin, output, action] = process.argv.slice(2);
  check(deployment && output && path.isAbsolute(deployment) && path.isAbsolute(output),
    'Usage: node prepare-mobile-enrollment.mjs /private/deployment id "Name" safari-web-extension://UUID /new/private/output [--execute]');
  const c = JSON.parse(fs.readFileSync(path.join(deployment, 'coordinator.json')));
  const targets = Object.entries(c.devices).filter(([, d]) => d.roles.includes('target')).map(([id]) => JSON.parse(fs.readFileSync(path.join(deployment, `${id}-target.json`))));
  check(!fs.existsSync(output), 'Output already exists; do not overwrite credentials');
  const result = enrollment(c, targets, id, name, origin);
  console.log(`Prepare ${id} for targets ${targets.map(t => t.id).join(', ')}. Existing keys, identities and selection remain unchanged.`);
  if (action !== '--execute') { console.log('Preview only. Add --execute to write private drafts; this never reloads live services.'); process.exit(0); }
  fs.mkdirSync(output, {mode: 0o700});
  atomicJSON(path.join(output, 'coordinator.json'), result.coordinator);
  for (const t of result.targets) atomicJSON(path.join(output, `${t.id}-target.json`), t);
  atomicJSON(path.join(output, `${id}-approver.json`), result.approver);
  atomicJSON(path.join(output, 'enrollment-metadata.json'), {id, origin, sourceHashes: Object.fromEntries(['coordinator.json', ...targets.map(t => `${t.id}-target.json`)].map(file =>
    [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(deployment, file))).digest('hex')]))});
  console.log(`Private drafts written to ${output}. Verify source hashes before applying each config, only when no login is pending. Enroll the next device from the updated deployment, not an old copy.`);
}
