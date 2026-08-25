const NATIVE_HOST = "de.lytiq.remote_fido";
const VERSION = 1;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const pending = new Map();

let nativePort = null;
let proxyState = "unknown";
let exporterReady = false;
let reconnectDelayMs = RECONNECT_MIN_MS;
let reconnectTimer = null;
let statusTimer = null;
let lifecycle = Promise.resolve();

const BADGES = {
  connecting: {text: "…", color: "#6b7280"},
  detached: {text: "OFF", color: "#6b7280"},
  ready: {text: "ON", color: "#15803d"},
  busy: {text: "KEY", color: "#b45309"},
  success: {text: "OK", color: "#15803d"},
  error: {text: "ERR", color: "#b91c1c"},
};

function enqueueLifecycle(action) {
  lifecycle = lifecycle.then(action, action);
  return lifecycle;
}

async function recordStatus(status, detail = "") {
  const badge = BADGES[status] ?? BADGES.error;
  await Promise.all([
    chrome.storage.local.set({
      proxyStatus: status,
      proxyDetail: detail,
      proxyUpdatedAt: new Date().toISOString(),
    }),
    chrome.action.setBadgeBackgroundColor({color: badge.color}),
    chrome.action.setBadgeText({text: badge.text}),
    chrome.action.setTitle({
      title: `Remote FIDO: ${status}${detail ? ` — ${detail}` : ""}`,
    }),
  ]);
  console.log(`remote-fido:${status}`, detail);
}

async function detach({force = false} = {}) {
  if (!force && proxyState === "detached") return;
  try {
    await chrome.webAuthenticationProxy.detach();
  } catch (error) {
    console.log("remote-fido:detach reconciliation", String(error));
  } finally {
    proxyState = "detached";
  }
}

async function becomeReady(detail = "") {
  exporterReady = true;
  reconnectDelayMs = RECONNECT_MIN_MS;
  if (proxyState !== "attached") {
    // A Manifest V3 worker can restart while Chrome still remembers the old
    // attachment. Reconcile the external state before trusting memory.
    await detach({force: true});
    try {
      const warning = await chrome.webAuthenticationProxy.attach();
      proxyState = "attached";
      detail = warning ?? detail;
    } catch (error) {
      exporterReady = false;
      proxyState = "unknown";
      await recordStatus("error", `attach failed: ${String(error)}`);
      return;
    }
  }
  await recordStatus("ready", detail);
}

async function becomeUnavailable(detail = "exporter unavailable") {
  exporterReady = false;
  await detach({force: true});
  await recordStatus("detached", detail);
}

async function completeFailure(requestId, name, message) {
  if (!pending.has(requestId)) return;
  pending.delete(requestId);
  await chrome.webAuthenticationProxy.completeGetRequest({
    requestId,
    error: {name, message},
  });
}

function restoreReadyBadgeSoon() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    if (exporterReady && proxyState === "attached" && pending.size === 0) {
      recordStatus("ready");
    }
  }, 2500);
}

function scheduleReconnect() {
  if (nativePort || reconnectTimer) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (nativePort) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  recordStatus("connecting");

  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
  } catch (error) {
    recordStatus("error", `native host unavailable: ${String(error)}`);
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener(message => {
    if (message?.version !== VERSION) {
      enqueueLifecycle(() => becomeUnavailable("protocol version mismatch"));
      return;
    }
    if (message.type === "hello") {
      enqueueLifecycle(() => message.ready
        ? becomeReady(message.detail ?? "")
        : becomeUnavailable(message.detail ?? "exporter unavailable"));
      return;
    }
    if (message.type !== "response" || !Number.isSafeInteger(message.requestId) ||
        !pending.has(message.requestId)) return;

    pending.delete(message.requestId);
    if (message.error) {
      const {
        code,
        name = "NotAllowedError",
        message: detail = "Remote FIDO failed",
      } = message.error;
      chrome.webAuthenticationProxy.completeGetRequest({
        requestId: message.requestId,
        error: {name, message: detail},
      });
      if (code === "transport-unavailable") {
        enqueueLifecycle(() => becomeUnavailable(detail));
      } else {
        recordStatus("error", detail);
        restoreReadyBadgeSoon();
      }
    } else {
      chrome.webAuthenticationProxy.completeGetRequest({
        requestId: message.requestId,
        responseJson: message.responseJson,
      });
      recordStatus("success");
      restoreReadyBadgeSoon();
    }
  });

  port.onDisconnect.addListener(async () => {
    if (nativePort !== port) return;
    const detail = chrome.runtime.lastError?.message ?? "native host disconnected";
    nativePort = null;
    exporterReady = false;
    for (const requestId of [...pending.keys()]) {
      await completeFailure(
        requestId, "NotAllowedError", "Remote FIDO transport disconnected");
    }
    await enqueueLifecycle(() => becomeUnavailable(detail));
    scheduleReconnect();
  });

  try {
    port.postMessage({version: VERSION, type: "hello"});
  } catch (error) {
    recordStatus("error", `native hello failed: ${String(error)}`);
    port.disconnect();
  }
}

chrome.webAuthenticationProxy.onCreateRequest.addListener(async request => {
  await chrome.webAuthenticationProxy.completeCreateRequest({
    requestId: request.requestId,
    error: {
      name: "NotSupportedError",
      message: "Remote FIDO registration is not enabled",
    },
  });
});

chrome.webAuthenticationProxy.onGetRequest.addListener(async request => {
  await lifecycle;
  if (proxyState !== "attached" || !exporterReady || !nativePort) {
    await chrome.webAuthenticationProxy.completeGetRequest({
      requestId: request.requestId,
      error: {
        name: "NotAllowedError",
        message: "Remote FIDO exporter is not connected",
      },
    });
    return;
  }
  if (pending.size !== 0) {
    await chrome.webAuthenticationProxy.completeGetRequest({
      requestId: request.requestId,
      error: {
        name: "InvalidStateError",
        message: "Another security-key request is active",
      },
    });
    return;
  }
  pending.set(request.requestId, true);
  await recordStatus("busy", String(request.requestId));
  if (!pending.has(request.requestId) || !nativePort || !exporterReady) return;
  try {
    nativePort.postMessage({
      version: VERSION,
      type: "get",
      requestId: request.requestId,
      requestDetailsJson: request.requestDetailsJson,
    });
  } catch (error) {
    await completeFailure(
      request.requestId, "NotAllowedError", "Remote FIDO native host disconnected");
    nativePort?.disconnect();
  }
});

chrome.webAuthenticationProxy.onIsUvpaaRequest.addListener(async request => {
  await chrome.webAuthenticationProxy.completeIsUvpaaRequest({
    requestId: request.requestId,
    isUvpaa: false,
  });
});

chrome.webAuthenticationProxy.onRequestCanceled.addListener(requestId => {
  if (!pending.delete(requestId) || !nativePort) return;
  try {
    nativePort.postMessage({version: VERSION, type: "cancel", requestId});
  } catch (error) {
    console.error("remote-fido:cancel forwarding failed", String(error));
  }
  recordStatus("ready", "request canceled");
});

chrome.action.onClicked.addListener(() => {
  if (nativePort) {
    recordStatus("connecting", "checking exporter");
    nativePort.postMessage({version: VERSION, type: "hello"});
  } else {
    reconnectDelayMs = RECONNECT_MIN_MS;
    connect();
  }
});

connect();
