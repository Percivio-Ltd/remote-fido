#!/usr/bin/env node

import crypto from "node:crypto";
import {spawn, spawnSync} from "node:child_process";
import net from "node:net";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  DEFAULT_PORT,
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeFrame,
  isTailscaleIPv4,
} from "./protocol.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

const GENERIC_FAILURE = {
  name: "NotAllowedError",
  message: "The local security key did not complete the request",
};

function decodeBase64Url(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return Buffer.from(value, "base64url");
}

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function assertOriginMayClaimRpId(origin, rpId) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError("remote origin is not a valid URL");
  }
  if (parsed.protocol !== "https:" || parsed.origin !== origin) {
    throw new TypeError("remote origin must be a canonical HTTPS origin");
  }
  const hostname = parsed.hostname.toLowerCase();
  const normalizedRpId = rpId.toLowerCase();
  if (hostname !== normalizedRpId && !hostname.endsWith(`.${normalizedRpId}`)) {
    throw new TypeError("remote origin is not within the relying-party ID");
  }
}

export function prepareAssertion(message) {
  if (message?.version !== PROTOCOL_VERSION || message?.type !== "get") {
    throw new TypeError("unsupported remote-FIDO request");
  }
  if (!Number.isSafeInteger(message.requestId)) {
    throw new TypeError("invalid request ID");
  }
  if (typeof message.requestDetailsJson !== "string") {
    throw new TypeError("missing request details");
  }

  const details = JSON.parse(message.requestDetailsJson);
  const challenge = decodeBase64Url(details.challenge, "challenge");
  if (challenge.length < 16 || challenge.length > 1024) {
    throw new TypeError("challenge length is outside the accepted range");
  }
  if (typeof details.rpId !== "string" ||
      details.rpId.length < 1 || details.rpId.length > 253 ||
      details.rpId.includes("\n") || details.rpId.includes("\0")) {
    throw new TypeError("invalid relying-party ID");
  }

  const extensions = details.extensions ?? {};
  const extensionNames = Object.keys(extensions);
  if (extensionNames.some(name => name !== "remoteDesktopClientOverride")) {
    throw new TypeError("this prototype does not support the requested WebAuthn extensions");
  }
  const override = extensions.remoteDesktopClientOverride;
  if (typeof override?.origin !== "string" ||
      override.sameOriginWithAncestors !== true) {
    throw new TypeError("a same-origin remote-desktop origin is required");
  }
  assertOriginMayClaimRpId(override.origin, details.rpId);

  if (!Array.isArray(details.allowCredentials) ||
      details.allowCredentials.length < 1 || details.allowCredentials.length > 16) {
    throw new TypeError("between one and 16 allowed credentials are required");
  }
  const credentialIds = details.allowCredentials.map(descriptor => {
    if (descriptor?.type !== "public-key") {
      throw new TypeError("allowed credential is not a public key");
    }
    const credentialId = decodeBase64Url(descriptor.id, "credential ID");
    if (credentialId.length < 1 || credentialId.length > 1024) {
      throw new TypeError("credential ID length is outside the accepted range");
    }
    return credentialId;
  });

  const userVerification = details.userVerification ?? "preferred";
  if (!["required", "preferred", "discouraged"].includes(userVerification)) {
    throw new TypeError("invalid user-verification preference");
  }
  const clientData = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge: details.challenge,
    origin: override.origin,
    crossOrigin: false,
  }), "utf8");
  const requestedTimeout = Number(details.timeout);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(30_000, Math.min(300_000, Math.trunc(requestedTimeout)))
    : 180_000;
  const clientInput = JSON.stringify({
    origin: override.origin,
    options: {
      allowCredentials: details.allowCredentials,
      challenge: details.challenge,
      rpId: details.rpId,
      timeout: timeoutMs,
      userVerification,
    },
  }) + "\n";

  return {
    requestId: message.requestId,
    rpId: details.rpId,
    origin: override.origin,
    credentialIds,
    clientData,
    clientInput,
    challenge: details.challenge,
    timeoutMs,
    userVerification,
  };
}

export function clientAssertionResponseJson(prepared, output) {
  const response = JSON.parse(output);
  if (response?.type !== "public-key" ||
      response.id !== response.rawId ||
      response.authenticatorAttachment !== "cross-platform" ||
      typeof response.response !== "object" || response.response === null) {
    throw new TypeError("unexpected WebAuthn client response shape");
  }
  const credentialId = decodeBase64Url(response.rawId, "returned credential ID");
  if (!prepared.credentialIds.some(allowed =>
    allowed.length === credentialId.length &&
    crypto.timingSafeEqual(allowed, credentialId))) {
    throw new TypeError("WebAuthn client returned an unrequested credential");
  }
  const clientData = decodeBase64Url(
    response.response.clientDataJSON, "returned client data");
  const clientDataValue = JSON.parse(clientData.toString("utf8"));
  if (clientDataValue.type !== "webauthn.get" ||
      clientDataValue.challenge !== prepared.challenge ||
      clientDataValue.origin !== prepared.origin ||
      clientDataValue.crossOrigin !== false) {
    throw new TypeError("WebAuthn client returned different client data");
  }
  const authenticatorData = decodeBase64Url(
    response.response.authenticatorData, "returned authenticator data");
  const signature = decodeBase64Url(
    response.response.signature, "returned signature");
  if (Object.hasOwn(response.response, "userHandle")) {
    decodeBase64Url(response.response.userHandle, "returned user handle");
  }
  if (authenticatorData.length < 37 || signature.length < 8 ||
      typeof response.clientExtensionResults !== "object" ||
      response.clientExtensionResults === null) {
    throw new TypeError("WebAuthn client returned a truncated assertion");
  }
  return JSON.stringify(response);
}

export function discoverSingleDevice(assertBinary) {
  const result = spawnSync(assertBinary, ["--ready"], {encoding: "utf8"});
  if (result.status !== 0) {
    throw new Error("native assertion client could not open the authenticator");
  }
  const devices = result.stdout.split("\n").filter(Boolean);
  if (devices.length !== 1) {
    throw new Error(`native assertion client returned ${devices.length} readiness records`);
  }
  const separator = devices[0].indexOf(": ");
  if (separator < 1) {
    throw new Error("native assertion client returned an unrecognized readiness record");
  }
  return devices[0].slice(0, separator);
}

export function describeAuthenticatorTransition(previous, current, detail = "") {
  if (previous === undefined || previous === current) return null;
  if (current === null) {
    return `remote FIDO key unavailable${detail ? `: ${detail}` : ""}`;
  }
  if (previous === null) return `remote FIDO key available: ${current}`;
  return `remote FIDO key switched: ${previous} -> ${current}`;
}

export function parseProxyV1Header(buffer) {
  const end = buffer.indexOf("\r\n");
  if (end < 0) {
    if (buffer.length > 108) throw new TypeError("PROXY v1 header is too long");
    return null;
  }
  const line = buffer.subarray(0, end).toString("ascii");
  const match = /^PROXY TCP4 ([0-9.]+) ([0-9.]+) ([0-9]+) ([0-9]+)$/.exec(line);
  if (!match || !net.isIPv4(match[1]) || !net.isIPv4(match[2])) {
    throw new TypeError("invalid PROXY v1 header");
  }
  return {source: match[1], rest: buffer.subarray(end + 2)};
}

export function parseArguments(argv) {
  const result = {
    listen: null,
    allowClient: null,
    port: DEFAULT_PORT,
    assertBinary: process.env.REMOTE_FIDO_ASSERT_BIN ??
      process.env.FIDO2_ASSERT_BIN ??
      path.join(currentDirectory, "build", "remote-fido-assert"),
    assertClient: process.env.REMOTE_FIDO_ASSERT_CLIENT ??
      path.join(currentDirectory, "assert-client.py"),
    assertMode: process.env.REMOTE_FIDO_ASSERT_MODE ?? "swift",
    pythonBinary: process.env.REMOTE_FIDO_PYTHON ?? "python3",
    proxyProtocol: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--listen" && value) {
      result.listen = value;
    } else if (option === "--allow-client" && value) {
      result.allowClient = value;
    } else if (option === "--port" && value) {
      result.port = Number(value);
    } else if ((option === "--assert-helper" || option === "--fido2-assert") && value) {
      result.assertBinary = value;
    } else if (option === "--assert-client" && value) {
      result.assertClient = value;
    } else if (option === "--assert-mode" && ["swift", "python"].includes(value)) {
      result.assertMode = value;
    } else if (option === "--python" && value) {
      result.pythonBinary = value;
    } else if (option === "--proxy-protocol" && value === "1") {
      result.proxyProtocol = true;
    } else {
      throw new TypeError(`unknown or incomplete option: ${option}`);
    }
    index += 1;
  }
  const validListen = result.proxyProtocol
    ? result.listen === "127.0.0.1"
    : isTailscaleIPv4(result.listen);
  if (!validListen || !isTailscaleIPv4(result.allowClient) ||
      !Number.isInteger(result.port) || result.port < 1 || result.port > 65535 ||
      !["swift", "python"].includes(result.assertMode)) {
    throw new TypeError("listen and allow-client must be Tailscale IPv4 addresses and port must be valid");
  }
  return result;
}

function send(socket, value) {
  if (socket.destroyed || !socket.writable || socket.writableEnded) return false;
  try {
    socket.end(encodeFrame(value));
    return true;
  } catch (error) {
    console.error(`cannot send exporter response: ${error.message}`);
    socket.destroy();
    return false;
  }
}

export function terminateChild(child, graceMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return () => {};
  child.kill("SIGTERM");
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, graceMs);
  escalation.unref?.();
  return () => clearTimeout(escalation);
}

function runAssertion(socket, message, options, onDone) {
  let prepared;
  try {
    prepared = prepareAssertion(message);
  } catch (error) {
    console.error(`request ${String(message?.requestId)} rejected: ${error.message}`);
    send(socket, {
      version: PROTOCOL_VERSION,
      type: "response",
      requestId: message?.requestId,
      error: {name: "NotSupportedError", message: error.message},
    });
    onDone();
    return;
  }

  let device;
  try {
    device = discoverSingleDevice(options.assertBinary);
  } catch (error) {
    console.error(`request ${prepared.requestId}: ${error.message}`);
    send(socket, {
      version: PROTOCOL_VERSION,
      type: "response",
      requestId: prepared.requestId,
      error: GENERIC_FAILURE,
    });
    onDone();
    return;
  }

  console.error(
    `request ${prepared.requestId}: ${prepared.origin} -> ${prepared.rpId}; ` +
    `credentials=${prepared.credentialIds.length} uv=${prepared.userVerification} ` +
    `timeout=${prepared.timeoutMs}ms`);
  const helperArgs = ["--timeout-ms", String(prepared.timeoutMs),
    "--uv", prepared.userVerification];
  const command = options.assertMode === "python"
    ? options.pythonBinary : options.assertBinary;
  const args = options.assertMode === "python"
    ? [options.assertClient, ...helperArgs, device]
    : [...helperArgs, "--device", device];
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let stdout = Buffer.alloc(0);
  let finalized = false;
  let cancelled = false;
  let cancelEscalation = () => {};
  const finalize = response => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timer);
    cancelEscalation();
    socket.off("close", cancel);
    if (response && !cancelled) send(socket, response);
    onDone();
  };
  const cancel = () => {
    if (finalized || cancelled) return;
    cancelled = true;
    clearTimeout(timer);
    console.error(`request ${prepared.requestId}: transport canceled`);
    cancelEscalation = terminateChild(child);
  };
  const timer = setTimeout(() => {
    if (finalized) return;
    console.error(`request ${prepared.requestId}: local assertion timed out`);
    cancelEscalation = terminateChild(child);
  }, prepared.timeoutMs + 5_000);
  socket.once("close", cancel);
  child.stdout.on("data", chunk => {
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.length > 1024 * 1024) {
      console.error(`request ${prepared.requestId}: assertion output exceeded limit`);
      cancelEscalation = terminateChild(child);
    }
  });
  child.stdin.on("error", error => {
    if (!cancelled) {
      console.error(`request ${prepared.requestId}: assertion input failed: ${error.message}`);
    }
  });
  child.once("error", error => {
    console.error(`request ${prepared.requestId}: cannot run assertion helper: ${error.message}`);
    finalize({
      version: PROTOCOL_VERSION,
      type: "response",
      requestId: prepared.requestId,
      error: GENERIC_FAILURE,
    });
  });
  child.once("exit", code => {
    if (finalized) return;
    if (cancelled) {
      finalize(null);
      return;
    }
    if (code !== 0) {
      console.error(`request ${prepared.requestId}: assertion helper exited ${code}`);
      finalize({
        version: PROTOCOL_VERSION,
        type: "response",
        requestId: prepared.requestId,
        error: GENERIC_FAILURE,
      });
      return;
    }
    try {
      const responseJson = clientAssertionResponseJson(
        prepared, stdout.toString("utf8"));
      console.error(`request ${prepared.requestId}: assertion completed`);
      finalize({
        version: PROTOCOL_VERSION,
        type: "response",
        requestId: prepared.requestId,
        responseJson,
      });
    } catch (error) {
      console.error(`request ${prepared.requestId}: invalid assertion output: ${error.message}`);
      finalize({
        version: PROTOCOL_VERSION,
        type: "response",
        requestId: prepared.requestId,
        error: GENERIC_FAILURE,
      });
    }
  });
  child.stdin.end(prepared.clientInput);
}

export function runExporter(options) {
  let busy = false;
  let healthDevice;
  const recordHealthDevice = (current, detail = "") => {
    const transition = describeAuthenticatorTransition(
      healthDevice, current, detail);
    healthDevice = current;
    if (transition) console.error(transition);
  };
  const server = net.createServer(socket => {
    socket.on("error", error => {
      console.error(`client socket error: ${error.message}`);
    });
    socket.setTimeout(15_000, () => {
      if (!socket.destroyed) {
        console.error("client socket timed out before a request completed");
        socket.destroy();
      }
    });
    if (!options.proxyProtocol && socket.remoteAddress !== options.allowClient) {
      console.error(`rejected peer ${socket.remoteAddress ?? "<unknown>"}`);
      socket.destroy();
      return;
    }
    if (options.proxyProtocol && socket.remoteAddress !== "127.0.0.1") {
      console.error(`rejected non-loopback proxy peer ${socket.remoteAddress ?? "<unknown>"}`);
      socket.destroy();
      return;
    }
    const decoder = new FrameDecoder();
    let handled = false;
    let peerValidated = !options.proxyProtocol;
    let peerAddress = socket.remoteAddress ?? "<unknown>";
    let proxyBuffer = Buffer.alloc(0);
    socket.on("data", incoming => {
      let chunk = incoming;
      if (!peerValidated) {
        proxyBuffer = Buffer.concat([proxyBuffer, incoming]);
        let parsed;
        try {
          parsed = parseProxyV1Header(proxyBuffer);
        } catch (error) {
          console.error(error.message);
          socket.destroy();
          return;
        }
        if (!parsed) return;
        if (parsed.source !== options.allowClient) {
          console.error(`rejected PROXY peer ${parsed.source}`);
          socket.destroy();
          return;
        }
        peerAddress = parsed.source;
        peerValidated = true;
        proxyBuffer = Buffer.alloc(0);
        chunk = parsed.rest;
        if (chunk.length === 0) return;
      }
      if (handled) {
        socket.destroy();
        return;
      }
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      if (messages.length !== 1) return;
      handled = true;
      socket.setTimeout(0);
      const message = messages[0];
      if (message?.version === PROTOCOL_VERSION && message?.type === "hello") {
        try {
          const device = discoverSingleDevice(options.assertBinary);
          recordHealthDevice(device);
          send(socket, {version: PROTOCOL_VERSION, type: "hello", ready: true});
        } catch (error) {
          recordHealthDevice(null, error.message);
          send(socket, {version: PROTOCOL_VERSION, type: "hello", ready: false});
        }
        return;
      }
      console.error(
        `connection from ${peerAddress}; message type=${String(message?.type)}`);
      if (busy) {
        send(socket, {
          version: PROTOCOL_VERSION,
          type: "response",
          requestId: message?.requestId,
          error: {name: "InvalidStateError", message: "Another security-key request is active"},
        });
        return;
      }
      busy = true;
      runAssertion(socket, message, options, () => { busy = false; });
    });
  });
  server.listen(options.port, options.listen, () => {
    console.error(`remote FIDO exporter listening on ${options.listen}:${options.port}`);
    console.error("PIN entry and touch remain local to this Mac");
  });
  server.on("error", error => {
    if (error.code === "EADDRINUSE") {
      console.error(`remote FIDO exporter is already running on ${options.listen}:${options.port}`);
    } else {
      console.error(`remote FIDO exporter listener failed: ${error.message}`);
    }
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const server = runExporter(parseArguments(process.argv.slice(2)));
    server.once("error", () => { process.exitCode = 1; });
  } catch (error) {
    console.error(`usage: exporter.mjs --listen ADDRESS --allow-client TAILSCALE_IP [--port ${DEFAULT_PORT}] [--proxy-protocol 1] [--assert-mode swift|python] [--assert-helper PATH] [--assert-client PATH] [--python PATH]`);
    console.error(error.message);
    process.exit(64);
  }
}
