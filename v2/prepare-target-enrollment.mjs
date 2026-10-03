#!/usr/bin/env node
// Add a target to an existing deployment without rotating existing credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {check, atomicJSON, hash} from './core.mjs';

export function enrollTarget(coordinator, reference, approver, id, name, endpoint, port) {
  check(/^[a-z][a-z0-9-]{1,40}$/.test(id), 'Invalid device ID');
  check(!Object.hasOwn(coordinator.devices, id) && !Object.hasOwn(coordinator.tokens, id), 'Device identity already exists');
  check(typeof name === 'string' && name.length > 0 && name.length < 100, 'Invalid device name');
  const url = new URL(endpoint);
  check(url.protocol === 'https:' && url.hostname.endsWith('.ts.net') && url.origin === endpoint, 'Exact tailnet HTTPS endpoint required');
  check(!Object.values(coordinator.devices).some(d => d.endpoint === endpoint), 'Endpoint already enrolled');
  check(Number.isInteger(port) && port > 1023 && port < 65536, 'Invalid loopback port');
  const publicKey = crypto.createPublicKey(coordinator.privateKey).export({type: 'spki', format: 'pem'});
  check(reference.role === 'target' && coordinator.devices[reference.id]?.roles.includes('target') && reference.publicKey === publicKey, 'Reference target key does not match coordinator');
  const existing = coordinator.devices[approver.id];
  check(existing?.roles.includes('approver') && approver.token === coordinator.tokens[approver.id], 'Approver identity mismatch');
  check(approver.coordinator === reference.coordinator, 'Coordinator endpoint mismatch');
  check(existing.targets.includes(reference.id) && approver.targetTokens[coordinator.devices[reference.id].endpoint] === reference.tokens[approver.id], 'Reference target credential mismatch');
  check(!Object.hasOwn(approver.targetTokens, endpoint), 'Approver endpoint already exists');
  const c = structuredClone(coordinator), a = structuredClone(approver);
  const token = () => crypto.randomBytes(32).toString('base64url');
  c.tokens[id] = token();
  c.devices[id] = {name, roles: ['target'], endpoint, port};
  c.devices[a.id].targets.push(id);
  a.targetTokens[endpoint] = token();
  const target = {role: 'target', id, port, origins: structuredClone(c.origins),
    tokens: {[a.id]: a.targetTokens[endpoint], bridge: token()}, approvers: [a.id], publicKey,
    coordinator: a.coordinator, coordinatorToken: c.tokens[id], rpOrigins: structuredClone(reference.rpOrigins)};
  return {coordinator: c, approver: a, target, bridge: {endpoint: `http://127.0.0.1:${port}`, token: target.tokens.bridge}};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [deployment, referenceId, approverId, id, name, endpoint, port, output, action] = process.argv.slice(2);
  check(deployment && output && path.isAbsolute(deployment) && path.isAbsolute(output),
    'Usage: node prepare-target-enrollment.mjs /deployment reference-target approver new-id "Name" https://target.ts.net:9473 19473 /new-drafts [--execute]');
  check([referenceId, approverId].every(x => /^[a-z][a-z0-9-]{1,40}$/.test(x)), 'Invalid source ID');
  check(!fs.existsSync(output), 'Output already exists; do not overwrite credentials');
  const files = ['coordinator.json', `${referenceId}-target.json`, `${approverId}-approver.json`];
  const raw = files.map(file => fs.readFileSync(path.join(deployment, file)));
  const result = enrollTarget(...raw.map(x => JSON.parse(x)), id, name, endpoint, Number(port));
  console.log(`Enroll target ${id} for ${approverId}; existing keys, tokens and selection remain unchanged.`);
  if (action !== '--execute') { console.log('Preview only. Add --execute to write private drafts; no live services are changed.'); process.exit(0); }
  fs.mkdirSync(output, {mode: 0o700});
  for (const [file, value] of Object.entries({'coordinator.json': result.coordinator, [`${approverId}-approver.json`]: result.approver,
    [`${id}-target.json`]: result.target, [`${id}-bridge.json`]: result.bridge,
    'enrollment-metadata.json': {id, endpoint, sourceHashes: Object.fromEntries(files.map((file, i) => [file, hash(raw[i])]))}})) atomicJSON(path.join(output, file), value);
  console.log(`Private drafts written to ${output}. Verify source hashes and no pending login before applying. Reload the approver extension with the new exact host permission and import its updated config.`);
}
