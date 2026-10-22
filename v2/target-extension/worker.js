let port = null; let attached = false; let generation = 0;
const pending = new Set();
const APPROVER_ID = 'hccloojihlmnnpmdkknnloknfbbbelba';
let localApproval = null;
let attaching = Promise.resolve();
let operations = Promise.resolve();
const serial = fn => { const next = operations.then(fn); operations = next.catch(() => {}); return next; };
async function badge(text, detail) {
  await chrome.action.setBadgeText({text});
  await chrome.action.setTitle({title: detail});
}
async function disable() {
  generation++; attached = false;
  const old = port; port = null; old?.disconnect(); pending.clear();
  await chrome.webAuthenticationProxy.detach().catch(() => {});
  await badge('OFF', 'Remote FIDO disabled — click to enable');
}
async function enable() {
  const {approvalUntil = 0} = await chrome.storage.session.get('approvalUntil');
  if (localApproval || approvalUntil > Date.now()) {
    await badge('LOCAL', 'Local approval in progress — forwarding is suspended'); return;
  }
  await disable();
  const gen = generation;
  const p = chrome.runtime.connectNative('de.lytiq.remote_fido_v2'); port = p;
  await badge('…', 'Connecting to local target service');
  p.onDisconnect.addListener(() => {
    if (port === p) disable().then(() => badge('ERR', 'Native host unavailable — click to retry'));
  });
  p.onMessage.addListener(async m => {
    if (port !== p || gen !== generation) return;
    if (m.type === 'ready') {
      try {
        attaching = chrome.webAuthenticationProxy.attach();
        await attaching;
        if (port !== p || gen !== generation) { await chrome.webAuthenticationProxy.detach(); return; }
        attached = true; await badge('ON', 'Remote FIDO enabled — click to disable');
      } catch { await disable(); await badge('ERR', 'Another proxy may be active. Disable the old extension in this profile first.'); }
    }
    if (m.type === 'result' && pending.delete(m.requestId)) {
      await chrome.webAuthenticationProxy.completeGetRequest({requestId: m.requestId,
        ...(m.error ? {error: {name: 'NotAllowedError', message: m.error}} : {responseJson: m.responseJson})}).catch(() => {});
      await badge('ON', 'Remote FIDO enabled — click to disable');
    }
  });
  p.postMessage({type: 'hello'});
}
chrome.action.onClicked.addListener(() => serial(() => localApproval ? badge('LOCAL', 'Local approval in progress — forwarding is suspended') : port ? disable() : enable()).catch(() => disable()));
chrome.runtime.onConnectExternal.addListener(p => {
  if (p.sender?.id !== APPROVER_ID || p.sender?.url !== `chrome-extension://${APPROVER_ID}/app.html` || p.name !== 'remote-fido-local-approval-v1') { p.disconnect(); return; }
  let disconnected = false;
  p.onMessage.addListener(m => {
    if (m?.type === 'pulse' && localApproval === p && !disconnected) p.postMessage({type: 'pulse'});
  });
  p.onDisconnect.addListener(() => {
    disconnected = true;
    serial(async () => {
      if (localApproval !== p) return;
      localApproval = null;
      await chrome.storage.session.remove('approvalUntil');
      // No silent remote reattachment after a local signing operation.
      await badge('OFF', 'Local approval finished — click to enable remote forwarding');
    });
  });
  serial(async () => {
    if (disconnected) return;
    if (localApproval || pending.size) { p.postMessage({type: 'refused', error: 'Another approval or outgoing login is active in this profile. Finish or cancel it first.'}); return; }
    localApproval = p;
    // A worker restart must not permit a click to reattach during signing.
    // All production requests expire within five minutes; retain six minutes.
    await chrome.storage.session.set({approvalUntil: Date.now() + 360000});
    await disable();
    await attaching.catch(() => {});
    // disable() normally tolerates detach errors; this acknowledgement must not.
    await chrome.webAuthenticationProxy.detach();
    if (disconnected) return;
    await badge('LOCAL', 'Local approval in progress — forwarding is suspended');
    p.postMessage({type: 'suspended', protocol: 1});
  }).catch(() => { if (!disconnected) p.postMessage({type: 'refused', error: 'Could not confirm forwarding suspension; start a new login after reloading both extensions.'}); });
});
chrome.webAuthenticationProxy.onGetRequest.addListener(async r => {
  if (localApproval || !attached || !port) {
    await chrome.webAuthenticationProxy.completeGetRequest({requestId: r.requestId, error: {name: 'NotAllowedError', message: 'Target is not enabled'}}); return;
  }
  pending.add(r.requestId); port.postMessage({type: 'get', ...r}); await badge('KEY', 'Waiting for selected approver');
});
chrome.webAuthenticationProxy.onCreateRequest.addListener(r => chrome.webAuthenticationProxy.completeCreateRequest({requestId: r.requestId,
  error: {name: 'NotSupportedError', message: 'Remote registration is not supported; disable proxy to register locally'}}));
chrome.webAuthenticationProxy.onIsUvpaaRequest.addListener(r => chrome.webAuthenticationProxy.completeIsUvpaaRequest({requestId: r.requestId, isUvpaa: attached}));
chrome.webAuthenticationProxy.onRequestCanceled.addListener(requestId => { if (pending.delete(requestId)) port?.postMessage({type: 'cancel', requestId}); });
// Worker or browser restart never silently reattaches an old remote session.
disable();
