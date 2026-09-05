import {ceremony, cancelCeremony} from './ceremony.js';
import {bindRequest} from './request.js';
const $ = id => document.getElementById(id);
let config = (await chrome.storage.local.get('config')).config; let state; let busy = false; let polling = false;
let activeCancel;
addEventListener('pagehide', () => activeCancel?.());
const message = value => { $('message').textContent = value; };
$('browser-origin').textContent = `Browser extension origin (register this exact value): ${location.origin}`;
function validateConfig(c) {
  if (!c || !/^[a-z0-9-]+$/.test(c.id) || typeof c.token !== 'string' || c.token.length < 32) throw new Error('Invalid device config');
  for (const endpoint of [c.coordinator, ...Object.keys(c.targetTokens ?? {})]) {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' || !u.hostname.endsWith('.tailbb0f71.ts.net') || u.origin !== endpoint) throw new Error('Expected exact HTTPS tailnet origin');
  }
}
async function api(endpoint, route, body, token = config.token) {
  const response = await fetch(`${endpoint}${route}`, {method: body ? 'POST' : 'GET',
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(5000), redirect: 'error'});
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Request failed'); return data;
}
async function refresh() {
  if (!config || polling) return; polling = true;
  try {
    validateConfig(config); state = await api(config.coordinator, '/status');
    $('device').textContent = config.name ?? config.id;
    $('selection').textContent = state.mode === 'any' ? 'Any authorized device can claim; only one can sign.' : `Selected: ${state.selected ?? 'none — choose a device'}`;
    $('devices').textContent = state.devices.map(d => `${d.name}: ${d.lastSeen && Date.now() - d.lastSeen < 70000 ? 'recently connected' : 'not recently seen'}`).join(' · ');
    $('requests').replaceChildren();
    for (const r of state.requests) {
      const div = document.createElement('div'); div.className = 'request';
      const title = document.createElement('p'); title.textContent = `${r.target} → ${r.origin} · ${Math.max(0, Math.ceil((r.expires - Date.now()) / 1000))}s left${r.approver ? ` · claimed by ${r.approver}` : ''}`;
      const button = document.createElement('button');
      const oneOff = state.mode !== 'any' && state.selected !== config.id;
      button.textContent = oneOff ? 'Handle this request here (one-off)' : 'Approve this request';
      button.disabled = busy || Boolean(r.approver);
      button.onclick = () => approve(r, oneOff).catch(e => message(e.message));
      div.append(title, button); $('requests').append(div);
    }
    if (!state.requests.length) $('requests').textContent = 'No pending requests.';
  } catch (e) { message(`Coordinator unavailable: ${e.message}. Existing claims do not move to another device.`); }
  finally { polling = false; }
}
async function approve(r, oneOff) {
  if (busy) return;
  // Web Locks are scoped to this extension origin, so multiple open app pages
  // cannot race independent local prompts.
  await navigator.locks.request('remote-fido-ceremony', {ifAvailable: true}, async lock => {
    if (!lock) throw new Error('Another approval page is already signing on this device');
    busy = true; let tab; let timer; let claim; let request; let token;
    try {
      claim = await api(config.coordinator, '/claim', {requestId: r.id, oneOff});
      token = config.targetTokens[claim.endpoint]; if (!token) throw new Error('Target endpoint is not provisioned');
      request = await api(claim.endpoint, '/start', {ticket: claim.ticket}, token);
      request = await bindRequest(request, r);
      if (new URL(request.page).origin !== request.origin || request.origin !== r.origin || request.id !== r.id)
        throw new Error('Target request binding mismatch');
      tab = await chrome.tabs.create({url: request.page, active: true});
      const deadline = Math.min(Date.now() + 15000, request.expires);
      while (Date.now() < deadline) {
        const current = await chrome.tabs.get(tab.id);
        if (current.status === 'complete') {
          if (current.url !== request.page) throw new Error('Approval page redirected'); break;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const current = await chrome.tabs.get(tab.id);
      if (current.status !== 'complete' || current.url !== request.page) throw new Error('Approval page did not load');
      // Pin Chrome's documentId where available. Safari lacks this result field,
      // so its fallback keeps strict URL checks and pagehide cancellation.
      const [probe] = await chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'ISOLATED', func: () => location.href});
      if (probe.result !== request.page) throw new Error('Approval document changed');
      const target = probe.documentId ? {tabId: tab.id, documentIds: [probe.documentId]} : {tabId: tab.id, frameIds: [0]};
      activeCancel = () => {
        chrome.scripting.executeScript({target, world: 'ISOLATED', func: cancelCeremony, args: [request.id]}).catch(() => {});
        fetch(`${claim.endpoint}/complete`, {method: 'POST', keepalive: true, redirect: 'error',
          headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
          body: JSON.stringify({ticket: claim.ticket, execution: request.execution, error: true})}).catch(() => {});
      };
      let checking = false;
      timer = setInterval(async () => {
        if (checking) return; checking = true;
        try {
          const status = await api(claim.endpoint, '/inspect', {ticket: claim.ticket}, token);
          if (status.state !== 'started') throw new Error('Cancelled');
        } catch { await chrome.scripting.executeScript({target, world: 'ISOLATED', func: cancelCeremony, args: [request.id]}).catch(() => {}); }
        finally { checking = false; }
      }, 1000);
      message('Use the button on the dedicated approval page. The system passkey prompt stays local.');
      const [response] = await chrome.scripting.executeScript({target, world: 'ISOLATED', func: ceremony, args: [{...request, targetName: r.target}]});
      clearInterval(timer);
      if (!response?.result) throw new Error('Approval page was closed or navigated');
      const body = {ticket: claim.ticket, execution: request.execution, ...response.result};
      // Retry transport of identical bytes only, never the signing ceremony.
      try { await api(claim.endpoint, '/complete', body, token); }
      catch { await api(claim.endpoint, '/complete', body, token); }
      if (response.result.error) throw new Error(response.result.error);
      message('Assertion delivered to the target. The website decides whether login succeeds.');
    } catch (e) {
      if (request && claim) await api(claim.endpoint, '/complete', {ticket: claim.ticket, execution: request.execution, error: true}, token).catch(() => {});
      throw e;
    } finally { clearInterval(timer); activeCancel = null; busy = false; await refresh(); }
  });
}
$('config').onchange = async event => {
  try {
    if (busy) throw new Error('Finish the active approval before changing configuration');
    const candidate = JSON.parse(await event.target.files[0].text()); validateConfig(candidate);
    config = candidate; await chrome.storage.local.set({config}); message('Configuration saved locally.'); await refresh();
  } catch (e) { message(e.message); } finally { event.target.value = ''; }
};
for (const [id, mode] of [['select', 'selected'], ['any', 'any']]) $(id).onclick = async () => {
  try { if (!state) throw new Error('Load configuration first'); await api(config.coordinator, '/select', {revision: state.revision, mode}); await refresh(); }
  catch (e) { message(e.message); await refresh(); }
};
$('refresh').onclick = refresh;
setInterval(refresh, 2000); await refresh();
