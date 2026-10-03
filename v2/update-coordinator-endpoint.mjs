#!/usr/bin/env node
// Deliberate same-tailnet coordinator rename; never rotates credentials.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJSON, check} from './core.mjs';

function endpoint(value) {
  const url = new URL(value);
  check(url.protocol === 'https:' && url.origin === value && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname), 'Exact tailnet HTTPS endpoint required');
  return url;
}
export function updateCoordinatorEndpoint(config, expected, replacement) {
  const before = endpoint(expected), after = endpoint(replacement);
  check(before.hostname.split('.').slice(1).join('.') === after.hostname.split('.').slice(1).join('.') && before.port === after.port, 'Coordinator rename must retain tailnet and port');
  check(config.role === 'target' || (!config.role && typeof config.id === 'string' && typeof config.token === 'string' && config.targetTokens), 'Expected target or approver config');
  check(config.coordinator === expected || config.coordinator === replacement, 'Unexpected current coordinator; inspect before replacing');
  return {...config, coordinator: replacement};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [filename, expected, replacement, action] = process.argv.slice(2);
  check(filename && path.isAbsolute(filename) && [undefined, '--execute'].includes(action), 'Usage: node update-coordinator-endpoint.mjs /absolute/device-config.json https://old.tailnet.ts.net:9472 https://new.tailnet.ts.net:9472 [--execute]');
  check((fs.statSync(filename).mode & 0o077) === 0, 'Private config must have mode 0600');
  const original = fs.readFileSync(filename), config = JSON.parse(original);
  const updated = updateCoordinatorEndpoint(config, expected, replacement);
  if (config.coordinator === updated.coordinator) {
    console.log('Coordinator endpoint already configured; no writes.');
  } else if (action !== '--execute') {
    console.log(`Preview: ${config.id} coordinator ${expected} -> ${replacement}. All other fields unchanged. Check no login is pending before applying.`);
  } else {
    const backup = `${filename}.before-coordinator-${Date.now()}`;
    fs.writeFileSync(backup, original, {flag: 'wx', mode: 0o600});
    check(fs.readFileSync(filename).equals(original), 'Config changed during update; preserved backup, no replacement');
    atomicJSON(filename, updated);
    check(JSON.stringify(JSON.parse(fs.readFileSync(filename))) === JSON.stringify(updated), 'Config readback mismatch');
    console.log(`Coordinator endpoint updated; original retained at ${backup}. Reload the owning service, or import the updated approver config explicitly.`);
  }
}
