# Security baseline and local-approval protection

Reviewed on 2026-10-22. This is a dated baseline, not a guarantee that software remains fully patched indefinitely. Private deployment configuration and operational acceptance records must stay outside the public repository.

## Required versions

| Component | Requirement | Enforcement |
| --- | --- | --- |
| Node.js | 22.23.4+, 24.22.1+, or 26.12.1+, within those reviewed major lines | Existing `node-runtime.mjs` checks, installers, and strict npm engines |
| Chrome | 156.0.8078.47+ | All three extension manifests, legacy installer, and browser tests |
| Playwright | Exact 1.64.1 with lockfile integrity | Development/test dependency only |

The [October 21 Node security advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) and [October 20 Chrome stable release](https://chromereleases.googleblog.com/2026/10/stable-channel-update-for-desktop_02018666648.html) define this baseline. Host OS and authenticator firmware need separate maintenance.

`npm run security:check` consults the official Node release index, refuses stale security floors, checks the current stable Chrome for Testing version, verifies all manifest floors, and runs `npm audit --audit-level=low`. Network failures fail the check. Static startup floors permit offline operation; future advisories still require review and deployment updates. A clean advisory report is not proof of zero vulnerabilities.

Run `CHROME_TEST_BIN='/absolute/path/to/Chrome for Testing' npm run verify` with a patched, approved test browser. Playwright 1.64.1 bundles Chrome 156.0.8078.4, below this baseline; use Google's Chrome for Testing 156.0.8078.47 or newer rather than weakening the check. Browser tests use isolated profiles, not production accounts.

## Forwarding-loop protection

Only the exact approver extension's `app.html` may acquire the target's authenticated external-port guard. Before the approver claims a request, the target prevents new attachment, persists a six-minute restart hold, disconnects its native pipe, waits for any in-flight attachment, and confirms proxy detachment. Active outgoing requests, another local approval, incompatible targets, and guard failures block signing. An absent or disabled target permits local signing, while enable/install events are monitored.

Heartbeats prevent idle suspension during local approval. Loss of the guard cancels signing. Completion, cancellation, or closing the page releases the guard but leaves remote forwarding off. An abrupt worker restart remains fail-closed for up to six minutes. User presence, verification, origin binding, and assertion validation remain required. No key material or credential payload crosses the guard.

The new `management` permission only inspects installed extensions and observes enable/install events; no enable, disable, or uninstall API is called. Legacy proxies need explicit disabling because they lack the guard protocol. Safari's separate mobile path does not request this permission.

## Activation and evidence

Update and relaunch Chrome before reloading both desktop extensions. Accept the approver's new permission and reopen its page. Preserve exact private host permissions, the configured tailnet boundary, existing credentials, and stable extension identities; public example endpoints are not deployment configuration.

Automated tests exercise guard failures, authenticated messaging, restart holds, attachment races, and a real browser's transition from forwarding ON to local virtual USB CTAP2 signing and then OFF. The browser test independently verifies the assertion signature, but mocks the native pipe and does not prove physical YubiKey or real-account acceptance. Validate a physical-key login separately after deployment.
