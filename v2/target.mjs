import crypto from 'node:crypto';
import {check, parseRequest, validateAssertion, verifyTicket} from './core.mjs';

export class Target {
  constructor(config, coordinator) {
    this.config = config; this.coordinator = coordinator; this.requests = new Map(); this.sessions = new Map();
  }
  session(id) { this.sessions.set(id, Date.now()); return {ok: true}; }
  async create(session, {id, raw}) {
    check(this.sessions.has(session), 'Unknown browser session', 403);
    check(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 'Invalid request ID');
    const old = this.requests.get(id);
    if (old) { check(old.session === session && old.raw === raw, 'Request collision', 409); return {id}; }
    check([...this.requests.values()].filter(r => this.active(r)).length < 64, 'Too many requests', 429);
    const r = {id, raw, session, ...parseRequest(raw, this.config.rpOrigins), state: 'pending'};
    this.requests.set(id, r);
    try { await this.coordinator('/requests', {id, digest: r.digest, origin: r.origin, rpId: r.rpId, expires: r.expires}); }
    catch (e) { r.state = 'cancelled'; throw e; }
    return {id};
  }
  active(r) {
    return r.expires > Date.now() && ['pending', 'started'].includes(r.state) &&
      Date.now() - (this.sessions.get(r.session) ?? 0) < 15000;
  }
  authorize(approver, ticket) {
    const t = verifyTicket(ticket, this.config.publicKey);
    check(t.target === this.config.id && t.approver === approver, 'Assignment audience mismatch', 403);
    const r = this.requests.get(t.requestId);
    check(r && r.digest === t.digest && r.expires === t.expires, 'Unknown assignment', 410);
    check(this.config.approvers.includes(approver), 'Approver not allowed', 403);
    return r;
  }
  start(approver, {ticket}) {
    const r = this.authorize(approver, ticket);
    check(this.active(r), 'Request cancelled or expired', 410);
    check(r.state === 'pending', 'Signing already started; do not retry', 409);
    r.state = 'started'; r.approver = approver; r.execution = crypto.randomUUID();
    return {id: r.id, raw: r.raw, origin: r.origin, rpId: r.rpId, page: r.page, options: r.options,
      expires: r.expires, execution: r.execution};
  }
  inspect(approver, {ticket}) {
    const r = this.authorize(approver, ticket);
    return {state: this.active(r) ? r.state : r.state === 'completed' ? 'completed' : 'cancelled'};
  }
  complete(approver, {ticket, execution, result, error}) {
    const r = this.authorize(approver, ticket);
    check(r.approver === approver && r.execution === execution, 'Execution mismatch', 403);
    if (r.state === 'completed') {
      check(JSON.stringify(r.result) === JSON.stringify(result), 'Different duplicate result', 409); return {ok: true};
    }
    check(this.active(r) && r.state === 'started', 'Request cancelled or expired', 410);
    if (error) { this.cancel(r.id); return {ok: true}; }
    r.result = validateAssertion(r, result); r.state = 'completed';
    this.coordinator('/finish', {requestId: r.id, state: 'completed'}).catch(() => {});
    return {ok: true};
  }
  cancel(id) {
    const r = this.requests.get(id);
    if (r && ['pending', 'started'].includes(r.state)) {
      r.state = 'cancelled'; this.coordinator('/finish', {requestId: r.id, state: 'cancelled'}).catch(() => {});
    }
    return {ok: true};
  }
  result(session, id) {
    const r = this.requests.get(id); check(r?.session === session, 'Unknown browser request', 404);
    if (!this.active(r) && ['pending', 'started'].includes(r.state)) this.cancel(id);
    return {state: r.state, ...(r.state === 'completed' ? {result: r.result} : {})};
  }
  close(session) { this.sessions.delete(session); for (const r of this.requests.values()) if (r.session === session) this.cancel(r.id); return {ok: true}; }
  sweep() {
    for (const r of this.requests.values()) {
      if (!this.active(r)) this.cancel(r.id);
      if (r.expires < Date.now() - 60000) this.requests.delete(r.id);
    }
    for (const [id, at] of this.sessions) if (Date.now() - at > 15000) this.sessions.delete(id);
  }
}
