# Remote FIDO custom proxy prototype

This prototype avoids both general USB passthrough and macOS virtual HID. A
small Chrome extension in the Tart VM attaches through Chrome's public
`webAuthenticationProxy` API. Its native host sends only one WebAuthn assertion
request over Tailscale. On the physical Mac, `fido2-assert` asks the attached
YubiKey to sign the exact client-data hash. The PIN prompt and touch remain on
that physical Mac; the PIN is never stored or sent over the network.

```text
VM Chrome -> extension -> native host === Tailscale ===> exporter
                                                       -> libfido2 tool
                                                       -> local YubiKey
```

The implementation uses no VirtualHere source or protocol. The architecture is
derived from Chromium's documented proxy API and libfido2's public CLI.

## What is implemented

- assertion (`navigator.credentials.get`) forwarding;
- a fixed extension ID and exact native-messaging allowlist;
- Tailscale-only listener and exact client source-IP check;
- one active request and one locally attached FIDO authenticator;
- same-origin HTTPS RP/origin validation before the key is touched;
- local PIN/touch via a visible Terminal session; and
- fail-closed detach when the exporter is not reachable.

The v0.1 prototype intentionally rejects registration, cross-origin iframes,
discoverable requests without an allow-credential ID, multiple credential IDs,
and WebAuthn extensions other than `remoteDesktopClientOverride`. Those are
honest missing surfaces, not silently downgraded operations.

## Test without touching a key

```sh
node --test test.mjs
```

## Run on the Mac holding the YubiKey

Install Homebrew `libfido2`, insert exactly one YubiKey, and start the exporter
from a visible Terminal so `fido2-assert` can obtain a PIN from `/dev/tty`:

```sh
tailscale serve --bg --yes --tcp=9471 --proxy-protocol=1 tcp://127.0.0.1:9471
node exporter.mjs \
  --listen 127.0.0.1 \
  --proxy-protocol 1 \
  --allow-client 100.81.150.46
```

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
variant is not implemented or claimed working in v0.1.
