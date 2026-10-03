# Remote FIDO

Remote FIDO forwards selected WebAuthn assertion requests between explicitly enrolled devices over Tailscale. It transports requests and assertions, not PINs, fingerprints, account cookies, or authenticator private keys.

The public repository contains source, tests, installers, and generic configuration examples. Deployment accounts, machine names, addresses, signing identities, private configuration, and operational acceptance records belong outside this repository.

## Selected passkey approvers (0.5 prototype)

The separately installed `v2/` path supports explicit approver selection, target-browser requests, and local passkey approval on an enrolled approver. See the [architecture](docs/ARCHITECTURE-0.5.md), [setup and acceptance guide](docs/SETUP-0.5.md), and [iPhone/iPad approver](docs/IOS-APPROVER.md).

The standard policy includes exact Google, Apple, and OpenAI sign-in origins. Actual Apple login remains incomplete because its extra `largeBlob`/`prf` WebAuthn extensions are rejected. Transport tests do not establish successful OpenAI login or physical-device acceptance. iOS signing, installation, and Safari hardware validation remain separate requirements.

The source uses the example suffix `example.ts.net`. Before deployment, configure exact service hosts and the same exact tailnet suffix in a private deployment copy as described in the setup guide. The public examples are not a live deployment. Do not replace exact permissions or validation with wildcard hosts or a blanket `.ts.net` check.

## Existing YubiKey path (0.4)

The canonical source is [Percivio-Ltd/remote-fido](https://github.com/Percivio-Ltd/remote-fido). Clone it on the Mac holding the YubiKey and on each target VM:

```sh
git clone https://github.com/Percivio-Ltd/remote-fido.git
cd remote-fido
```

This prototype avoids general USB passthrough and macOS virtual HID. A Chrome extension in the VM attaches through Chrome's public `webAuthenticationProxy` API. Its native host sends one WebAuthn assertion request over Tailscale. The physical Mac runs a Swift client using Yubico's Apache-2.0 YubiKit for local credential selection, PIN, and touch. The PIN is process-scoped and is never stored or sent over the network.

```text
VM Chrome -> extension -> native host === Tailscale ===> exporter
                                                       -> Swift/YubiKit client
                                                       -> local YubiKey
```

No VirtualHere source or protocol is used. The architecture is based on Chromium's public proxy API and Yubico's public FIDO2 API.

### Implemented boundaries

- Assertion (`navigator.credentials.get`) forwarding with a fixed extension ID and exact native-messaging allowlist.
- Tailscale-only access with an exact client source-IP check.
- One active request and one locally attached FIDO authenticator, with one to 16 allowed credential IDs.
- Same-origin HTTPS RP/origin validation before touching the key.
- Local PIN/touch in a visible Terminal, with at most three PIN prompts and a stop before exhausting safe retries.
- Original browser deadlines, CTAP cancellation, connection close, and process-exit backstops.
- Short-lived authenticator access, fail-closed detach, and automatic reattachment after connectivity returns.
- Toolbar status: `ON`, `KEY`, `OK`, `OFF`, or `ERR`.

The 0.4 path rejects registration, cross-origin iframes, discoverable requests without an allow-credential ID, more than 16 credential IDs, and WebAuthn extensions other than `remoteDesktopClientOverride`. It does not silently downgrade unsupported operations.

### Build and test

The native binary and generated checksum are not distributed in Git. On macOS, build them locally with a working Swift toolchain before running the exporter installer:

```sh
npm test
swift test --package-path mac-client
./build-assert-swift.sh
```

The build script creates an ad-hoc-signed universal `build/remote-fido-assert` and its `SHA256SUMS`. Both are ignored generated artifacts. The installer verifies the local binary against that checksum. Review any separately distributed binary for embedded build paths; a checksum alone is not a privacy audit or publisher identity. Quarantined downloadable builds require an appropriate signing/notarization distribution workflow, which is not provided here.

With exactly one FIDO HID device attached, `./build/remote-fido-assert --ready` performs CTAP2 `getInfo`, closes the device, and reports its stable IOKit identity. It does not request a PIN or touch, but it is a real hardware diagnostic; do not confuse it with an offline test.

### Run on the Mac holding the YubiKey

Install Node.js and Tailscale, build the native client, and insert exactly one YubiKey. Replace `100.64.0.10` below with the target VM's actual Tailscale IPv4 address. These example addresses are synthetic; do not commit deployment addresses.

```sh
./install-exporter.sh --allow-client 100.64.0.10 --desktop
./install-exporter.sh --allow-client 100.64.0.10 --desktop --apply
```

Installation previews by default and refuses a newer installed version. Every installation creates `~/bin/remote-fido`; `--desktop` also creates a launcher. Its visible Terminal owns the PIN and touch prompts. Control-C stops the exporter and the extension detaches fail-closed. A Tailscale Serve rule may remain configured, but its loopback target is closed while the exporter is stopped.

Tailscale Serve passes the original peer in a PROXY v1 header; the exporter accepts it only when it matches the configured VM. Do not expose TCP 9471 outside the tailnet. Limit the tailnet ACL to the exact VM/exporter pair. The authenticator's presence timeout is not silently restarted inside the browser's longer deadline.

### Install the VM side

Replace `100.64.0.11` with the exporter Mac's actual Tailscale IPv4 address:

```sh
./install-vm-host.sh --connect 100.64.0.11
./install-vm-host.sh --connect 100.64.0.11 --apply
```

The installer refuses a newer prototype or a native-messaging name already owned by another integration. It prints the unpacked-extension directory and stops before Chrome approval. With the exporter running, check the native-host connection before loading the extension:

```sh
node "$HOME/Library/Application Support/LYTiQ/Remote FIDO/probe-native-host.mjs"
```

The expected response is `{"version":1,"type":"hello","ready":true}`. Review source and permissions before loading the extension from `chrome://extensions`; it becomes that profile's WebAuthn proxy while connected. The background check restores attachment after recovery, and the toolbar action requests an immediate check.

### Break-glass Python fallback

`assert-client.py` and pinned `requirements.txt` remain for manual diagnosis. The installer does not provision them. A temporary venv may be used with exporter arguments `--assert-mode python`, an explicit `--python`, and `--assert-client`. Exact device readiness still requires the native Swift binary. This is not the installed steady-state runtime.

## Acceptance boundary

Offline tests and virtual-authenticator browser checks do not prove a real account login, installed-browser activation, Apple Passwords compatibility, or hardware acceptance. Verify the actual relying party finishes login, then test cancellation and disconnect/reconnect behavior with an authorized account. Keep account-specific results and traces private.

The 0.4 core declares iOS 16 support, but that does not by itself provide a signed mobile app or a physical mobile ceremony. The separate 0.5 Safari path is documented in the iPhone/iPad guide.
