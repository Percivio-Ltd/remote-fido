# Selected approvers: setup and acceptance

## agent-02 enrollment — 2026-09-10

The agent-02 target service and separate v2 native host are installed under
`/Users/admin/Library/Application Support/RemoteFIDO-v2`. Tailscale Serve exposes
only tailnet HTTPS port 9473 to loopback 19473. Nimue is authorized for both
Tintagel and agent-02; existing Tintagel credentials and the coordinator signing
key are unchanged. Nimue remains selected at revision 1. A live cancellation-only
test passed from the agent-02 native bridge through the coordinator and Nimue's
direct HTTPS connection, including duplicate-start rejection and native request
ID delivery. There were zero pending requests afterward. All 47 Node tests pass.
This does not prove Chrome activation or a successful real passkey login.

Browser activation remains manual:

1. On **agent-02**, repeat in **Percivio**, **Operator**, and **LYTiQ** Chrome
   profiles: open `chrome://extensions`, enable Developer mode, and Load unpacked
   `/Users/admin/Library/Application Support/RemoteFIDO-v2/code/v2/target-extension`.
   Expected extension ID: `dollgdpmepjkbpialkfeafneeppmcijn`. Disable the old
   Remote FIDO proxy in that profile if enabled, then click the new target
   extension to turn it **ON**. Existing old services/configuration were preserved.
2. On **Nimue**, reload **Remote FIDO — Approve here** in its already-configured
   Chrome profile and accept the added exact `agent-02.tailbb0f71.ts.net` site
   permission. Reopen the dashboard and import the updated
   `/Users/artuskg/Library/Application Support/RemoteFIDO-v2/nimue-approver.json`.
   The file is private; do not paste or publish its contents. Updating the file
   on disk does **not** update the extension's stored configuration automatically.
3. Start a Google passkey login on agent-02 and approve it on Nimue. Completion
   on the actual Google page is the remaining real-login acceptance test.

Known limitation: actual Apple login requests use `largeBlob`/`prf` extensions
that this prototype rejects. The earlier synthetic Apple check below did not
exercise those extensions and does not establish real Apple login support.
This enrollment does not fix that incompatibility.

## Current status — 2026-09-05

This is an opt-in **0.5.0 prototype**, separate from the existing 0.4 release,
native-host name, extension IDs, configuration, and ports. The repository's
root `VERSION` and bundled YubiKey binary still belong to 0.4.

- Tidepool: coordinator LaunchAgent installed; tailnet HTTPS on port 9472.
- Tintagel: target LaunchAgent and native-messaging host installed; tailnet
  HTTPS on port 9473. No Chrome window or profile was operated or changed.
- Nimue: approver extension and private device configuration staged. Manual
  Chrome installation / site permission remains required.
- Initial selection is **unset**. Use **Approve here** on Nimue. Heartbeats
  never select or take over a device.
- All 33 Node tests pass. The production isolated content-script ceremony
  passes an actual Chrome-for-Testing 145 WebAuthn test with a virtual CTAP2
  authenticator and independent public-key signature verification. This is
  not a test of Apple Passwords or the installed Chrome 152 browser.
- A live three-machine **synthetic cancellation** test passed through the
  Tintagel native bridge → Tidepool claim → Nimue direct fetch → Tintagel
  cancellation path, including duplicate-start rejection. No real credential
  was used and no successful Google login is claimed.

## Tomorrow: physical acceptance

1. On **Nimue**, in the Chrome profile that can use the existing Apple passkey,
   open `chrome://extensions`, enable Developer mode, and Load unpacked:
   `/Users/artuskg/Library/Application Support/RemoteFIDO-v2/approver-extension`.
   Expected ID: `hccloojihlmnnpmdkknnloknfbbbelba`.
2. Click its toolbar action. Import
   `/Users/artuskg/Library/Application Support/RemoteFIDO-v2/nimue-approver.json`.
   This file is a credential: do not paste it into chats or commit it. Choose
   **Approve here**. The dashboard should show Nimue as selected.
3. On **Tintagel**, use the intended Google login profile (start with Gmail /
   Default). If the old LYTiQ Remote FIDO proxy is enabled **in that profile**,
   disable it there first. Do not alter other profiles. Load unpacked:
   `/Users/artus/Library/Application Support/RemoteFIDO-v2/code/v2/target-extension`.
   Expected ID: `dollgdpmepjkbpialkfeafneeppmcijn`.
4. Click the target extension once to enable it. `ON` means the local native
   host is connected and Chrome proxy attachment succeeded; it does not promise
   the selected device is online. Start the actual Google passkey login.
5. On Nimue, click **Approve this request**. A dedicated real
   `https://accounts.google.com/robots.txt` tab opens. Click **Use a passkey on
   this device**, select Apple Passwords if prompted, and use Touch ID (or the
   system's offered local verification). No biometric data is transported.
6. Confirm the actual target website finishes login. "Assertion delivered"
   means transport completed, not that Google accepted it. Then test one
   cancellation. Click Tintagel's target action again to return to `OFF`.

Do not install/enable the target proxy in the approver's browser profile: its
own local WebAuthn request would be intercepted. A single physical device can
have both roles, but use separate browser profiles. A matching Google passkey
must already exist in the approver's accessible credential store. Naming or
renaming a passkey does not change its RP or key ownership.

## Routing and boundaries

**Approve here** selects a durable default with compare-and-swap revision
checks. **Handle this request here (one-off)** explicitly overrides only that
request. **Any device may claim** offers summaries to authorized devices and
atomically assigns the first claim. A claimed request never migrates merely
because selection changes or its owner disconnects. No presence inference or
parallel broadcast of signing operations is used.

The full-page dashboard shows selection, recently-seen devices, pending
summaries and remaining deadlines. Chrome's badge polls pending summaries;
native desktop push notifications and an always-running menu-bar app are not
implemented. The foreground dashboard is required for approval. Device sleep
does not silently choose another approver. A claim/start timeout can be
ambiguous: do not retry signing; cancel the target login and start a new one.
Only identical result delivery has a bounded transport retry.

The coordinator sees target, request UUID, original origin/RP, digest,
expiry and ownership—not challenges, credentials or signatures. Targets verify
signed assignments locally; an already assigned request can finish while the
coordinator is down. Targets check assertion structure and request binding;
the real relying party checks the cryptographic signature with its registered
public key. Target/browser restarts invalidate outstanding requests.

Allowlist: exact `https://accounts.google.com`, RP `google.com` or
`accounts.google.com`; and exact `https://idmsa.apple.com`, RP `apple.com`.
The approver reconstructs options from the exact hashed
request and uses a real same-origin HTTPS page in an isolated content world.
No CDP, Chrome policy spoofing, forged origin, TLS interception, Apple browser
entitlement, or associated-domain impersonation is used in production.
Registration, cross-origin frames, extra WebAuthn extensions, and unconfigured
origins are rejected. Original credential IDs, transports and UV preference
are preserved. The browser decides which local passkey providers are offered.

## Apple Account forwarding (approver extension 0.5.2)

The prototype includes an `idmsa.apple.com` forwarding policy, but actual
Apple login remains incomplete because its `largeBlob`/`prf` extensions are
rejected (see the current limitation above). It also does not support every
Apple subdomain or cross-origin embedded sign-in flow. Apple approval opens the exact same-origin
`https://idmsa.apple.com/appleauth/auth/authorize` page. The ordinary
`robots.txt` endpoint redirects away and is deliberately not used. The extension
adds a foreground approval dialog and focuses its explicit passkey button.
This passes the original target challenge to the local browser; it does not
submit a separate local Apple login or forward password-autofill approvals.

For an existing deployment, preserve all credentials. The scoped updater adds
only the supported Apple policy and refuses a conflicting existing entry:

```sh
node v2/update-apple-policy.mjs /absolute/tintagel-target.json
# Check the coordinator has no pending login before applying/restarting.
node v2/update-apple-policy.mjs /absolute/tintagel-target.json --execute
```

It creates a mode-0600 original-config backup, verifies the replacement and
does not restart any service itself. Reload only the v2 target service. Keep
the retained deployment copy in sync for future device enrollment. Update
Nimue's `request.js`, `ceremony.js` and `manifest.json`, preserving the extension
ID and stored config. Reload **Remote FIDO — Approve here** in Chrome, accept
its added `idmsa.apple.com` permission, and refresh the dashboard. The target
Chrome extension itself needs no code or permission change; if it shows OFF
or ERR after a service restart, explicitly enable it again.

Then choose **Sign in with Passkey** on Tintagel's Apple login page and approve
the request on Nimue. A Chrome password-autofill Touch ID prompt is a different
operation and is not forwarded by this WebAuthn path. Any Apple Developer
Program agreement remains a separate account-holder decision.

Checks on 2026-09-06: 45 Node tests pass. An isolated Chrome-for-Testing profile
loaded the real Apple approval page and used a **virtual authenticator** to
verify exact `idmsa.apple.com` origin, `apple.com` RP, challenge, UP/UV and a
cryptographically valid synthetic signature. Local-browser regression tests
also pass. Live Tintagel↔Nimue synthetic cancellation checks exercise both
Apple and Google routing without using a real passkey or changing selection.
These checks do not establish successful Apple Account login with a real key.

```sh
CHROME_TEST_BIN=/absolute/chrome-for-testing REMOTE_FIDO_TEST_LIVE_APPLE=1 \
  node tests/browser/approver.test.mjs
```

## Provisioning other nodes

`v2/topology.example.json` is a non-secret example. Device roles are arrays;
one device can contain both `target` and `approver`. Each approver has an
explicit authorized target list. Each target has its own HTTPS endpoint and
local bridge port. Extend the approver manifest's exact host permissions and
the explicit RP policy when adding service hosts or sites; do not use broad
host permissions as a shortcut.

For a **new deployment**, not to overwrite the active one:

```sh
node v2/provision.mjs topology.json /Volumes/BigStore/new-private-deployment
node v2/provision.mjs topology.json /Volumes/BigStore/new-private-deployment --execute
```

Provisioning refuses an existing output directory. It generates distinct
per-device coordinator credentials, per-target approver credentials, local
bridge secrets and an Ed25519 assignment key. Copy only the owning device's
files to its permission-restricted install directory. The coordinator key
never goes to an approver or target; targets get only its public key.

Run `v2/install-service.mjs /absolute/config.json` on the service-owning Mac to
preview, then add `--execute`. Source installation must preserve `v2/` beside
`protocol.mjs`. It refuses existing service/native manifests or a different
installed version instead of implicitly overwriting them. Tailscale Serve is
configured separately after inspecting existing rules. Services bind only
loopback; HTTPS access also requires a device bearer credential and an exact
allowed extension origin. Do not expose these ports using Funnel or a public
reverse proxy. Restrict tailnet ACLs to the intended nodes.

Adding a node to an existing deployment requires deliberate credential and
config enrollment on the coordinator and affected targets, followed by a
service reload when no login is pending. It is not automatic discovery. Daily
switching among enrolled approvers needs only **Approve here**, not reprovisioning.

To add a target for an existing approver while retaining all current identities:

```sh
node v2/prepare-target-enrollment.mjs /absolute/private-deployment \
  tintagel nimue agent-02 agent-02 https://agent-02.tailbb0f71.ts.net:9473 \
  19473 /absolute/new-private-drafts
# Add --execute only after checking the preview.
```

The helper refuses duplicate identities/endpoints and mismatched reference keys
or credentials. It writes mode-0600 drafts and source hashes without reloading
services or changing selection. Verify those source hashes before applying,
back up affected configs, and wait until no login is pending. Copy only the
new target/bridge credentials to the target; reload the coordinator after its
config update. Update the affected approver's exact host permissions, reload
that extension and import its updated config. Keep the retained deployment
copies synchronized for subsequent enrollment; do not use the new-deployment
provisioner to add a device to a live setup.

On Tidepool, private runtime/config/state and installed code are under
`/Volumes/BigStore/remote-fido-v2-deployment`. The LaunchAgent is
`~/Library/LaunchAgents/de.lytiq.remote-fido-v2.coordinator.plist`. Tiny launch
diagnostics use `~/Library/Logs/RemoteFIDO-v2/coordinator.log`: macOS denies
launchd's pre-exec log creation on this external volume. Payloads and builds
remain on BigStore. On Tintagel, the new install root is
`~/Library/Application Support/RemoteFIDO-v2`; its existing services remain
separate.

## Tests

```sh
npm ci --ignore-scripts --cache /Volumes/BigStore/remote-fido-npm-cache
npm test
CHROME_TEST_BIN=/absolute/path/to/isolated/chrome-for-testing npm run test:browser
```

Browser tests launch only their own temporary profile and local HTTP test RP
(localhost secure-context exception). They do not attach to an existing
browser, install a managed tool update, or use real passkeys. Temporary profiles
are created under the repository's ignored `.scratch/` on BigStore.

`v2/smoke.mjs target|approver private-config.json shared-uuid` is an explicit
live **cancellation-only** test. Run target first on the target device, then
approver on the source device within 60 seconds, using the same fresh UUID.
It tests the real HTTPS/native transport without opening a browser or changing
selection. Never substitute it for the Google acceptance test above.

## iOS Safari preparation

For the subsequent mobile implementation, current blockers, enrollment and
hardware acceptance, see [iPhone/iPad approver](IOS-APPROVER.md). The notes below
describe the initial wrapper and its build prerequisites.

`v2/ios/` contains a SwiftUI setup app, Safari Web Extension handler and launcher.
`node v2/build-ios.mjs` generates a reproducible Xcode project under ignored
`build/ios/`; the extension reuses the same approver JavaScript, with Safari's
nonpersistent background-script manifest and popup launcher. No Apple
arbitrary-RP browser entitlement is requested.

The Swift sources **type-check** for arm64 iOS 17 against the installed iOS
26.5 SDK. The generated plists validate. **No app build or device installation
has succeeded**: Xcode 26.6 cannot load `IDESimulatorFoundation` against the
installed `DVTDownloads` framework. Both Apple's converter and `xcodebuild`
fail before building. The standard `xcodebuild -runFirstLaunch` repair reports
that administrator authorization is required. No system framework was replaced
and no developer identity was invented.

After the operator repairs Xcode setup:

```sh
node v2/build-ios.mjs --build
```

For an actual iPhone, open the generated project in Xcode, select a legitimate
development team/signing profile, and deploy to the phone. Enable the Safari
extension and grant its site permissions. Provision a **separate phone
identity**, import its config, and add the exact `safari-web-extension://…`
origin shown in its dashboard to the coordinator and target CORS allowlists.
Do not relax CORS to allow all Safari extensions. The phone needs tailnet
connectivity. Foreground execution, Safari API compatibility, real Face ID /
Touch ID and Google acceptance still need hardware testing; no background push
or suspended-phone approval is claimed.

## Stop / rollback

First disable the **new target extension** in its own profile (or click it to
`OFF`). The old 0.4 extension can then be re-enabled there if desired. On each
service host, `launchctl bootout gui/$(id -u)/de.lytiq.remote-fido-v2.target`
or the `.coordinator` equivalent stops only the new service. Disable only the
new Serve rule (`tailscale serve --https=9473 off` on Tintagel, `--https=9472
off` on Tidepool). Keep the private configs for a deliberate restart; do not
delete other services, keys, Chrome profiles or Serve rules.

References: [Chrome proxy API](https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy),
[Apple Safari extension compatibility](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility),
[Apple Safari extension setup](https://developer.apple.com/documentation/safariservices/creating-a-safari-web-extension).
