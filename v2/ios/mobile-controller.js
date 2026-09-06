import {bindRequest} from '../approver-extension/request.js';
import {ceremony, cancelCeremony} from '../approver-extension/ceremony.js';

export function validateMobileConfig(c) {
  if (!c || !/^[a-z0-9-]+$/.test(c.id) || typeof c.token !== 'string' || c.token.length < 32 ||
      !c.targetTokens || !Object.keys(c.targetTokens).length) throw new Error('Invalid device configuration');
  for (const endpoint of [c.coordinator, ...Object.keys(c.targetTokens)]) {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' || !u.hostname.endsWith('.tailbb0f71.ts.net') || u.origin !== endpoint)
      throw new Error('Expected an exact HTTPS endpoint on your tailnet');
  }
  for (const token of Object.values(c.targetTokens)) if (typeof token !== 'string' || token.length < 32) throw new Error('Invalid target credential');
  return c;
}
export async function mobileCall(endpoint, token, route, body) {
  const r = await fetch(`${endpoint}${route}`, {method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(5000)});
  const value = await r.json(); if (!r.ok) throw new Error(value.error ?? `HTTP ${r.status}`); return value;
}
export class MobileController {
  constructor(browser, call = mobileCall, bind = bindRequest) {
    this.browser = browser; this.call = call; this.bind = bind; this.queue = Promise.resolve();
  }
  handle(message, sender) {
    // Serialize short background events. Storage, not the lifetime of this
    // background page, owns the sole active execution.
    const task = this.queue.then(() => this.dispatch(message, sender));
    this.queue = task.catch(() => {}); return task;
  }
  async load() { return this.browser.storage.local.get(['config', 'mobileActive']); }
  async save(active) { await this.browser.storage.local.set({mobileActive: active}); }
  live(a) { return a && a.expires > Date.now() && !['completed', 'cancelled'].includes(a.phase); }
  app(sender) {
    if (sender.id !== this.browser.runtime.id || sender.url !== this.browser.runtime.getURL('app.html')) throw new Error('Dashboard message required');
  }
  content(sender, m, a) {
    if (!a || sender.id !== this.browser.runtime.id || sender.tab?.id !== a.tabId || sender.frameId !== 0 ||
        sender.url !== a.request?.page || m.id !== a.id || m.nonce !== a.nonce ||
        (a.documentId && sender.documentId !== a.documentId)) throw new Error('Approval document binding mismatch');
  }
  async dispatch(m, sender) {
    const {config, mobileActive: a} = await this.load();
    if (m.type === 'mobile-pulse' || m.type === 'mobile-finish') {
      this.content(sender, m, a);
      if (m.type === 'mobile-pulse') {
        if (!this.live(a) || a.phase !== 'mounted') return {state: 'cancelled'};
        return this.call(a.endpoint, a.token, '/inspect', {ticket: a.ticket});
      }
      if (!this.live(a) || a.phase !== 'mounted') throw new Error('Approval no longer active; do not repeat signing');
      if (!m.outcome || Boolean(m.outcome.result) === Boolean(m.outcome.error)) throw new Error('Invalid ceremony outcome');
      a.phase = 'delivering'; await this.save(a); // never re-open the signing operation after a worker restart
      const body = {ticket: a.ticket, execution: a.request.execution,
        ...(m.outcome.error ? {error: true} : {result: m.outcome.result})};
      try { await this.call(a.endpoint, a.token, '/complete', body); }
      catch { await this.call(a.endpoint, a.token, '/complete', body); }
      a.phase = m.outcome.error ? 'cancelled' : 'completed';
      // Drop the ticket and direct endpoint credential after terminal delivery.
      await this.save({id: a.id, phase: a.phase, expires: a.expires}); return {ok: true};
    }
    this.app(sender);
    if (m.type === 'mobile-configure') {
      if (this.live(a)) throw new Error('Cancel the active request before replacing configuration');
      validateMobileConfig(m.config); await this.browser.storage.local.set({config: m.config}); return {ok: true};
    }
    if (m.type === 'mobile-status') {
      if (!config) return {configured: false};
      validateMobileConfig(config);
      const result = {configured: true, device: {id: config.id, name: config.name}, active: this.live(a) ? {id: a.id, phase: a.phase, expires: a.expires} : null};
      try { result.state = await this.call(config.coordinator, config.token, '/status'); }
      catch (e) { result.connectionError = e.message; }
      return result;
    }
    validateMobileConfig(config);
    if (m.type === 'mobile-select') return this.call(config.coordinator, config.token, '/select', {revision: m.revision, mode: m.mode});
    if (m.type === 'mobile-cancel') {
      if (a?.ticket && a.request) {
        await this.browser.scripting.executeScript({target: {tabId: a.tabId, frameIds: [0]}, world: 'ISOLATED', func: cancelCeremony, args: [a.id]}).catch(() => {});
        await this.call(a.endpoint, a.token, '/complete', {ticket: a.ticket, execution: a.request.execution, error: true});
      }
      // An in-flight start may be ambiguous. Do not permit another execution
      // until the original deadline if no cancellation could be confirmed.
      if (a && !a.request) throw new Error('Opening was interrupted. Cancel the target login; this local slot clears at its original deadline.');
      await this.save(null); return {ok: true};
    }
    if (m.type !== 'mobile-approve') throw new Error('Unknown command');
    if (this.live(a)) throw new Error('Another approval is active on this device');
    const state = await this.call(config.coordinator, config.token, '/status');
    const summary = state.requests.find(r => r.id === m.id);
    if (!summary || summary.approver || summary.expires <= Date.now()) throw new Error('Request is no longer available');
    const current = {id: summary.id, expires: summary.expires, phase: 'opening', nonce: crypto.randomUUID()};
    await this.save(current);
    try {
      const claim = await this.call(config.coordinator, config.token, '/claim', {requestId: summary.id, oneOff: m.oneOff === true});
      current.endpoint = claim.endpoint; current.ticket = claim.ticket; current.token = config.targetTokens[claim.endpoint];
      if (!current.token) throw new Error('Target endpoint was not provisioned');
      await this.save(current);
      const request = await this.call(current.endpoint, current.token, '/start', {ticket: current.ticket});
      current.request = await this.bind(request, summary); current.phase = 'claimed'; await this.save(current);
      const tab = await this.browser.tabs.create({url: request.page, active: true}); current.tabId = tab.id; await this.save(current);
      const deadline = Math.min(Date.now() + 15000, current.expires);
      let loaded = false;
      while (Date.now() < deadline) {
        const tab = await this.browser.tabs.get(current.tabId);
        if (tab.status === 'complete') {
          if (tab.url !== request.page) throw new Error('Approval page redirected'); loaded = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (!loaded) throw new Error('Approval page did not load');
      const [probe] = await this.browser.scripting.executeScript({target: {tabId: current.tabId, frameIds: [0]}, world: 'ISOLATED', func: () => location.href});
      if (probe?.result !== request.page) throw new Error('Approval document changed');
      current.documentId = probe.documentId; current.phase = 'mounted'; await this.save(current);
      const target = probe.documentId ? {tabId: current.tabId, documentIds: [probe.documentId]} : {tabId: current.tabId, frameIds: [0]};
      const [mounted] = await this.browser.scripting.executeScript({target, world: 'ISOLATED', func: ceremony,
        args: [{...current.request, targetName: summary.target, mobileNonce: current.nonce}]});
      if (!mounted?.result?.mounted) throw new Error('Could not mount approval controls');
      return {ok: true};
    } catch (e) {
      if (current.request) {
        await this.call(current.endpoint, current.token, '/complete', {ticket: current.ticket, execution: current.request.execution, error: true}).catch(() => {});
        await this.save({...current, phase: 'cancelled', token: undefined, ticket: undefined, request: undefined});
      }
      throw e;
    }
  }
}
