#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {minimumVersions} from './node-runtime.mjs';
import {CHROME_SECURITY_FLOOR} from './browser-security.mjs';
const NODE_SECURITY_FLOORS = Object.fromEntries(minimumVersions.map(version => [version.split('.')[0], version]));
const response = await fetch('https://nodejs.org/dist/index.json', {signal: AbortSignal.timeout(15000)});
if (!response.ok) throw new Error(`Cannot verify current Node releases: HTTP ${response.status}`);
const releases = await response.json();
const compare = (a, b) => { const av = a.replace(/^v/, '').split('.').map(Number), bv = b.replace(/^v/, '').split('.').map(Number); for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] - bv[i]; return 0; };
for (const [major, floor] of Object.entries(NODE_SECURITY_FLOORS)) {
  const security = releases.filter(x => x.security && x.version.startsWith(`v${major}.`)).sort((a,b) => compare(b.version, a.version))[0];
  if (!security || compare(floor, security.version) < 0) throw new Error(`Security floor is stale for Node ${major}: reviewed ${floor}, latest security release ${security?.version ?? 'unknown'}. Update and test the policy before release.`);
}
execFileSync('npm', ['audit', '--audit-level=low'], {stdio: 'inherit'});
const chromeResponse = await fetch('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json', {signal: AbortSignal.timeout(15000)});
if (!chromeResponse.ok) throw new Error(`Cannot verify current Chrome release: HTTP ${chromeResponse.status}`);
const latestChrome = (await chromeResponse.json()).channels.Stable.version;
if (CHROME_SECURITY_FLOOR !== latestChrome) throw new Error(`Review browser security baseline: pinned ${CHROME_SECURITY_FLOOR}, current stable ${latestChrome}. This release check deliberately requires review, not an automatic policy rewrite.`);
for (const file of ['extension/manifest.json', 'v2/target-extension/manifest.json', 'v2/approver-extension/manifest.json']) {
  if (JSON.parse(fs.readFileSync(new URL(file, import.meta.url))).minimum_chrome_version !== CHROME_SECURITY_FLOOR) throw new Error(`Browser security floor drift in ${file}`);
}
console.log('PASS: reviewed Node floors cover current published security releases; npm reports no known advisories at low or higher. This is not proof of zero vulnerabilities.');
