#!/usr/bin/env node
// Run on the owning Mac; source/config are already placed there. Never touches
// Chrome profiles, GUI, existing 0.4 host names, or unrelated launch services.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {check, atomicJSON} from './core.mjs';

const [configPath, action] = process.argv.slice(2);
check(configPath && path.isAbsolute(configPath), 'Usage: node install-service.mjs /absolute/config.json [--execute]');
const config = JSON.parse(fs.readFileSync(configPath));
check(['coordinator', 'target'].includes(config.role), 'Invalid role');
check((fs.statSync(configPath).mode & 0o077) === 0, 'Config must have mode 0600');
const source = path.dirname(fileURLToPath(import.meta.url));
const label = `de.lytiq.remote-fido-v2.${config.role}`;
const root = path.dirname(configPath);
// launchd itself opens stdout/stderr before Node starts. External-volume log
// redirection can fail before exec on macOS; keep these tiny diagnostics in the
// standard per-user Logs directory. Payloads and builds remain on BigStore.
const logDirectory = path.join(os.homedir(), 'Library/Logs/RemoteFIDO-v2');
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const marker = path.join(root, `${config.role}-installed-version`);
if (fs.existsSync(marker)) check(fs.readFileSync(marker, 'utf8').trim() === '0.5.0', 'Different installed version; explicit migration required');
console.log(`${action === '--execute' ? 'Install' : 'Preview'} ${label}: ${configPath}; loopback ${config.port}. Existing 0.4 services and Chrome remain untouched.`);
if (action !== '--execute') process.exit(0);
check(!fs.existsSync(plist), 'LaunchAgent already exists; inspect and update explicitly, do not overwrite');
if (config.role === 'target') {
  check(fs.existsSync(path.join(root, `${config.id}-bridge.json`)), 'Bridge config missing');
  check(!fs.existsSync(path.join(root, 'native-host-v2')), 'Native wrapper already exists');
  check(!fs.existsSync(path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts/de.lytiq.remote_fido_v2.json')), 'Native manifest already exists');
}
fs.mkdirSync(path.dirname(plist), {recursive: true});
fs.mkdirSync(logDirectory, {recursive: true, mode: 0o700});
fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>
<string>${xml(process.execPath)}</string><string>${xml(path.join(source, 'server.mjs'))}</string><string>${xml(configPath)}</string>
</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardErrorPath</key><string>${xml(path.join(logDirectory, `${config.role}.log`))}</string>
<key>StandardOutPath</key><string>${xml(path.join(logDirectory, `${config.role}.log`))}</string>
</dict></plist>`, {mode: 0o600, flag: 'wx'});
fs.writeFileSync(marker, '0.5.0\n', {mode: 0o600});
if (config.role === 'target') {
  const bridgePath = path.join(root, `${config.id}-bridge.json`); check(fs.existsSync(bridgePath), 'Bridge config missing');
  const wrapper = path.join(root, 'native-host-v2');
  const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(source, 'native-host.mjs'))} ${quote(bridgePath)}\n`, {mode: 0o700, flag: 'wx'});
  const nativeManifest = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts/de.lytiq.remote_fido_v2.json');
  check(!fs.existsSync(nativeManifest), 'Native manifest already exists');
  atomicJSON(nativeManifest, {name: 'de.lytiq.remote_fido_v2', description: 'Remote FIDO selected-approver target', path: wrapper,
    type: 'stdio', allowed_origins: ['chrome-extension://dollgdpmepjkbpialkfeafneeppmcijn/']});
}
execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
console.log('Service loaded. Configure only its new Tailscale HTTPS port after checking serve status. Browser activation is manual.');
