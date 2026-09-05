// Real isolated browser API + production content ceremony; synthetic authenticator.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {validateAssertion} from '../../v2/core.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
await fs.mkdir(path.join(root, '.scratch'), {recursive: true});
const temporary = await fs.mkdtemp(path.join(root, '.scratch', 'approver-browser-'));
const fixture = path.join(temporary, 'extension'); await fs.mkdir(fixture);
await fs.copyFile(path.join(root, 'v2/approver-extension/ceremony.js'), path.join(fixture, 'ceremony.js'));
await fs.writeFile(path.join(fixture, 'manifest.json'), JSON.stringify({manifest_version: 3, name: 'Isolated Remote FIDO test', version: '1.0',
  permissions: ['scripting', 'tabs'], host_permissions: ['http://localhost/*'], background: {service_worker: 'worker.js', type: 'module'}}));
await fs.writeFile(path.join(fixture, 'worker.js'), `import {ceremony,cancelCeremony} from './ceremony.js';
globalThis.run = (target, request) => chrome.scripting.executeScript({target, world:'ISOLATED',func:ceremony,args:[request]});
globalThis.cancel = (target, id) => chrome.scripting.executeScript({target,world:'ISOLATED',func:cancelCeremony,args:[id]});`);
const server = http.createServer((req, res) => res.end('<title>Local test RP</title>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://localhost:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {headless: true, channel: 'chromium',
    ...(process.env.CHROME_TEST_BIN ? {executablePath: process.env.CHROME_TEST_BIN} : {}),
    args: [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`]});
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage(); await page.goto(`${origin}/`);
  const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
  const {authenticatorId} = await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {protocol: 'ctap2', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true}});
  const credential = await page.evaluate(async () => (await navigator.credentials.create({publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), rp: {id: 'localhost', name: 'Local test RP'},
    user: {id: new Uint8Array([1]), name: 'test', displayName: 'Test'}, pubKeyCredParams: [{type: 'public-key', alg: -7}],
    authenticatorSelection: {authenticatorAttachment: 'platform', userVerification: 'required'}}})).toJSON());
  const {credentials} = await cdp.send('WebAuthn.getCredentials', {authenticatorId});
  const publicKey = crypto.createPublicKey(crypto.createPrivateKey({key: Buffer.from(credentials[0].privateKey, 'base64'), format: 'der', type: 'pkcs8'}));
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(t => t.url.startsWith(origin)).id, origin);
  const [probe] = await worker.evaluate(tabId => chrome.scripting.executeScript({target: {tabId}, func: () => location.href}), tabId);
  const target = {tabId, documentIds: [probe.documentId]};
  const request = {id: crypto.randomUUID(), origin, page: `${origin}/`, rpId: 'localhost', targetName: 'Synthetic target', expires: Date.now() + 15000,
    options: {rpId: 'localhost', challenge: crypto.randomBytes(32).toString('base64url'), userVerification: 'required',
      allowCredentials: [{id: credential.id, type: 'public-key'}], timeout: 15000}};
  const running = worker.evaluate(({target, request}) => globalThis.run(target, request), {target, request});
  await page.locator('div').waitFor(); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  const [completed] = await running; assert.ok(completed.result.result, JSON.stringify(completed));
  const result = completed.result.result; validateAssertion(request, result);
  const data = Buffer.from(result.response.clientDataJSON, 'base64url');
  const signed = Buffer.concat([Buffer.from(result.response.authenticatorData, 'base64url'), crypto.createHash('sha256').update(data).digest()]);
  assert.ok(crypto.verify('sha256', signed, publicKey, Buffer.from(result.response.signature, 'base64url')));
  console.log('PASS: production ISOLATED ceremony, explicit click, actual WebAuthn API, exact origin/challenge, UP/UV, independently verified signature.');
  const cancelRequest = {...request, id: crypto.randomUUID(), expires: Date.now() + 10000};
  const cancelled = worker.evaluate(({target, request}) => globalThis.run(target, request), {target, request: cancelRequest});
  await page.locator('div').waitFor();
  await worker.evaluate(({target, id}) => globalThis.cancel(target, id), {target, id: cancelRequest.id});
  assert.match((await cancelled)[0].result.error, /AbortError/);
  const wrong = await worker.evaluate(({target, request}) => globalThis.run(target, request), {target, request: {...request, origin: 'https://evil.example'}});
  assert.match(wrong[0].result.error, /document changed/);
  await page.goto(`${origin}/new`);
  await assert.rejects(worker.evaluate(({target, request}) => globalThis.run(target, request), {target, request}));
  console.log('PASS: cancellation aborts ceremony; mismatched origin and stale document ID cannot sign.');
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(temporary, {recursive: true, force: true});
}
