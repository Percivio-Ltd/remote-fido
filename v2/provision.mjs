#!/usr/bin/env node
// Provision new credentials only into a new, explicitly named directory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomicJSON, check} from './core.mjs';

const [topologyPath, output, action] = process.argv.slice(2);
check(topologyPath && output && path.isAbsolute(output), 'Usage: node provision.mjs topology.json /absolute/new/output [--execute]');
const topology = JSON.parse(fs.readFileSync(topologyPath));
for (const endpoint of [topology.coordinator, ...Object.values(topology.devices).filter(d => d.roles.includes('target')).map(d => d.endpoint)]) {
  const u = new URL(endpoint); check(u.protocol === 'https:' && u.hostname.endsWith('.ts.net') && u.origin === endpoint, 'Exact tailnet HTTPS endpoint required');
}
for (const [id, d] of Object.entries(topology.devices)) {
  check(/^[a-z0-9-]+$/.test(id) && d.roles.length && d.roles.every(r => ['target', 'approver'].includes(r)), 'Invalid device role / ID');
  if (d.roles.includes('approver')) for (const target of d.targets) check(topology.devices[target]?.roles.includes('target'), 'Unknown target');
}
check(!fs.existsSync(output), 'Output already exists. Preserve active credentials; choose a new deployment directory.');
if (action !== '--execute') { console.log(`Preview: provision ${Object.keys(topology.devices).join(', ')} under ${output}; no writes. Add --execute.`); process.exit(0); }
fs.mkdirSync(output, {mode: 0o700});
const token = () => crypto.randomBytes(32).toString('base64url');
const tokens = Object.fromEntries(Object.keys(topology.devices).map(id => [id, token()]));
const {privateKey, publicKey} = crypto.generateKeyPairSync('ed25519');
const coordinator = {role: 'coordinator', port: topology.coordinatorPort, origins: topology.extensionOrigins,
  stateFile: path.join(output, 'coordinator-state.json'), tokens, devices: topology.devices,
  privateKey: privateKey.export({type: 'pkcs8', format: 'pem'})};
atomicJSON(path.join(output, 'coordinator.json'), coordinator);
const targetTokens = {};
for (const [id, d] of Object.entries(topology.devices)) if (d.roles.includes('target')) {
  const approvers = Object.entries(topology.devices).filter(([, a]) => a.roles.includes('approver') && a.targets.includes(id)).map(([id]) => id);
  targetTokens[id] = Object.fromEntries(approvers.map(id => [id, token()]));
  const bridgeToken = token();
  atomicJSON(path.join(output, `${id}-target.json`), {role: 'target', id, port: d.port,
    origins: topology.extensionOrigins, tokens: {...targetTokens[id], bridge: bridgeToken}, approvers,
    publicKey: publicKey.export({type: 'spki', format: 'pem'}), coordinator: topology.coordinator,
    coordinatorToken: tokens[id], rpOrigins: topology.rpOrigins});
  atomicJSON(path.join(output, `${id}-bridge.json`), {endpoint: `http://127.0.0.1:${d.port}`, token: bridgeToken});
}
for (const [id, d] of Object.entries(topology.devices)) if (d.roles.includes('approver')) {
  atomicJSON(path.join(output, `${id}-approver.json`), {id, name: d.name, coordinator: topology.coordinator, token: tokens[id],
    targetTokens: Object.fromEntries(d.targets.map(target => [topology.devices[target].endpoint, targetTokens[target][id]]))});
}
console.log(`Provisioned private configs under ${output}. No secrets printed. Selection starts unset.`);
