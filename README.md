# Remote FIDO custom proxy prototype

This prototype avoids both general USB passthrough and macOS virtual HID. A
small Chrome extension in the Tart VM attaches through Chrome's public
`webAuthenticationProxy` API. Its native host sends only one WebAuthn assertion
request over Tailscale. On the physical Mac, Yubico's Apache-2.0 Python
`Fido2Client` performs the browser-style credential selection, PIN, and touch
flow against the attached YubiKey. The PIN prompt and touch remain on that
physical Mac; the PIN is never stored or sent over the network.

```text
VM Chrome -> extension -> native host === Tailscale ===> exporter
                                                       -> Python FIDO2 client
                                                       -> local YubiKey
```

The implementation uses no VirtualHere source or protocol. The architecture is
derived from Chromium's documented proxy API and Yubico's public FIDO2 API.

## What is implemented

- assertion (`navigator.credentials.get`) forwarding;
- a fixed extension ID and exact native-messaging allowlist;
- Tailscale-only listener and exact client source-IP check;
- one active request and one locally attached FIDO authenticator;
- one to 16 allowed credential IDs, with the credential actually selected by
  the authenticator returned to Chrome;
- same-origin HTTPS RP/origin validation before the key is touched;
- local PIN/touch via a visible Terminal session;
- signed and non-negative Chrome request IDs (Chrome emits both);
- the browser's original ceremony deadline, up to five minutes, with the touch
  prompt emitted only when the authenticator actually requests presence;
- up to three local PIN prompts after a wrong PIN, but only while the key
  reports more than one retry remaining;
- raw WebAuthn authenticator data rather than libfido2 CLI's CBOR wrapper; and
- fail-closed detach when the exporter is not reachable.

The v0.3.0 prototype intentionally rejects registration, cross-origin iframes,
discoverable requests without an allow-credential ID, more than 16 credential
IDs, and WebAuthn extensions other than `remoteDesktopClientOverride`. Those
are honest missing surfaces, not silently downgraded operations.

## Test without touching a key

```sh
node --test test.mjs
./build-assert-helper.sh
./build/remote-fido-assert --touch-test-u2f "$(fido2-token -L | sed 's/: .*//')"
```

The touch test uses no account credential and changes nothing on the key. It
is diagnostic only: YubiKey firmware 5.7.4 returns
`CTAP2_ERR_OPERATION_DENIED` from libfido2's dummy CTAP2 `makeCredential`
probe, and that ambiguous result is deliberately a failed diagnostic. The
forced-U2F probe also did not independently report presence in the first live
trial. Do not treat either result as a successful assertion. The real RP
assertion remains the acceptance test.

## Run on the Mac holding the YubiKey

Install Homebrew `libfido2`, create the pinned Python environment, insert
exactly one YubiKey, and start the exporter from a visible Terminal so the
client can obtain a PIN from `/dev/tty`:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
tailscale serve --bg --yes --tcp=9471 --proxy-protocol=1 tcp://127.0.0.1:9471
REMOTE_FIDO_ASSERT_MODE=python REMOTE_FIDO_PYTHON="$PWD/.venv/bin/python" \
  node exporter.mjs \
  --listen 127.0.0.1 \
  --proxy-protocol 1 \
  --allow-client 100.81.150.46
```

For one bounded diagnostic run, set `REMOTE_FIDO_DEBUG=1` before starting the
exporter. The Python client then enables protocol diagnostics on stderr. Do
not retain that verbose output beyond diagnosis. Normal human-operated runs
omit the flag.

For a UV-required request the client asks for the PIN, then visibly and audibly
announces the touch window only after the authenticator returns its
user-presence keepalive. Repeated taps do not cancel the request; the first
accepted presence completes it. A wrong PIN may be entered again only when the
YubiKey reports more than one remaining retry. The ceremony permits at most
three PIN entries and stops immediately when retrying could block the key.

Replace the VM address with its Tailscale IPv4 address. Tailscale Serve accepts
the tailnet connection and passes its original source in a PROXY v1 header;
the exporter accepts the loopback proxy only when that source matches the VM.
Do not expose TCP 9471 outside the tailnet. A production tailnet ACL should
also limit that port to the exact VM/exporter pair.

## Stage the VM side

Preview, then install the native host for the current VM user:

```sh
./install-vm-host.sh --connect 100.64.52.3
./install-vm-host.sh --connect 100.64.52.3 --apply
```

The installer warns and stops if the target already has a newer prototype or
if the native-messaging name belongs to another integration. It prints the
unpacked-extension directory but deliberately stops before Chrome approval.

With the exporter running, verify the inert native-host path before loading the
extension:

```sh
node "$HOME/Library/Application Support/LYTiQ/Remote FIDO/probe-native-host.mjs"
```

The expected response is `{"version":1,"type":"hello","ready":true}`.

Loading this extension from `chrome://extensions` is security-sensitive: while
the exporter is connected it becomes Chrome's WebAuthn request proxy. The
extension detaches when its native connection ends, but the source and exact
permissions should be reviewed before the one-time **Load unpacked** action.

## iPhone direction

The wire message is deliberately WebAuthn-level rather than USB-level. A
foreground iPhone app can replace `exporter.mjs`, validate the same origin/RP
tuple, and execute the assertion through Yubico's Apache-2.0 YubiKit using NFC
where supported. User presence remains required for every ceremony. That
variant is not implemented or claimed working in v0.3.0.

## Live acceptance result

On 2026-08-25, Agent-01 Chrome Profile 1 intercepted the real
`https://auth.openai.com` assertion for RP `openai.com` while signing in through
Google as `artus@lytiq.de`. It forwarded Chrome's four allowed credential IDs
over Tailscale to Tidepool. The Python client accepted the local YubiKey PIN,
emitted its touch prompt from the authenticator keepalive, consumed one touch
on Yubi1, returned the selected assertion to Chrome, and Agent-01 reached the
signed-in ChatGPT home page. This is a live end-to-end acceptance result, not a
synthetic WebAuthn probe.
