#!/usr/bin/env node
// Add a Chrome approver for explicitly named targets, retaining other identities.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {check, atomicJSON, hash} from './core.mjs';

const origin = 'chrome-extension://hccloojihlmnnpmdkknnloknfbbbelba';
export function enrollDesktopApprover(coordinator, targetConfigs, id, name, {reuseTargetIdentity = false} = {}) {
  check(/^[a-z][a-z0-9-]{1,40}$/.test(id), 'Invalid device ID');
  check(typeof name === 'string' && name.length > 0 && name.length < 100, 'Invalid device name');
  const existing = coordinator.devices[id];
  if (existing) {
    check(reuseTargetIdentity && existing.roles.length === 1 && existing.roles[0] === 'target' && typeof coordinator.tokens[id] === 'string', 'Existing identity requires explicit target-role extension');
  } else check(!Object.hasOwn(coordinator.tokens, id), 'Orphan coordinator credential; inspect before enrollment');
  check(coordinator.origins.includes(origin), 'Chrome approver origin is not enrolled');
  check(targetConfigs.length > 0 && new Set(targetConfigs.map(t => t.id)).size === targetConfigs.length, 'Explicit distinct targets required');
  const c = structuredClone(coordinator), targets = structuredClone(targetConfigs);
  const publicKey = crypto.createPublicKey(c.privateKey).export({type: 'spki', format: 'pem'});
  const token = () => crypto.randomBytes(32).toString('base64url');
  const targetTokens = {};
  for (const t of targets) {
    check(t.role === 'target' && c.devices[t.id]?.roles.includes('target'), 'Unknown target');
    check(t.publicKey === publicKey && t.coordinatorToken === c.tokens[t.id], 'Target identity does not match coordinator');
    check(t.coordinator === targets[0].coordinator, 'Coordinator endpoint mismatch');
    check(t.origins.includes(origin), 'Chrome approver origin missing from target');
    check(!Object.hasOwn(t.tokens, id) && !t.approvers.includes(id), 'Target already has this approver identity');
    const endpoint = c.devices[t.id].endpoint, url = new URL(endpoint);
    check(url.protocol === 'https:' && url.origin === endpoint && url.hostname.endsWith('.ts.net'), 'Exact tailnet HTTPS target required');
    check(!Object.hasOwn(targetTokens, endpoint), 'Duplicate target endpoint');
    t.tokens[id] = token(); t.approvers.push(id); targetTokens[endpoint] = t.tokens[id];
  }
  if (!existing) c.tokens[id] = token();
  c.devices[id] = existing ? {...c.devices[id], roles: [...existing.roles, 'approver'], targets: targets.map(t => t.id)} : {name, roles: ['approver'], targets: targets.map(t => t.id)};
  return {coordinator: c, targets, approver: {id, name, coordinator: targets[0].coordinator, token: c.tokens[id], targetTokens}};
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [deployment, id, name, targetIds, output, ...flags] = process.argv.slice(2);
  check(deployment && output && path.isAbsolute(deployment) && path.isAbsolute(output) && flags.every(x => ['--execute', '--extend-existing-target'].includes(x)), 'Usage: node prepare-desktop-enrollment.mjs /deployment id "Name" target-01,target-02 /new-private-drafts [--extend-existing-target] [--execute]');
  const ids = targetIds?.split(',') ?? [];
  check(ids.length > 0 && ids.every(x => /^[a-z][a-z0-9-]{1,40}$/.test(x)), 'Explicit target IDs required');
  check(!fs.existsSync(output), 'Output already exists; do not overwrite credentials');
  const files = ['coordinator.json', ...ids.map(x => `${x}-target.json`)];
  const raw = files.map(file => {
    const filename = path.join(deployment, file);
    check((fs.statSync(filename).mode & 0o077) === 0, 'Private config must have mode 0600');
    return fs.readFileSync(filename);
  });
  const [c, ...targets] = raw.map(x => JSON.parse(x));
  const result = enrollDesktopApprover(c, targets, id, name, {reuseTargetIdentity: flags.includes('--extend-existing-target')});
  console.log(`Enroll desktop approver ${id} for ${ids.join(', ')}; retain all current keys, credentials, policies and selection.`);
  if (!flags.includes('--execute')) { console.log('Preview only. Add --execute for private drafts; no live services or browser profiles are changed.'); process.exit(0); }
  fs.mkdirSync(output, {mode: 0o700});
  atomicJSON(path.join(output, 'coordinator.json'), result.coordinator);
  for (const target of result.targets) atomicJSON(path.join(output, `${target.id}-target.json`), target);
  atomicJSON(path.join(output, `${id}-approver.json`), result.approver);
  atomicJSON(path.join(output, 'enrollment-metadata.json'), {id, targetIds: ids, sourceHashes: Object.fromEntries(files.map((file, i) => [file, hash(raw[i])]))});
  console.log('Private drafts prepared. Verify source hashes and idle services before applying; import only this device config on the owning approver.');
}
