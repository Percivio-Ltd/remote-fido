import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {runExporter, terminateChild} from "./exporter.mjs";
import {encodeFrame, FrameDecoder, PROTOCOL_VERSION} from "./protocol.mjs";

const request = {
  version: PROTOCOL_VERSION,
  type: "get",
  requestId: 401,
  requestDetailsJson: JSON.stringify({
    allowCredentials: [{id: "FBUW", type: "public-key"}],
    challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    extensions: {
      remoteDesktopClientOverride: {
        origin: "https://auth.openai.com",
        sameOriginWithAncestors: true,
      },
    },
    rpId: "openai.com",
    timeout: 30_000,
    userVerification: "required",
  }),
};

function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = async () => {
      if (await check()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error("condition timed out"));
      } else {
        setTimeout(inspect, 10);
      }
    };
    inspect();
  });
}

function exporterOptions(overrides = {}) {
  return {
    listen: "127.0.0.1",
    allowClient: "127.0.0.1",
    port: 0,
    assertBinary: "/unused",
    assertClient: "/unused",
    assertMode: "python",
    pythonBinary: process.execPath,
    proxyProtocol: false,
    ...overrides,
  };
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

test("child termination escalates when graceful cancellation is ignored", async () => {
  const signals = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal) { signals.push(signal); },
  };
  terminateChild(child, 10);
  assert.deepEqual(signals, ["SIGTERM"]);
  await waitFor(() => signals.includes("SIGKILL"));
});

test("a duplicate exporter reports EADDRINUSE without an uncaught process error", async () => {
  const first = runExporter(exporterOptions());
  await new Promise(resolve => first.once("listening", resolve));
  const port = first.address().port;
  const second = runExporter(exporterOptions({port}));
  const error = await new Promise(resolve => second.once("error", resolve));
  assert.equal(error.code, "EADDRINUSE");
  await closeServer(first);
});

test("transport cancellation releases the busy state for the next request", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "remote-fido-test-"));
  const ready = path.join(temporary, "remote-fido-assert");
  const client = path.join(temporary, "assert-client.mjs");
  const started = path.join(temporary, "started");
  const exited = path.join(temporary, "exited");
  await fs.writeFile(ready, "#!/bin/sh\nprintf 'ioreg://fake: test authenticator\\n'\n");
  await fs.chmod(ready, 0o755);
  await fs.writeFile(client, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(started)}, '');`,
    `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(exited)}, ''); process.exit(2); });`,
    "process.stdin.resume();",
    "setInterval(() => {}, 1000);",
  ].join("\n"));

  const server = runExporter(exporterOptions({
    assertBinary: ready,
    assertClient: client,
  }));
  await new Promise(resolve => server.once("listening", resolve));
  const port = server.address().port;
  const first = net.createConnection({host: "127.0.0.1", port});
  await new Promise(resolve => first.once("connect", resolve));
  first.write(encodeFrame(request));
  await waitFor(async () => fs.access(started).then(() => true, () => false));
  first.destroy();
  await waitFor(async () => fs.access(exited).then(() => true, () => false));

  await fs.writeFile(client, [
    "process.stdin.resume();",
    "process.stdin.once('end', () => console.log('{}'));",
  ].join("\n"));
  const second = net.createConnection({host: "127.0.0.1", port});
  const decoder = new FrameDecoder();
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("second response timed out")), 3000);
    second.on("data", chunk => {
      const values = decoder.push(chunk);
      if (values.length === 1) {
        clearTimeout(timeout);
        resolve(values[0]);
      }
    });
    second.once("error", reject);
  });
  await new Promise(resolve => second.once("connect", resolve));
  second.write(encodeFrame({...request, requestId: 402}));
  const value = await response;
  assert.equal(value.requestId, 402);
  assert.equal(value.error.name, "NotAllowedError");
  assert.notEqual(value.error.name, "InvalidStateError");

  second.destroy();
  await closeServer(server);
  await fs.rm(temporary, {recursive: true, force: true});
});
