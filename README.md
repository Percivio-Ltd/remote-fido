# Remote FIDO

The canonical source and installation instructions are published at
<https://github.com/Percivio-Ltd/remote-fido>. Clone that repository on the Mac
holding the YubiKey and on each Tart VM before running the installers below:

```sh
git clone https://github.com/Percivio-Ltd/remote-fido.git
cd remote-fido
```

This prototype avoids both general USB passthrough and macOS virtual HID. A
small Chrome extension in the Tart VM attaches through Chrome's public
`webAuthenticationProxy` API. Its native host sends only one WebAuthn assertion
request over Tailscale. On the physical Mac, the native Swift
`remote-fido-assert` process uses Yubico's Apache-2.0 YubiKit for browser-style
credential selection, PIN, and touch against the attached YubiKey. The PIN
prompt and touch remain on that physical Mac; the PIN is process-scoped and is
never stored or sent over the network.

```text
VM Chrome -> extension -> native host === Tailscale ===> exporter
                                                       -> Swift/YubiKit client
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
- one short-lived native process per assertion, so the HID interface is never
  seized while the exporter is idle;
- explicit CTAP cancellation, connection close, and process-exit backstops for
  Chrome cancellation and local deadlines;
- up to three local PIN prompts after a wrong PIN, but only while the key
  reports more than one retry remaining;
- raw WebAuthn authenticator data rather than libfido2 CLI's CBOR wrapper;
- fail-closed detach when the exporter is not reachable;
- automatic reattachment after the exporter or network returns, without a
  Chrome restart; and
- a visible toolbar badge: `ON`, `KEY`, `OK`, `OFF`, or `ERR`.

The v0.4.0 release intentionally rejects registration, cross-origin iframes,
discoverable requests without an allow-credential ID, more than 16 credential
IDs, and WebAuthn extensions other than `remoteDesktopClientOverride`. Those
are honest missing surfaces, not silently downgraded operations.

## Test without touching a key

```sh
node --test test.mjs extension/service-worker.test.mjs exporter-lifecycle.test.mjs
swift test --package-path mac-client
./build-assert-swift.sh
./build/remote-fido-assert --ready
```

`--ready` requires exactly one FIDO HID device, opens it, performs a real CTAP2
`getInfo`, closes it, and prints its stable IOKit identity. It requires no PIN
or touch and changes nothing on the key. The real RP assertion remains the
acceptance test.

## Run on the Mac holding the YubiKey

Install Node.js and Tailscale, insert exactly one YubiKey, then preview and
apply the exporter installation. Python, pip, a venv, and Homebrew libfido2 are
not installed or used. Every installation creates the lowercase
`~/bin/remote-fido` command; `--desktop` also creates a double-clickable
launcher:

```sh
./install-exporter.sh --allow-client 100.81.150.46 --desktop
./install-exporter.sh --allow-client 100.81.150.46 --desktop --apply
```

The installer warns and stops without changing files when a newer version is
already installed. Run `~/bin/remote-fido`, or launch **Remote FIDO Exporter**
from the Desktop. Its visible Terminal owns the PIN and touch prompts.
Control-C stops the exporter; the Chrome extension then detaches fail-closed.
The Tailscale Serve rule may remain configured, but its loopback target is
closed while the exporter is stopped.

For a UV-required request the client asks for the PIN, then visibly and audibly
announces the touch window only after the authenticator returns its
user-presence keepalive. Repeated taps do not cancel the request; the first
accepted presence completes it. A wrong PIN may be entered again only when the
YubiKey reports more than one remaining retry. The ceremony permits at most
three PIN entries and stops immediately when retrying could block the key.
The authenticator's approximately 29-second presence timeout is one attempt:
v0.4.0 does not silently restart a timed-out assertion inside Chrome's longer
outer deadline.

Idle health checks are silent. The exporter Terminal reports an assertion
request and any authenticator availability or identity switch, without logging
the five-second hello probes.

The installer verifies `build/remote-fido-assert` against `SHA256SUMS` before
copying it. The checked-in universal binary is ad-hoc signed for the internal
`git clone` installation path. A downloadable quarantined release archive will
need Developer ID signing and notarization before it becomes supported.

### Break-glass Python rollback

`assert-client.py` and its pinned `requirements.txt` remain in the source tree
for the v0.4 observation window, but the installer does not copy or provision
them. A manual diagnostic can create a temporary venv and launch `exporter.mjs`
with `--assert-mode python`, an explicit `--python`, and `--assert-client`.
This fallback still needs the native Swift binary for exact device readiness.
It is not the installed steady-state runtime and is scheduled for removal in
v0.5.

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
extension detaches when its native connection or exporter disappears and
automatically reattaches when both return. Click its toolbar icon for an
immediate health check; the background health check otherwise detects recovery
within about five seconds. The source and exact permissions should be reviewed
before the one-time **Load unpacked** action.

## iPhone direction

The wire message is deliberately WebAuthn-level rather than USB-level. A
foreground iPhone/iPad app can reuse `RemoteFidoCore`, validate the same
origin/RP tuple, and execute the assertion through YubiKit using NFC or wired
CCID where the device/key combination supports it. The core target already
declares iOS 16 support, but no signed app, mobile rendezvous, or physical
mobile ceremony is implemented or claimed working in v0.4.0.

## Live acceptance result

On 2026-08-25, Agent-01 Chrome Profile 1 intercepted the real
`https://auth.openai.com` assertion for RP `openai.com` while signing in through
Google as `artus@lytiq.de`. It forwarded Chrome's four allowed credential IDs
over Tailscale to Tidepool. The Python client accepted the local YubiKey PIN,
emitted its touch prompt from the authenticator keepalive, consumed one touch
on Yubi1, returned the selected assertion to Chrome, and Agent-01 reached the
signed-in ChatGPT home page.

The same day, the packaged v0.3.1 exporter on Tintagel repeated the complete
flow with Yubi2. Its exact-peer filter accepted only Agent-01 at
`100.120.158.10`; the exporter logged `assertion completed`, and Agent-01 again
reached the signed-in ChatGPT Pro home for the same LYTiQ account. The exporter
was then stopped and its loopback listener verified closed. Both results are
live end-to-end acceptance tests, not synthetic WebAuthn probes.

The v0.3.2 stability release was then installed byte-for-byte on Tintagel and
Agent-01. A cold start attached automatically, stopping the exporter detached
the proxy within one health interval, and restarting it reattached without a
Chrome reload or toolbar click. A fresh Google login for `artus@lytiq.de`
completed a real OpenAI assertion with local PIN and one Yubi2 touch. Afterward
the exporter was stopped again; TCP 9471 was closed and Agent-01 visibly
returned to `OFF`. The older v0.3.1 installer also warned and stopped against
the installed v0.3.2 target without changing it.
