import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeEvent {
  listeners = [];

  addListener(listener) {
    this.listeners.push(listener);
  }

  async emit(...args) {
    await Promise.all(this.listeners.map(listener => listener(...args)));
  }
}

class FakePort {
  onMessage = new FakeEvent();
  onDisconnect = new FakeEvent();
  posted = [];
  disconnected = false;

  postMessage(message) {
    if (this.disconnected) throw new Error("port disconnected");
    this.posted.push(message);
  }

  disconnect() {
    this.disconnected = true;
    return this.onDisconnect.emit();
  }
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function createHarness({busyGate} = {}) {
  const source = await fs.readFile(new URL("./service-worker.js", import.meta.url), "utf8");
  const ports = [];
  const timers = new Map();
  const calls = {
    attach: 0,
    detach: 0,
    completed: [],
    badges: [],
    statuses: [],
  };
  let timerId = 0;

  const chrome = {
    action: {
      onClicked: new FakeEvent(),
      async setBadgeBackgroundColor() {},
      async setBadgeText(value) {
        calls.badges.push(value.text);
        if (value.text === "KEY" && busyGate) await busyGate;
      },
      async setTitle() {},
    },
    runtime: {
      lastError: null,
      connectNative() {
        const port = new FakePort();
        ports.push(port);
        return port;
      },
    },
    storage: {
      local: {
        async set(value) { calls.statuses.push(value.proxyStatus); },
      },
    },
    webAuthenticationProxy: {
      onCreateRequest: new FakeEvent(),
      onGetRequest: new FakeEvent(),
      onIsUvpaaRequest: new FakeEvent(),
      onRequestCanceled: new FakeEvent(),
      async attach() { calls.attach += 1; },
      async detach() { calls.detach += 1; },
      async completeCreateRequest(value) { calls.completed.push(value); },
      async completeGetRequest(value) { calls.completed.push(value); },
      async completeIsUvpaaRequest(value) { calls.completed.push(value); },
    },
  };

  vm.runInNewContext(source, {
    chrome,
    console: {log() {}},
    Date,
    clearTimeout(id) { timers.delete(id); },
    setTimeout(callback) {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
  });
  await settle();
  return {calls, chrome, ports, timers};
}

test("extension reconciles exporter loss and recovery without disconnecting native host", async () => {
  const harness = await createHarness();
  const port = harness.ports[0];
  assert.deepEqual(plain(port.posted), [{version: 1, type: "hello"}]);

  await port.onMessage.emit({version: 1, type: "hello", ready: false, detail: "down"});
  await settle();
  assert.equal(harness.calls.attach, 0);
  assert.equal(harness.calls.detach, 1);
  assert.equal(harness.calls.badges.at(-1), "OFF");
  assert.equal(port.disconnected, false);

  await port.onMessage.emit({version: 1, type: "hello", ready: true});
  await settle();
  assert.equal(harness.calls.detach, 2);
  assert.equal(harness.calls.attach, 1);
  assert.equal(harness.calls.badges.at(-1), "ON");

  await harness.chrome.webAuthenticationProxy.onGetRequest.emit({
    requestId: 7,
    requestDetailsJson: "{}",
  });
  await settle();
  assert.equal(port.posted.at(-1).type, "get");
  assert.equal(harness.calls.badges.at(-1), "KEY");

  await harness.chrome.webAuthenticationProxy.onGetRequest.emit({
    requestId: 8,
    requestDetailsJson: "{}",
  });
  await settle();
  assert.equal(harness.calls.completed.at(-1).error.name, "InvalidStateError");

  await port.onMessage.emit({
    version: 1,
    type: "response",
    requestId: 7,
    error: {
      code: "transport-unavailable",
      name: "NotAllowedError",
      message: "wording may change without breaking detach",
    },
  });
  await settle();
  assert.deepEqual(plain(harness.calls.completed.at(-1).error), {
    name: "NotAllowedError",
    message: "wording may change without breaking detach",
  });
  assert.equal(harness.calls.badges.at(-1), "OFF");
  assert.equal(port.disconnected, false);
});

test("extension reconnects after native-host death and preserves cancellation", async () => {
  const harness = await createHarness();
  const port = harness.ports[0];
  await port.onMessage.emit({version: 1, type: "hello", ready: true});
  await settle();

  await harness.chrome.webAuthenticationProxy.onGetRequest.emit({
    requestId: -91,
    requestDetailsJson: "{}",
  });
  await settle();
  await harness.chrome.webAuthenticationProxy.onRequestCanceled.emit(-91);
  await settle();
  assert.deepEqual(
    plain(port.posted.at(-1)), {version: 1, type: "cancel", requestId: -91});

  await port.onDisconnect.emit();
  await settle();
  assert.equal(harness.calls.badges.at(-1), "OFF");
  assert.equal(harness.timers.size, 1);

  const reconnect = [...harness.timers.values()][0];
  reconnect();
  await settle();
  assert.equal(harness.ports.length, 2);
  assert.deepEqual(
    plain(harness.ports[1].posted), [{version: 1, type: "hello"}]);
});

test("cancellation during a status update never forwards a stale request", async () => {
  let releaseBusy;
  const busyGate = new Promise(resolve => { releaseBusy = resolve; });
  const harness = await createHarness({busyGate});
  const port = harness.ports[0];
  await port.onMessage.emit({version: 1, type: "hello", ready: true});
  await settle();

  const get = harness.chrome.webAuthenticationProxy.onGetRequest.emit({
    requestId: 73,
    requestDetailsJson: "{}",
  });
  await settle();
  assert.equal(harness.calls.badges.at(-1), "KEY");
  await harness.chrome.webAuthenticationProxy.onRequestCanceled.emit(73);
  releaseBusy();
  await get;
  await settle();

  assert.equal(port.posted.some(message => message.type === "get"), false);
  assert.deepEqual(
    plain(port.posted.at(-1)), {version: 1, type: "cancel", requestId: 73});
});
