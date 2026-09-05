let port = null; let attached = false; let generation = 0;
const pending = new Set();
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
        await chrome.webAuthenticationProxy.attach();
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
chrome.action.onClicked.addListener(() => (port ? disable() : enable()).catch(() => disable()));
chrome.webAuthenticationProxy.onGetRequest.addListener(async r => {
  if (!attached || !port) {
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
