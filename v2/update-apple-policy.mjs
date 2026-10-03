#!/usr/bin/env node
// Add the explicitly supported Apple origin without rotating any credentials.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJSON, check} from './core.mjs';
import {rpOrigins} from './approver-extension/request.js';

export function addApplePolicy(config) {
  check(config.role === 'target' && config.rpOrigins && typeof config.rpOrigins === 'object', 'Expected existing target config');
  const origin = 'https://idmsa.apple.com';
  const existing = config.rpOrigins[origin];
  check(!existing || JSON.stringify(existing) === JSON.stringify(rpOrigins[origin]), 'Conflicting Apple policy; inspect before replacing');
  return {...config, rpOrigins: {...config.rpOrigins, [origin]: structuredClone(rpOrigins[origin])}};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [filename, action] = process.argv.slice(2);
  check(filename && path.isAbsolute(filename) && [undefined, '--execute'].includes(action),
    'Usage: node update-apple-policy.mjs /absolute/target-config.json [--execute]');
  check((fs.statSync(filename).mode & 0o077) === 0, 'Private config must have mode 0600');
  const original = fs.readFileSync(filename);
  const config = JSON.parse(original); const updated = addApplePolicy(config);
  if (JSON.stringify(config) === JSON.stringify(updated)) {
    console.log('Apple origin already configured; no writes.');
  } else if (action !== '--execute') {
    console.log('Preview: add exact idmsa.apple.com origin / apple.com RP. Credentials, Google policy and all other settings unchanged. Check no login is pending before applying.');
  } else {
    const backup = `${filename}.before-apple-${Date.now()}`;
    fs.writeFileSync(backup, original, {flag: 'wx', mode: 0o600});
    check(fs.readFileSync(filename).equals(original), 'Config changed during update; preserved backup, no replacement');
    atomicJSON(filename, updated);
    check(JSON.stringify(JSON.parse(fs.readFileSync(filename))) === JSON.stringify(updated), 'Config readback mismatch');
    console.log(`Added Apple policy. Recoverable original: ${backup}. Restart only the owning target service after checking it is idle.`);
  }
}
