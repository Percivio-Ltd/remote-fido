// Real Chrome cross-extension messages + proxy detach + virtual USB CTAP2.
// Only the native pipe is mocked. No production profiles or credentials used.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {validateAssertion} from '../../v2/core.mjs';
import {requirePatchedChrome} from '../../browser-security.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
await fs.mkdir(path.join(root, '.scratch'), {recursive: true});
const tmp = await fs.mkdtemp(path.join(root, '.scratch/loop-browser-'));
const targetDir = path.join(tmp, 'target'), approverDir = path.join(tmp, 'approver');
await fs.mkdir(targetDir); await fs.mkdir(approverDir);
const targetManifest = JSON.parse(await fs.readFile(path.join(root, 'v2/target-extension/manifest.json')));
const approverManifest = JSON.parse(await fs.readFile(path.join(root, 'v2/approver-extension/manifest.json')));
approverManifest.host_permissions = ['http://localhost/*'];
await fs.writeFile(path.join(targetDir, 'manifest.json'), JSON.stringify(targetManifest));
await fs.writeFile(path.join(approverDir, 'manifest.json'), JSON.stringify(approverManifest));
for (const file of ['forwarding-guard.js', 'ceremony.js']) await fs.copyFile(path.join(root, 'v2/approver-extension', file), path.join(approverDir, file));
await fs.writeFile(path.join(approverDir, 'worker.js'), '');
await fs.writeFile(path.join(approverDir, 'app.html'), '<title>Isolated loop test</title><script type="module" src="test.js"></script>');
await fs.writeFile(path.join(approverDir, 'test.js'), `import {acquireForwardingGuard} from './forwarding-guard.js';
import {ceremony} from './ceremony.js';
globalThis.acquire = async () => { globalThis.guard = await acquireForwardingGuard(); guard.assertHeld(); };
globalThis.release = () => guard.release();
globalThis.sign = (target, request) => chrome.scripting.executeScript({target,world:'ISOLATED',func:ceremony,args:[request]});`);
const source = await fs.readFile(path.join(root, 'v2/target-extension/worker.js'), 'utf8');
await fs.writeFile(path.join(targetDir, 'worker.js'), `chrome.runtime.connectNative = () => {
  const listeners = [], disconnects = [];
  return {onMessage:{addListener:f=>listeners.push(f)},onDisconnect:{addListener:f=>disconnects.push(f)},
    disconnect(){disconnects.forEach(f=>f());},postMessage(m){if(m.type==='hello')setTimeout(()=>listeners.forEach(f=>f({type:'ready'})),0);}};
};\n${source}\nglobalThis.testEnable=enable;`);
const server = http.createServer((_req,res) => res.end('<title>USB authenticator test RP</title>'));
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://localhost:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(tmp,'profile'), {headless:true,channel:'chromium',
    ...(process.env.CHROME_TEST_BIN ? {executablePath:process.env.CHROME_TEST_BIN}:{}),
    args:[`--disable-extensions-except=${targetDir},${approverDir}`,`--load-extension=${targetDir},${approverDir}`]});
  const rp = await context.newPage(); await rp.goto(origin);
  const cdp = await context.newCDPSession(rp); await cdp.send('WebAuthn.enable');
  requirePatchedChrome((await cdp.send('Browser.getVersion')).product.split('/').at(-1));
  const {authenticatorId} = await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'usb',
    hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  const credential = await rp.evaluate(async () => (await navigator.credentials.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),
    rp:{id:'localhost',name:'Local synthetic RP'},user:{id:new Uint8Array([1]),name:'test',displayName:'Test'},
    pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{authenticatorAttachment:'cross-platform',userVerification:'required'}}})).toJSON());
  const {credentials} = await cdp.send('WebAuthn.getCredentials',{authenticatorId});
  const publicKey = crypto.createPublicKey(crypto.createPrivateKey({key:Buffer.from(credentials[0].privateKey,'base64'),format:'der',type:'pkcs8'}));
  const app = await context.newPage(); await app.goto('chrome-extension://hccloojihlmnnpmdkknnloknfbbbelba/app.html');
  await app.waitForFunction(() => typeof globalThis.acquire === 'function');
  let worker = context.serviceWorkers().find(x=>x.url().includes(targetManifest.background.service_worker) && x.url().includes('dollgdpmepjkbpialkfeafneeppmcijn'));
  if (!worker) worker = await context.waitForEvent('serviceworker',{predicate:w=>w.url().includes('dollgdpmepjkbpialkfeafneeppmcijn')});
  await worker.evaluate(() => globalThis.testEnable());
  for (let i=0;i<50;i++) { if (await worker.evaluate(()=>chrome.action.getBadgeText({})) === 'ON') break; await new Promise(r=>setTimeout(r,20)); }
  assert.equal(await worker.evaluate(()=>chrome.action.getBadgeText({})),'ON');
  await app.evaluate(()=>globalThis.acquire());
  assert.equal(await worker.evaluate(()=>chrome.action.getBadgeText({})),'LOCAL');
  await worker.evaluate(()=>globalThis.testEnable());
  assert.equal(await worker.evaluate(()=>chrome.action.getBadgeText({})),'LOCAL');
  const tabId = await app.evaluate(async origin=>(await chrome.tabs.query({})).find(t=>t.url.startsWith(origin)).id,origin);
  const [probe] = await app.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>location.href}),tabId);
  const request = {id:crypto.randomUUID(),origin,page:`${origin}/`,rpId:'localhost',targetName:'Synthetic agent',expires:Date.now()+15000,
    options:{rpId:'localhost',challenge:crypto.randomBytes(32).toString('base64url'),userVerification:'required',allowCredentials:[{id:credential.id,type:'public-key',transports:['usb']}],timeout:15000}};
  const running = app.evaluate(({target,request})=>globalThis.sign(target,request),{target:{tabId,documentIds:[probe.documentId]},request});
  await rp.locator('[data-remote-fido-approval]').waitFor(); await rp.keyboard.press('Enter');
  const [completed] = await running; assert.ok(completed.result.result,JSON.stringify(completed));
  const result = completed.result.result; validateAssertion(request,result);
  const signed = Buffer.concat([Buffer.from(result.response.authenticatorData,'base64url'),crypto.createHash('sha256').update(Buffer.from(result.response.clientDataJSON,'base64url')).digest()]);
  assert.ok(crypto.verify('sha256',signed,publicKey,Buffer.from(result.response.signature,'base64url')));
  await app.evaluate(()=>globalThis.release());
  for (let i=0;i<50;i++) { if (await worker.evaluate(()=>chrome.action.getBadgeText({})) === 'OFF') break; await new Promise(r=>setTimeout(r,20)); }
  assert.equal(await worker.evaluate(()=>chrome.action.getBadgeText({})),'OFF');
  console.log('PASS: actual target proxy ON -> authenticated approver suspension -> local virtual USB assertion with independently verified signature -> OFF. Re-enable was blocked during signing. Native pipe mocked; no physical YubiKey or real account used.');
} finally { await context?.close(); await new Promise(r=>server.close(r)); await fs.rm(tmp,{recursive:true,force:true}); }
