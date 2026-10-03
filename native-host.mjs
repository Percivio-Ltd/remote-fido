#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeFrame,
  isTailscaleIPv4,
} from "./protocol.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const configIndex = process.argv.indexOf("--config");
const configPath = configIndex >= 0 && process.argv[configIndex + 1]
  ? process.argv[configIndex + 1]
  : path.join(currentDirectory, "config.json");
const HEALTH_INTERVAL_MS = 5000;
const HEALTH_RETRY_MS = 1500;
const HEALTH_TIMEOUT_MS = 4000;

function loadConfig() {
  const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!isTailscaleIPv4(value.connect) ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new TypeError("native-host config must contain a Tailscale IPv4 address and valid port");
  }
  return value;
}

const config = loadConfig();
const chromeDecoder = new FrameDecoder("LE");
const pending = new Map();
let healthTimer = null;
let healthSocket = null;
let healthInFlight = false;
let healthForceNext = false;
let lastReady = null;
let shuttingDown = false;

function sendToChrome(value) {
  if (shuttingDown || !process.stdout.writable) return;
  try {
    process.stdout.write(encodeFrame(value, "LE"));
  } catch (error) {
    console.error(`cannot write Chrome native message: ${error.message}`);
    shutdown();
  }
}

function safeFailure(requestId) {
  return {
    version: PROTOCOL_VERSION,
    type: "response",
    requestId,
    error: {
      code: "transport-unavailable",
      name: "NotAllowedError",
      message: "Remote FIDO exporter is unavailable",
    },
  };
}

function reportHealth(ready, detail = "", force = false) {
  if (force || ready !== lastReady) {
    sendToChrome({
      version: PROTOCOL_VERSION,
      type: "hello",
      ready,
      detail,
    });
  }
  lastReady = ready;
}

function scheduleHealth(delay = lastReady ? HEALTH_INTERVAL_MS : HEALTH_RETRY_MS) {
  if (shuttingDown) return;
  clearTimeout(healthTimer);
  healthTimer = setTimeout(() => probeHealth(false), delay);
}

function probeHealth(force) {
  if (shuttingDown) return;
  if (healthInFlight || pending.size !== 0) {
    healthForceNext ||= force;
    scheduleHealth(500);
    return;
  }

  healthInFlight = true;
  const socket = net.createConnection({host: config.connect, port: config.port});
  healthSocket = socket;
  const decoder = new FrameDecoder();
  let settled = false;
  const finish = (ready, detail = "") => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    healthInFlight = false;
    healthSocket = null;
    const shouldForce = force || healthForceNext;
    healthForceNext = false;
    reportHealth(ready, detail, shouldForce);
    scheduleHealth();
  };
  const timer = setTimeout(() => {
    socket.destroy();
    finish(false, "exporter health check timed out");
  }, HEALTH_TIMEOUT_MS);

  socket.once("connect", () => {
    socket.write(encodeFrame({version: PROTOCOL_VERSION, type: "hello"}));
  });
  socket.on("data", chunk => {
    try {
      const responses = decoder.push(chunk);
      if (responses.length !== 1) return;
      const response = responses[0];
      socket.end();
      finish(
        response?.version === PROTOCOL_VERSION &&
          response?.type === "hello" && response?.ready === true,
        response?.ready === true ? "" : "exporter has no available authenticator");
    } catch (error) {
      socket.destroy();
      finish(false, `invalid exporter health response: ${error.message}`);
    }
  });
  socket.once("error", error => finish(false, error.message));
  socket.once("close", () => {
    if (!settled) finish(false, "exporter closed without a health response");
  });
}

function forward(message) {
  const socket = net.createConnection({host: config.connect, port: config.port});
  const decoder = new FrameDecoder();
  const requestId = message.requestId;
  let settled = false;
  let timeoutMs = 5000;
  if (message.type === "get") {
    try {
      const requested = Number(JSON.parse(message.requestDetailsJson).timeout);
      const ceremonyMs = Number.isFinite(requested)
        ? Math.max(30_000, Math.min(300_000, Math.trunc(requested)))
        : 180_000;
      timeoutMs = ceremonyMs + 10_000;
    } catch {
      timeoutMs = 190_000;
    }
  }

  let timer;
  const fail = error => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    console.error(`remote FIDO exporter error: ${error.message}`);
    sendToChrome(safeFailure(requestId));
    reportHealth(false, error.message);
    scheduleHealth();
  };
  timer = setTimeout(() => {
    socket.destroy();
    fail(new Error("exporter timeout"));
  }, timeoutMs);

  if (Number.isSafeInteger(requestId)) pending.set(requestId, socket);
  socket.once("connect", () => {
    console.error(`connected to remote FIDO exporter for ${String(message.type)}`);
    socket.write(encodeFrame(message));
  });
  socket.on("data", chunk => {
    try {
      const responses = decoder.push(chunk);
      if (responses.length !== 1) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lastReady = true;
      sendToChrome(responses[0]);
      socket.end();
    } catch (error) {
      socket.destroy(error);
    }
  });
  socket.once("error", fail);
  socket.once("close", () => {
    clearTimeout(timer);
    if (!settled && !socket.remoteFidoCanceled) {
      fail(new Error("exporter closed without a response"));
    }
    if (Number.isSafeInteger(requestId) && pending.get(requestId) === socket) {
      pending.delete(requestId);
    }
    scheduleHealth();
  });
}

function handleMessage(message) {
  console.error(`received Chrome native message type=${String(message?.type)}`);
  if (message?.version !== PROTOCOL_VERSION) {
    sendToChrome(safeFailure(message?.requestId));
    return;
  }
  if (message.type === "hello") {
    probeHealth(true);
    return;
  }
  if (message.type === "cancel" && Number.isSafeInteger(message.requestId)) {
    const socket = pending.get(message.requestId);
    if (socket) {
      socket.remoteFidoCanceled = true;
      socket.destroy();
    }
    pending.delete(message.requestId);
    return;
  }
  if (message.type !== "get") {
    sendToChrome({
      version: PROTOCOL_VERSION,
      type: "response",
      requestId: message.requestId,
      error: {
        name: "NotSupportedError",
        message: "Only authentication assertions are supported",
      },
    });
    return;
  }
  forward(message);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(healthTimer);
  healthSocket?.destroy();
  for (const socket of pending.values()) socket.destroy();
  pending.clear();
  setImmediate(() => process.exit());
}

process.stdin.on("data", chunk => {
  try {
    for (const message of chromeDecoder.push(chunk)) handleMessage(message);
  } catch (error) {
    console.error(`invalid Chrome native message: ${error.message}`);
    process.exitCode = 1;
    shutdown();
  }
});
process.stdin.once("end", shutdown);
process.stdin.once("error", shutdown);
process.stdout.once("error", shutdown);
