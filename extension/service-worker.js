const NATIVE_HOST = "de.lytiq.remote_fido";
const VERSION = 1;
const pending = new Map();
let nativePort = null;
let attached = false;

async function recordStatus(status, detail = "") {
  await chrome.storage.local.set({
    proxyStatus: status,
    proxyDetail: detail,
    proxyUpdatedAt: new Date().toISOString()
  });
}

async function detach() {
  if (!attached) return;
  try {
    await chrome.webAuthenticationProxy.detach();
  } finally {
    attached = false;
  }
}

async function completeFailure(requestId, name, message) {
  if (!pending.has(requestId)) return;
  pending.delete(requestId);
  await chrome.webAuthenticationProxy.completeGetRequest({
    requestId,
    error: {name, message}
  });
}

function connect() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (error) {
    recordStatus("native-host-error", String(error));
    return;
  }
  nativePort.onMessage.addListener(async message => {
    if (message?.version !== VERSION) return;
    if (message.type === "hello") {
      if (!message.ready) {
        await recordStatus("exporter-unavailable");
        nativePort?.disconnect();
        return;
      }
      try {
        const warning = await chrome.webAuthenticationProxy.attach();
        attached = true;
        await recordStatus("attached", warning ?? "");
      } catch (error) {
        await recordStatus("attach-error", String(error));
        nativePort?.disconnect();
      }
      return;
    }
    if (message.type !== "response" || !Number.isSafeInteger(message.requestId) ||
        !pending.has(message.requestId)) return;
    pending.delete(message.requestId);
    if (message.error) {
      const exporterUnavailable =
        message.error.message === "Remote FIDO exporter is unavailable";
      await chrome.webAuthenticationProxy.completeGetRequest({
        requestId: message.requestId,
        error: message.error
      });
      if (exporterUnavailable) nativePort?.disconnect();
    } else {
      await chrome.webAuthenticationProxy.completeGetRequest({
        requestId: message.requestId,
        responseJson: message.responseJson
      });
    }
  });
  nativePort.onDisconnect.addListener(async () => {
    const detail = chrome.runtime.lastError?.message ?? "native host disconnected";
    nativePort = null;
    for (const requestId of [...pending.keys()]) {
      await completeFailure(requestId, "NotAllowedError", "Remote FIDO transport disconnected");
    }
    await detach();
    await recordStatus("detached", detail);
  });
  nativePort.postMessage({version: VERSION, type: "hello"});
}

chrome.webAuthenticationProxy.onCreateRequest.addListener(async request => {
  await chrome.webAuthenticationProxy.completeCreateRequest({
    requestId: request.requestId,
    error: {name: "NotSupportedError", message: "Remote FIDO registration is not enabled"}
  });
});

chrome.webAuthenticationProxy.onGetRequest.addListener(async request => {
  if (!attached || !nativePort) {
    await chrome.webAuthenticationProxy.completeGetRequest({
      requestId: request.requestId,
      error: {name: "NotAllowedError", message: "Remote FIDO exporter is not connected"}
    });
    return;
  }
  pending.set(request.requestId, true);
  nativePort.postMessage({
    version: VERSION,
    type: "get",
    requestId: request.requestId,
    requestDetailsJson: request.requestDetailsJson
  });
});

chrome.webAuthenticationProxy.onIsUvpaaRequest.addListener(async request => {
  await chrome.webAuthenticationProxy.completeIsUvpaaRequest({
    requestId: request.requestId,
    isUvpaa: false
  });
});

chrome.webAuthenticationProxy.onRequestCanceled.addListener(requestId => {
  if (!pending.delete(requestId) || !nativePort) return;
  nativePort.postMessage({version: VERSION, type: "cancel", requestId});
});

chrome.action.onClicked.addListener(connect);
connect();
