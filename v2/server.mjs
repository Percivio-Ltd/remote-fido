import fs from 'node:fs';
import {Coordinator} from './coordinator.mjs';
import {Target} from './target.mjs';
import {serve, call} from './http.mjs';
import {check} from './core.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2]));
let service;
if (config.role === 'coordinator') {
  const c = new Coordinator(config);
  service = serve(config, ({id, route, body}) => {
    if (route === 'GET /status') return c.status(id);
    if (route === 'POST /select') return c.select(id, body);
    if (route === 'POST /requests') return c.register(id, body);
    if (route === 'POST /claim') return c.claim(id, body);
    if (route === 'POST /finish') return c.finish(id, body);
    check(false, 'Not found', 404);
  });
} else {
  check(config.role === 'target', 'Invalid role');
  const target = new Target(config, (route, body) => call(config.coordinator, config.coordinatorToken, route, body));
  setInterval(() => target.sweep(), 1000).unref();
  service = serve(config, ({id, route, body, req}) => {
    if (id === 'bridge') {
      check(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
        !req.headers['tailscale-user-login'] && !req.headers['x-forwarded-for'], 'Local bridge only', 403);
      const session = body?.session;
      if (route === 'POST /session') { check(typeof session === 'string' && /^[0-9a-f-]{36}$/.test(session), 'Invalid session'); return target.session(session); }
      if (route === 'POST /create') return target.create(session, body);
      if (route === 'POST /result') return target.result(session, body.id);
      if (route === 'POST /cancel') { target.result(session, body.id); return target.cancel(body.id); }
      if (route === 'POST /close') return target.close(session);
      if (route === 'GET /health') return {ok: true};
    } else {
      if (route === 'POST /start') return target.start(id, body);
      if (route === 'POST /inspect') return target.inspect(id, body);
      if (route === 'POST /complete') return target.complete(id, body);
    }
    check(false, 'Not found', 404);
  });
}
service.requestTimeout = 10000; service.headersTimeout = 10000;
service.listen(config.port, '127.0.0.1', () => console.error(`Remote FIDO v2 ${config.role} listening on loopback:${config.port}`));
