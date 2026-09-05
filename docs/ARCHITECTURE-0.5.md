# Remote FIDO 0.5: selected approvers

## Accepted scope

Tidepool coordinates manual approver selection. The first physical acceptance
pair is **Tintagel as target, Nimue as Apple-passkey approver**. No presence
detection. A machine can run both roles in separate browser profiles. Existing
0.4 YubiKey installations remain usable during migration.

The first release is a testable prototype. A browser/virtual-authenticator test
does not establish that an existing Apple passkey works with a live Google
challenge; the operator will perform that acceptance after returning.

## Components and trust

- Coordinator: a small service on Tidepool, exposed only through Tailscale
  HTTPS. It persists the selected approver, revision, and exclusive request
  assignments. It advertises target endpoints and pending request summaries.
- Target: a per-user service plus Chrome WebAuthn proxy. It retains the original
  request and returns the completed assertion to the originating browser
  session. Each browser session has a unique ID; Chrome numeric IDs are local
  to that session. Targets validate the RP/origin and the returned assertion.
- Approver: a browser extension with a small status/selection page. It contacts
  Tidepool and connects outbound to the selected target. The challenge and
  signature move directly between target and approver over Tailscale HTTPS.
- Backend: Apple Passwords through the physical device's browser; existing
  Swift/YubiKit support is a separate backend. The session protocol does not
  assume a USB device. Private keys, PINs, fingerprints, and account cookies
  are not transported.

Network endpoints require provisioned per-device credentials in addition to
tailnet access. A device has explicit target/approver roles and an authorized
target set. Secrets stay outside Git, in permission-restricted runtime config.
Browser access is limited to registered extension origins and the exact service
origin. Browser extensions receive only their own approver credential.

## Manual selection and exclusive execution

The selected device is a durable preference, separate from online status. An
approver heartbeat never selects that device. "Approve here" changes the
selection and increments its revision; waking an old device does not take over.
Selection updates use compare-and-swap to reject stale concurrent changes.

Requests are identified by random UUID plus target/browser identity and retain
the browser's deadline. States are pending, assigned, completed, cancelled, or
expired. Only one approver can claim a request; a claim is durable before it is
returned. A claimed request stays on that device across selection changes.
"Handle this request here" permits an explicit one-request exception. Any-device
mode distributes summaries, with the first successful claim choosing the sole
approver. No multicast of actual signing operations.

The coordinator issues a signed, expiring assignment bound to target, request
UUID, request digest, approver, and revision. Targets verify it locally. This
lets an assigned operation finish during coordinator downtime. Unassigned
operations cannot start while the coordinator is unavailable. A restart retains
assignment ownership and never silently requeues a started signing operation.

Approvers serialize visible prompts. Queuing never extends a browser deadline.
Retries can recover a stored completed result but cannot replay a signing
operation. Cancellation and expiry invalidate target execution; a stale result
cannot complete another request. Closing/restarting the browser or target
invalidates its outstanding requests.

## Apple backend feasibility and implementation order

1. Prove a normal extension content script can call WebAuthn in an actual RP
   origin, preserve clientData origin/challenge, and return a verifiable signed
   assertion. Use an isolated test browser and virtual authenticator first.
2. Implement coordinator persistence, selection, exclusive claims, signed
   assignments, direct target transport, and deterministic failure tests.
3. Implement a target extension/native bridge and an approver extension with
   active-device status, manual selection, explicit local approval, and
   cancellation. Stage the Tintagel/Nimue pair without opening target windows.
4. Prepare Apple-passkey acceptance: target Google login, Nimue Chrome approval
   tab at the same origin, actual Touch ID, and target login completion. This
   step requires the operator and is not claimed by automated tests.
5. Package an iOS Safari Web Extension approver if its APIs and available Xcode
   tooling support the same-origin operation. Build for device/simulator without
   claiming hardware passkey acceptance or background operation. Document any
   remaining signing/extension-activation prerequisites.

Apple's native arbitrary-RP browser API requires an Apple-granted entitlement;
changing a passkey's label does not grant that permission. Chrome 152's generic
remote-origin policy requires matching managed affiliation IDs, so setting a
local preference alone does not establish support on these unmanaged Macs.

The alternative being tested is an explicitly installed extension executing
WebAuthn in a dedicated **real HTTPS page at the original RP origin**, using
the browser's normal Apple-passkey support. It does not forge an origin, replace
TLS, patch browser binaries, use remote debugging in production, or request
Apple browser entitlements. Google uses a dedicated accounts.google.com page;
other origins require explicit configuration and extension host permission.
The local document must remain at the exact original origin through completion.

## Validation and rollout

Test competing claims, stale selections, restart persistence, expired tickets,
cross-target ticket rejection, cancellation, repeated completion, direct
transport without coordinator payload relay, malformed requests, and profile
isolation. Browser tests use a virtual authenticator to validate actual browser
API boundaries and signature verification. They are distinct from Touch ID.

Installers preview by default, preserve unrelated services and profiles, and
warn/stop on a newer installed version. New coordinator/target components use
separate runtime directories and ports. Existing YubiKey settings are not
implicitly replaced. All maintained source and tests live in this repository;
Ops pins a published commit through its submodule.

## Primary references

- [Chrome proxy API](https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy)
- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome content-script isolation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome 152 remote-origin authorization](https://github.com/chromium/chromium/blob/152.0.7977.76/chrome/browser/webauthn/chrome_web_authentication_delegate_base.cc)
- [Chrome managed affiliation](https://github.com/chromium/chromium/blob/152.0.7977.76/components/policy/core/common/cloud/affiliation.cc)
- [Apple browser-passkey entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential)
- [Chrome Apple Passwords support](https://developer.chrome.com/blog/passkeys-on-icloud-keychain)
