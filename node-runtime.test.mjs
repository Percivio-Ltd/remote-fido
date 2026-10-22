import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isSupportedNodeVersion, supportedNodeRange} from './node-runtime.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const accepted = ['22.23.4', '22.23.5', '22.24.0', '24.22.1', '24.22.2', '24.23.0', '26.12.1', '26.12.2', '26.13.0'];
const rejected = ['20.20.0', '22.23.3', '22.22.99', '23.99.99', '24.21.99', '24.22.0', '25.99.99', '26.11.99', '26.12.0', '27.0.0', '28.0.0', '26.12.1-rc.1', '26.13.0-nightly', 'v26.12.1', '026.12.1', '26.12', '', null];

// Version substitution exists only in child-process tests, never in the runtime policy.
const preload = (version, bun = false) => `data:text/javascript,${encodeURIComponent(
  `Object.defineProperty(process.versions, 'node', {value: ${JSON.stringify(version)}});` +
  (bun ? `Object.defineProperty(process.versions, 'bun', {value: '1.4.3'});` : ''))}`;
function runNode(args) {
  return spawnSync(process.execPath, args, {cwd: root, encoding: 'utf8', timeout: 10000});
}
function assertRejected(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Remote FIDO requires patched Node\.js/);
  assert.equal(result.stdout, '', 'native-messaging stdout must remain empty on runtime rejection');
}

test('Node policy applies the security floor separately to each supported major', () => {
  for (const version of accepted) assert.equal(isSupportedNodeVersion(version), true, version);
  for (const version of rejected) assert.equal(isSupportedNodeVersion(version), false, String(version));
  for (const version of ['22.23.4', '24.22.1', '26.12.1']) {
    const result = runNode(['--import', preload(version), 'node-runtime.mjs']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
});

test('npm and lockfile declare the enforced Node range with strict engine checks', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', import.meta.url)));
  const lock = JSON.parse(fs.readFileSync(new URL('package-lock.json', import.meta.url)));
  assert.equal(pkg.engines.node, supportedNodeRange);
  assert.equal(lock.packages[''].engines.node, supportedNodeRange);
  assert.match(fs.readFileSync(new URL('.npmrc', import.meta.url), 'utf8'), /^engine-strict=true$/m);
});

test('all Node entry points reject an unpatched runtime before config, network or writes', () => {
  for (const entry of ['exporter.mjs', 'native-host.mjs', 'probe-native-host.mjs',
    'v2/server.mjs', 'v2/native-host.mjs', 'v2/install-service.mjs', 'v2/provision.mjs',
    'v2/prepare-mobile-enrollment.mjs', 'v2/prepare-desktop-enrollment.mjs', 'v2/prepare-target-enrollment.mjs',
    'v2/update-apple-policy.mjs', 'v2/update-openai-policy.mjs', 'v2/update-coordinator-endpoint.mjs',
    'v2/build-ios.mjs', 'v2/smoke.mjs']) {
    assertRejected(runNode(['--import', preload('26.12.0'), entry]));
  }
});

test('prereleases and Bun cannot satisfy the executing-runtime check', () => {
  for (const version of ['22.23.3', '24.22.0', '26.12.1-rc.1', '27.0.0']) {
    assertRejected(runNode(['--import', preload(version), 'node-runtime.mjs']));
  }
  const bun = runNode(['--import', preload('26.12.1', true), 'node-runtime.mjs']);
  assertRejected(bun);
  assert.match(bun.stderr, /detected Bun 1\.4\.3/);
});

function macFixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-fido-runtime-'));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const home = path.join(temporary, 'home');
  const source = path.join(temporary, 'source');
  const bin = path.join(home, '.local/bin/node');
  fs.mkdirSync(path.dirname(bin), {recursive: true});
  fs.mkdirSync(source);
  for (const file of ['VERSION', 'node-runtime.mjs', 'protocol.mjs', 'exporter.mjs', 'native-host.mjs',
    'probe-native-host.mjs', 'native-host-wrapper', 'run-exporter.command', 'install-exporter.sh',
    'install-vm-host.sh', 'THIRD_PARTY_NOTICES.md', 'LICENSES', 'extension']) {
    fs.cpSync(path.join(root, file), path.join(source, file), {recursive: true});
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const setVersion = version => {
    fs.rmSync(bin, {force: true});
    if (version === undefined) fs.symlinkSync(process.execPath, bin);
    else fs.writeFileSync(bin, `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(preload(version))} "$@"\n`, {mode: 0o700});
  };
  setVersion();
  const hardwareMarker = path.join(temporary, 'hardware-touched');
  const assertBinary = path.join(source, 'build/remote-fido-assert');
  fs.mkdirSync(path.dirname(assertBinary));
  fs.writeFileSync(assertBinary, `#!/bin/sh\ntouch ${quote(hardwareMarker)}\nexit 1\n`, {mode: 0o700});
  fs.writeFileSync(path.join(source, 'SHA256SUMS'), `${crypto.createHash('sha256').update(fs.readFileSync(assertBinary)).digest('hex')}  build/remote-fido-assert\n`);
  const run = (script, args = []) => spawnSync('/bin/zsh', ['-f', script, ...args], {
    cwd: source, env: {...process.env, HOME: home, ZDOTDIR: home}, encoding: 'utf8', timeout: 10000,
  });
  return {home, source, setVersion, run, hardwareMarker};
}

test('legacy installers reject the selected unpatched binary before creating an installation', {skip: process.platform !== 'darwin'}, t => {
  const f = macFixture(t);
  f.setVersion('24.22.0');
  assertRejected(f.run(path.join(f.source, 'install-exporter.sh'), ['--allow-client', '100.64.0.10', '--apply']));
  if (fs.existsSync('/Applications/Google Chrome.app')) {
    assertRejected(f.run(path.join(f.source, 'install-vm-host.sh'), ['--connect', '100.64.0.11', '--apply']));
  }
  assert.equal(fs.existsSync(path.join(f.home, 'Library')), false);
  assert.equal(fs.existsSync(f.hardwareMarker), false);
});

test('installed legacy payloads retain the guard and reject a later runtime downgrade', {
  skip: process.platform !== 'darwin' || !fs.existsSync('/Applications/Google Chrome.app') ||
    !['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'].some(file => fs.existsSync(file)),
}, t => {
  const f = macFixture(t);
  for (const [installer, flag] of [['install-exporter.sh', '--allow-client'], ['install-vm-host.sh', '--connect']]) {
    const result = f.run(path.join(f.source, installer), [flag, '100.64.0.10', '--apply']);
    assert.equal(result.status, 0, result.stderr);
  }
  const installed = path.join(f.home, 'Library/Application Support/LYTiQ');
  for (const [directory, module] of [['Remote FIDO Exporter', 'exporter.mjs'], ['Remote FIDO', 'protocol.mjs']]) {
    const result = runNode(['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(path.join(installed, directory, module)).href)})`]);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(fs.existsSync(f.hardwareMarker), false);
  f.setVersion('26.12.0');
  assertRejected(f.run(path.join(installed, 'Remote FIDO/native-host-wrapper')));
  assertRejected(f.run(path.join(installed, 'Remote FIDO Exporter/run-exporter.command')));
  assert.equal(fs.existsSync(f.hardwareMarker), false, 'runtime rejection must precede hardware readiness and Tailscale Serve');
});
