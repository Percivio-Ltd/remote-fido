// Own isolated browser, local test RP, and virtual authenticator only.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
await fs.mkdir(path.join(root, '.scratch'), {recursive: true});
const temporary = await fs.mkdtemp(path.join(root, '.scratch', 'origin-probe-'));
const fixture = fileURLToPath(new URL('probe-extension/', import.meta.url));
const server = http.createServer((req, res) => res.end('<title>Local test RP</title>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://localhost:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(temporary, {
    headless: true,
    channel: 'chromium',
    ...(process.env.CHROME_TEST_BIN ? {executablePath: process.env.CHROME_TEST_BIN} : {}),
    args: [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`]
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(origin);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const {authenticatorId} = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true}
  });
  const credential = await page.evaluate(async () => (await navigator.credentials.create({
    publicKey: {challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: {id: 'localhost', name: 'Local test RP'},
      user: {id: new Uint8Array([1]), name: 'test', displayName: 'Test'},
      pubKeyCredParams: [{type: 'public-key', alg: -7}],
      authenticatorSelection: {authenticatorAttachment: 'platform', userVerification: 'required'}
    }
  })).toJSON());
  const {credentials} = await cdp.send('WebAuthn.getCredentials', {authenticatorId});
  const privateKey = crypto.createPrivateKey({key: Buffer.from(credentials[0].privateKey, 'base64'),
    format: 'der', type: 'pkcs8'});
  const tabId = await worker.evaluate(async origin =>
    (await chrome.tabs.query({})).find(tab => tab.url.startsWith(origin)).id, origin);
  for (const world of ['ISOLATED', 'MAIN']) {
    const options = {rpId: 'localhost', challenge: crypto.randomBytes(32).toString('base64url'),
      userVerification: 'required', timeout: 5000,
      allowCredentials: [{type: 'public-key', id: credential.id}]};
    const [{result}] = await worker.evaluate(({tabId, world, options}) =>
      globalThis.runProbe(tabId, world, options), {tabId, world, options});
    assert.equal(result.ok, true, JSON.stringify(result));
    const response = result.response.response;
    const clientData = Buffer.from(response.clientDataJSON, 'base64url');
    const parsed = JSON.parse(clientData);
    assert.equal(parsed.origin, origin);
    assert.equal(parsed.challenge, options.challenge);
    assert.equal(parsed.crossOrigin, false);
    const auth = Buffer.from(response.authenticatorData, 'base64url');
    assert.ok((auth[32] & 5) === 5, 'User presence and verification required');
    const signed = Buffer.concat([auth, crypto.createHash('sha256').update(clientData).digest()]);
    assert.ok(crypto.verify('sha256', signed, crypto.createPublicKey(privateKey),
      Buffer.from(response.signature, 'base64url')));
    console.log(`${world}: real browser WebAuthn preserves RP origin, challenge, UP/UV and valid signature (virtual authenticator).`);
  }
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary, {recursive: true, force: true});
}
