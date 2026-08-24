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

function sendToChrome(value) {
  process.stdout.write(encodeFrame(value, "LE"));
}

function safeFailure(requestId) {
  return {
    version: PROTOCOL_VERSION,
    type: "response",
    requestId,
    error: {
      name: "NotAllowedError",
      message: "Remote FIDO exporter is unavailable",
    },
  };
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
    sendToChrome(message.type === "hello"
      ? {version: PROTOCOL_VERSION, type: "hello", ready: false}
      : safeFailure(requestId));
  };
  timer = setTimeout(() => {
    fail(new Error("exporter timeout"));
    socket.destroy();
  }, timeoutMs);
  if (Number.isSafeInteger(requestId)) pending.set(requestId, socket);
  socket.once("connect", () => {
    console.error(`connected to remote FIDO exporter for ${String(message.type)}`);
    socket.write(encodeFrame(message));
  });
  socket.on("data", chunk => {
    try {
      const responses = decoder.push(chunk);
      if (responses.length === 1) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sendToChrome(responses[0]);
        socket.end();
      }
    } catch (error) {
      socket.destroy(error);
    }
  });
  socket.once("error", fail);
  socket.once("close", () => {
    clearTimeout(timer);
    if (!settled) fail(new Error("exporter closed without a response"));
    if (Number.isSafeInteger(requestId) && pending.get(requestId) === socket) {
      pending.delete(requestId);
    }
  });
}

function handleMessage(message) {
  console.error(`received Chrome native message type=${String(message?.type)}`);
  if (message?.version !== PROTOCOL_VERSION) {
    sendToChrome(safeFailure(message?.requestId));
    return;
  }
  if (message.type === "cancel" && Number.isSafeInteger(message.requestId)) {
    pending.get(message.requestId)?.destroy();
    pending.delete(message.requestId);
    return;
  }
  if (message.type !== "hello" && message.type !== "get") {
    sendToChrome({
      version: PROTOCOL_VERSION,
      type: "response",
      requestId: message.requestId,
      error: {name: "NotSupportedError", message: "Only authentication assertions are supported"},
    });
    return;
  }
  forward(message);
}

process.stdin.on("data", chunk => {
  try {
    for (const message of chromeDecoder.push(chunk)) handleMessage(message);
  } catch (error) {
    console.error(`invalid Chrome native message: ${error.message}`);
    process.exitCode = 1;
    process.stdin.destroy();
  }
});
process.stdin.once("end", () => {
  for (const socket of pending.values()) socket.destroy();
});
