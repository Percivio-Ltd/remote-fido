import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {validateMobileConfig} from './ios/mobile-controller.js';

test('public extension keys retain all three stable extension identities', () => {
  for (const [filename, expected] of [
    ['../extension/manifest.json', 'agnmnnemjpbpgjambapffefalbmengaf'],
    ['approver-extension/manifest.json', 'hccloojihlmnnpmdkknnloknfbbbelba'],
    ['target-extension/manifest.json', 'dollgdpmepjkbpialkfeafneeppmcijn'],
  ]) {
    const manifest = JSON.parse(fs.readFileSync(new URL(filename, import.meta.url)));
    const key = crypto.createPublicKey({key: Buffer.from(manifest.key, 'base64'), format: 'der', type: 'spki'});
    assert.equal(key.type, 'public');
    const id = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
    assert.equal(id, expected);
  }
});

test('desktop and mobile example configs retain the same exact tailnet boundary', () => {
  const source = fs.readFileSync(new URL('approver-extension/app.js', import.meta.url), 'utf8');
  const body = source.match(/function validateConfig\(c\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(body, 'desktop validator remains inspectable');
  const validateDesktopConfig = vm.runInNewContext(`${body}\nvalidateConfig`, {URL});
  const fixture = () => ({id: 'approver', token: 'a'.repeat(43), coordinator: 'https://coordinator.example.ts.net:9472',
    targetTokens: {'https://target.example.ts.net:9473': 'b'.repeat(43)}});
  for (const validate of [validateDesktopConfig, validateMobileConfig]) {
    assert.doesNotThrow(() => validate(fixture()));
    for (const endpoint of ['http://coordinator.example.ts.net:9472', 'https://coordinator.other.ts.net:9472',
      'https://coordinator.example.ts.net.attacker.example:9472', 'https://coordinator.example.ts.net:9472/',
      'https://user@coordinator.example.ts.net:9472']) {
      assert.throws(() => validate({...fixture(), coordinator: endpoint}));
      assert.throws(() => validate({...fixture(), targetTokens: {[endpoint]: 'b'.repeat(43)}}));
    }
  }
});

test('public topology remains distinct and uses only exact example service hosts', () => {
  const topology = JSON.parse(fs.readFileSync(new URL('topology.example.json', import.meta.url)));
  const manifest = JSON.parse(fs.readFileSync(new URL('approver-extension/manifest.json', import.meta.url)));
  assert.deepEqual(Object.keys(topology.devices).sort(), ['approver', 'target']);
  const endpoints = [topology.coordinator, ...Object.values(topology.devices).flatMap(device => device.endpoint ? [device.endpoint] : [])];
  assert.equal(new Set(endpoints).size, endpoints.length);
  for (const endpoint of endpoints) {
    const url = new URL(endpoint);
    assert.equal(url.protocol, 'https:');
    assert.ok(url.hostname.endsWith('.example.ts.net'));
    assert.ok(manifest.host_permissions.includes(`https://${url.hostname}/*`));
  }
  for (const device of Object.values(topology.devices)) for (const target of device.targets ?? [])
    assert.ok(topology.devices[target]?.roles.includes('target'));
  for (const permission of manifest.host_permissions) {
    const host = new URL(permission).hostname;
    assert.ok(!host.includes('*'));
    assert.ok(host.endsWith('.example.ts.net') || ['accounts.google.com', 'idmsa.apple.com', 'auth.openai.com'].includes(host));
  }
});
