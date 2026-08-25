import assert from "node:assert/strict";
import test from "node:test";
import {
  clientAssertionResponseJson,
  describeAuthenticatorTransition,
  parseArguments,
  parseProxyV1Header,
  prepareAssertion,
} from "./exporter.mjs";
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeFrame,
  isTailscaleIPv4,
} from "./protocol.mjs";

test("idle health pings stay silent while authenticator switches remain visible", () => {
  assert.equal(
    describeAuthenticatorTransition(undefined, "ioreg://key-a"), null);
  assert.equal(
    describeAuthenticatorTransition("ioreg://key-a", "ioreg://key-a"), null);
  assert.equal(
    describeAuthenticatorTransition("ioreg://key-a", null, "key missing"),
    "remote FIDO key unavailable: key missing");
  assert.equal(
    describeAuthenticatorTransition(null, null, "still missing"), null);
  assert.equal(
    describeAuthenticatorTransition(null, "ioreg://key-b"),
    "remote FIDO key available: ioreg://key-b");
  assert.equal(
    describeAuthenticatorTransition("ioreg://key-b", "ioreg://key-c"),
    "remote FIDO key switched: ioreg://key-b -> ioreg://key-c");
});

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
    timeout: 180000,
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

test("native Swift assertions are the default and Python is break-glass", () => {
  const base = ["--listen", "127.0.0.1", "--allow-client", "100.120.158.10",
    "--proxy-protocol", "1"];
  assert.equal(parseArguments(base).assertMode, "swift");
  const python = parseArguments([
    ...base, "--assert-mode", "python", "--python", "/tmp/python",
  ]);
  assert.equal(python.assertMode, "python");
  assert.equal(python.pythonBinary, "/tmp/python");
  assert.throws(() => parseArguments([...base, "--assert-mode", "c"]), /unknown/);
});

test("remote WebAuthn request becomes an exact local FIDO assertion input", () => {
  const prepared = prepareAssertion(request);
  assert.equal(prepared.requestId, 17);
  assert.equal(prepared.origin, "https://auth.openai.com");
  assert.equal(prepared.rpId, "openai.com");
  assert.equal(prepared.userVerification, "required");
  assert.equal(prepared.timeoutMs, 180000);
  const clientData = JSON.parse(prepared.clientData.toString("utf8"));
  assert.deepEqual(clientData, {
    type: "webauthn.get",
    challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    origin: "https://auth.openai.com",
    crossOrigin: false,
  });
  assert.equal(prepared.credentialIds.length, 1);
});

test("signed Chrome request IDs are preserved", () => {
  const prepared = prepareAssertion({...request, requestId: -858482908});
  assert.equal(prepared.requestId, -858482908);
});

test("high-level client response is bound to the original request", () => {
  const prepared = prepareAssertion(request);
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge: prepared.challenge,
    origin: prepared.origin,
    crossOrigin: false,
  })).toString("base64url");
  const output = JSON.stringify({
    id: "FBUW",
    rawId: "FBUW",
    response: {
      clientDataJSON,
      authenticatorData: Buffer.alloc(37, 5).toString("base64url"),
      signature: Buffer.alloc(64, 6).toString("base64url"),
    },
    authenticatorAttachment: "cross-platform",
    clientExtensionResults: {},
    type: "public-key",
  });
  const response = JSON.parse(clientAssertionResponseJson(prepared, output));
  assert.equal(response.rawId, "FBUW");

  const changed = JSON.parse(output);
  changed.response.clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge: prepared.challenge,
    origin: "https://attacker.example",
    crossOrigin: false,
  })).toString("base64url");
  assert.throws(
    () => clientAssertionResponseJson(prepared, JSON.stringify(changed)),
    /different client data/);

  const nullUserHandle = JSON.parse(output);
  nullUserHandle.response.userHandle = null;
  assert.throws(
    () => clientAssertionResponseJson(prepared, JSON.stringify(nullUserHandle)),
    /user handle/);
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

  const tooMany = structuredClone(request);
  const tooManyDetails = JSON.parse(request.requestDetailsJson);
  tooManyDetails.allowCredentials = Array.from({length: 17}, (_, index) => ({
    id: Buffer.from([index + 1]).toString("base64url"),
    type: "public-key",
  }));
  tooMany.requestDetailsJson = JSON.stringify(tooManyDetails);
  assert.throws(() => prepareAssertion(tooMany), /one and 16/);
});

test("multiple registered passkeys are forwarded and the used credential is returned", () => {
  const multiple = structuredClone(request);
  const details = JSON.parse(request.requestDetailsJson);
  details.allowCredentials.push({id: "AQIDBA", type: "public-key"});
  multiple.requestDetailsJson = JSON.stringify(details);
  const prepared = prepareAssertion(multiple);
  assert.equal(prepared.credentialIds.length, 2);
});
