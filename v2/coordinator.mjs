import fs from 'node:fs';
import {atomicJSON, check, signTicket} from './core.mjs';

export class Coordinator {
  constructor(config) {
    this.config = config;
    this.online = new Map();
    this.state = fs.existsSync(config.stateFile) ? JSON.parse(fs.readFileSync(config.stateFile)) :
      {revision: 0, selected: null, mode: 'selected', requests: {}};
  }
  save() {
    try { atomicJSON(this.config.stateFile, this.state); }
    catch (error) {
      // Never acknowledge an in-memory claim after persistence failed.
      this.state = fs.existsSync(this.config.stateFile) ? JSON.parse(fs.readFileSync(this.config.stateFile)) :
        {revision: 0, selected: null, mode: 'selected', requests: {}};
      throw error;
    }
  }
  device(id, role) {
    const d = this.config.devices[id];
    check(d?.roles.includes(role), 'Role not allowed', 403); return d;
  }
  allowed(approver, target) { return this.device(approver, 'approver').targets.includes(target); }
  live(r) { return r.expires > Date.now() && ['pending', 'assigned'].includes(r.state); }
  status(id) {
    this.online.set(id, Date.now());
    const d = this.config.devices[id];
    return {revision: this.state.revision, selected: this.state.selected, mode: this.state.mode,
      devices: Object.entries(this.config.devices).map(([id, d]) => ({id, name: d.name, roles: d.roles,
        lastSeen: this.online.get(id) ?? null})),
      requests: Object.values(this.state.requests).filter(r => this.live(r) &&
        d.roles.includes('approver') && d.targets.includes(r.target)).map(r => ({...r,
          endpoint: this.config.devices[r.target].endpoint}))};
  }
  select(id, {revision, mode = 'selected'}) {
    this.device(id, 'approver');
    check(revision === this.state.revision, 'Selection changed; refresh', 409);
    check(['selected', 'any'].includes(mode), 'Invalid selection mode');
    this.state.selected = id; this.state.mode = mode; this.state.revision++; this.save();
    return this.status(id);
  }
  register(id, r) {
    this.device(id, 'target');
    check(typeof r.id === 'string' && /^[0-9a-f-]{36}$/.test(r.id), 'Invalid request ID');
    check(typeof r.digest === 'string' && /^[0-9a-f]{64}$/.test(r.digest), 'Invalid digest');
    check(Number.isFinite(r.expires) && r.expires > Date.now() && r.expires <= Date.now() + 301000, 'Invalid expiry');
    check(typeof r.origin === 'string' && r.origin.length <= 256 && typeof r.rpId === 'string' && r.rpId.length <= 253, 'Invalid summary');
    const old = this.state.requests[r.id];
    if (old) {
      check(old.target === id && old.digest === r.digest && old.expires === r.expires, 'Request ID collision', 409);
      return old;
    }
    for (const [key, value] of Object.entries(this.state.requests)) {
      if (value.expires < Date.now() - 3600000) delete this.state.requests[key];
    }
    check(Object.values(this.state.requests).filter(x => x.target === id && this.live(x)).length < 64, 'Too many requests', 429);
    const value = {id: r.id, target: id, digest: r.digest, origin: r.origin, rpId: r.rpId,
      expires: r.expires, state: 'pending'};
    this.state.requests[r.id] = value; this.save(); return value;
  }
  claim(id, {requestId, oneOff = false}) {
    const r = this.state.requests[requestId];
    check(r && this.live(r), 'Request no longer pending', 410);
    check(this.allowed(id, r.target), 'Target not allowed', 403);
    if (r.approver) check(r.approver === id, 'Already claimed on another device', 409);
    else {
      check(oneOff === true || this.state.mode === 'any' || this.state.selected === id, 'Another approver is selected', 409);
      r.approver = id; r.revision = this.state.revision; r.state = 'assigned'; this.save();
    }
    return {ticket: signTicket({v: 2, requestId: r.id, target: r.target, digest: r.digest,
      approver: id, revision: r.revision, expires: r.expires}, this.config.privateKey),
      endpoint: this.config.devices[r.target].endpoint};
  }
  finish(id, {requestId, state}) {
    const r = this.state.requests[requestId];
    check(r?.target === id, 'Unknown target request', 404);
    check(['completed', 'cancelled', 'expired'].includes(state), 'Invalid terminal state');
    if (this.live(r)) { r.state = state; this.save(); }
    return {ok: true};
  }
}
