import assert from "node:assert/strict";
import test from "node:test";
import {assertionResponseJson, parseProxyV1Header, prepareAssertion} from "./exporter.mjs";
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeFrame,
  isTailscaleIPv4,
} from "./protocol.mjs";

const request = {
  version: PROTOCOL_VERSION,
  type: "get",
  requestId: 17,
  requestDetailsJson: JSON.stringify({
    allowCredentials: [{id: "FBUW", transports: ["usb"], type: "public-key"}],
    challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    extensions: {
      remoteDesktopClientOverride: {
        origin: "https://auth.openai.com",
        sameOriginWithAncestors: true,
      },
    },
    rpId: "openai.com",
    timeout: 30000,
    userVerification: "required",
  }),
};

test("Tailscale IPv4 validation is exact", () => {
  assert.equal(isTailscaleIPv4("100.64.0.1"), true);
  assert.equal(isTailscaleIPv4("100.127.255.254"), true);
  assert.equal(isTailscaleIPv4("100.128.0.1"), false);
  assert.equal(isTailscaleIPv4("192.168.1.2"), false);
});

test("framing handles fragmentation and both byte orders", () => {
  for (const byteOrder of ["BE", "LE"]) {
    const frame = encodeFrame({ok: true}, byteOrder);
    const decoder = new FrameDecoder(byteOrder);
    assert.deepEqual(decoder.push(frame.subarray(0, 3)), []);
    assert.deepEqual(decoder.push(frame.subarray(3)), [{ok: true}]);
  }
});

test("PROXY v1 preserves the exact tailnet source", () => {
  const framed = encodeFrame({type: "hello"});
  const parsed = parseProxyV1Header(Buffer.concat([
    Buffer.from("PROXY TCP4 100.81.150.46 100.79.219.6 51300 9471\r\n"),
    framed,
  ]));
  assert.equal(parsed.source, "100.81.150.46");
  assert.deepEqual(parsed.rest, framed);
  assert.equal(parseProxyV1Header(Buffer.from("PROXY TCP4 100.81")), null);
  assert.throws(
    () => parseProxyV1Header(Buffer.from("PROXY UNKNOWN\r\n")),
    /invalid/);
});

test("remote WebAuthn request becomes an exact local FIDO assertion input", () => {
  const prepared = prepareAssertion(request);
  assert.equal(prepared.requestId, 17);
  assert.equal(prepared.origin, "https://auth.openai.com");
  assert.equal(prepared.rpId, "openai.com");
  assert.equal(prepared.requireUserVerification, true);
  const clientData = JSON.parse(prepared.clientData.toString("utf8"));
  assert.deepEqual(clientData, {
    type: "webauthn.get",
    challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    origin: "https://auth.openai.com",
    crossOrigin: false,
  });
  assert.equal(prepared.input.split("\n").length, 4);
});

test("response JSON preserves the original credential and client data", () => {
  const prepared = prepareAssertion(request);
  const output = [
    prepared.clientDataHash.toString("base64"),
    prepared.rpId,
    Buffer.alloc(37, 1).toString("base64"),
    Buffer.alloc(64, 2).toString("base64"),
    "",
  ].join("\n");
  const response = JSON.parse(assertionResponseJson(prepared, output));
  assert.equal(response.id, "FBUW");
  assert.equal(response.rawId, "FBUW");
  assert.equal(response.authenticatorAttachment, "cross-platform");
  assert.deepEqual(
    JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")),
    JSON.parse(prepared.clientData.toString("utf8")));
});

test("unsafe or unsupported requests fail before touching a key", () => {
  const wrongOrigin = structuredClone(request);
  wrongOrigin.requestDetailsJson = JSON.stringify({
    ...JSON.parse(request.requestDetailsJson),
    extensions: {
      remoteDesktopClientOverride: {
        origin: "https://example.net",
        sameOriginWithAncestors: true,
      },
    },
  });
  assert.throws(() => prepareAssertion(wrongOrigin), /not within/);

  const crossOrigin = structuredClone(request);
  const crossDetails = JSON.parse(request.requestDetailsJson);
  crossDetails.extensions.remoteDesktopClientOverride.sameOriginWithAncestors = false;
  crossOrigin.requestDetailsJson = JSON.stringify(crossDetails);
  assert.throws(() => prepareAssertion(crossOrigin), /same-origin/);

  const multiple = structuredClone(request);
  const multipleDetails = JSON.parse(request.requestDetailsJson);
  multipleDetails.allowCredentials.push(multipleDetails.allowCredentials[0]);
  multiple.requestDetailsJson = JSON.stringify(multipleDetails);
  assert.throws(() => prepareAssertion(multiple), /exactly one/);
});
