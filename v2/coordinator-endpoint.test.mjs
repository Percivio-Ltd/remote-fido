import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {updateCoordinatorEndpoint} from './update-coordinator-endpoint.mjs';

const old = 'https://coordinator.example.ts.net:9472', next = 'https://coordinator2.example.ts.net:9472';
const target = {role: 'target', id: 'target3', coordinator: old, tokens: {approver: 'keep', bridge: 'keep2'}, coordinatorToken: 'keep3', publicKey: 'keep-key', rpOrigins: {'https://accounts.google.com': {rpIds: ['google.com']}}};
test('coordinator rename preserves every other field and input for target and approver', () => {
  for (const config of [target, {id: 'approver', coordinator: old, token: 'keep', targetTokens: {'https://target3.example.ts.net:9473': 'keep2'}}]) {
    const before = structuredClone(config), result = updateCoordinatorEndpoint(config, old, next);
    assert.deepEqual(config, before);
    assert.deepEqual(result, {...before, coordinator: next});
    assert.deepEqual(updateCoordinatorEndpoint(result, old, next), result);
  }
});
test('coordinator rename refuses unrelated endpoints, malformed origins and wrong configuration', () => {
  for (const bad of ['http://coordinator2.example.ts.net:9472', `${next}/`, `${next}?x=1`, `${next}#x`, 'https://user@coordinator2.example.ts.net:9472', 'https://coordinator2.other.ts.net:9472', 'https://coordinator2.example.ts.net:443', 'https://example.com:9472'])
    assert.throws(() => updateCoordinatorEndpoint(target, old, bad));
  assert.throws(() => updateCoordinatorEndpoint({...target, coordinator: 'https://unexpected.example.ts.net:9472'}, old, next), /Unexpected current/);
  assert.throws(() => updateCoordinatorEndpoint({role: 'coordinator'}, old, next), /Expected target/);
});
test('endpoint CLI previews without writes, retains private original and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-fido-endpoint-'));
  try {
    const filename = path.join(dir, 'target.json'), raw = JSON.stringify(target);
    fs.writeFileSync(filename, raw, {mode: 0o600});
    const args = [fileURLToPath(new URL('update-coordinator-endpoint.mjs', import.meta.url)), filename, old, next];
    execFileSync(process.execPath, args);
    assert.deepEqual(fs.readdirSync(dir), ['target.json']);
    assert.equal(fs.readFileSync(filename, 'utf8'), raw);
    execFileSync(process.execPath, [...args, '--execute']);
    const backups = fs.readdirSync(dir).filter(x => x.startsWith('target.json.before-coordinator-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), raw);
    assert.equal(fs.statSync(path.join(dir, backups[0])).mode & 0o077, 0);
    assert.equal(fs.statSync(filename).mode & 0o077, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename)), {...target, coordinator: next});
    execFileSync(process.execPath, [...args, '--execute']);
    assert.equal(fs.readdirSync(dir).length, 2);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
test('approver retains stable identity and only exact rollout host permissions', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('approver-extension/manifest.json', import.meta.url)));
  for (const host of ['coordinator', 'coordinator2', 'target', 'target2', 'target3'])
    assert.ok(manifest.host_permissions.includes(`https://${host}.example.ts.net/*`));
  assert.ok(manifest.host_permissions.every(x => !x.includes('://*')));
  const extensionId = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, x => String.fromCharCode(97 + parseInt(x, 16)));
  assert.equal(extensionId, 'hccloojihlmnnpmdkknnloknfbbbelba');
  assert.equal(manifest.version, '0.5.4');
});
