# Selected approvers: setup and acceptance

The 0.5 prototype is opt-in and separate from the 0.4 YubiKey path: it uses different extension IDs, native-host names, configuration, and ports. The root `VERSION` still identifies the legacy 0.4 path. Nothing in this guide claims a live deployment or successful physical-device login.

## Configure a private deployment copy

`v2/topology.example.json` contains synthetic device names and `example.ts.net` hosts. It is not a ready-to-run deployment. Keep real topology, tokens, keys, account details, and device configurations outside the public checkout.

Before provisioning, make the following coordinated substitutions in a private copy of the source:

1. Set actual coordinator and target HTTPS endpoints, device IDs, explicit roles, and approver target lists in the private topology.
2. Replace the example service entries in `v2/approver-extension/manifest.json` with the exact coordinator and authorized target hosts. Retain the required exact relying-party origins. Do not use `*` hostnames or `https://*.ts.net/*`.
3. Replace the single `.example.ts.net` suffix in both `v2/approver-extension/app.js` and `v2/ios/mobile-controller.js` with the same exact tailnet suffix for that deployment. Keep the HTTPS, exact-origin, and suffix-boundary checks; do not broaden them to all `.ts.net` hosts.
4. Preserve the manifest public `key` values and extension IDs. They are public identity material, not bearer credentials or private signing keys. The repository does not provide the corresponding CRX private signing keys.

Run the public tests before making private deployment substitutions, then validate the configured copy against its intended exact hosts. Never commit the private copy, generated credentials, enrollment drafts, or operational logs to this repository.

## Provision a new deployment

Use a new permission-restricted directory, not an active deployment:

```sh
node v2/provision.mjs /absolute/private/topology.json /absolute/private/new-deployment
node v2/provision.mjs /absolute/private/topology.json /absolute/private/new-deployment --execute
```

Provisioning refuses an existing output directory. It creates distinct per-device coordinator credentials, per-target approver credentials, bridge secrets, and an Ed25519 assignment key. Copy only each device's own files to its restricted install directory. The coordinator private key never goes to an approver or target; targets receive only the public key.

On the service-owning Mac, preview installation with `node v2/install-service.mjs /absolute/private/device-config.json`, then explicitly add `--execute`. Preserve `v2/` beside `protocol.mjs`. The installer refuses existing service/native manifests or a different installed version instead of implicitly overwriting them. It does not activate Chrome.

Inspect existing Tailscale Serve rules before configuring the new rule. The coordinator normally uses tailnet HTTPS 9472 to loopback 19472; each target uses HTTPS 9473 to loopback 19473. Services require both device bearer credentials and exact registered extension origins. Do not use Funnel or a public reverse proxy. Restrict the tailnet ACL to the intended devices.

## Activate and accept the browser path

1. On an approver, load the privately configured `v2/approver-extension` using `chrome://extensions`. Expected ID: `hccloojihlmnnpmdkknnloknfbbbelba`. Import that device's private approver configuration in its dashboard and explicitly choose **Approve here**.
2. On a target, select the intended Chrome profile. Disable any old Remote FIDO proxy in that profile, then load the installed `v2/target-extension`. Expected ID: `dollgdpmepjkbpialkfeafneeppmcijn`. Click its action to enable it.
3. Start an authorized Google passkey login on the target. On the approver, choose the pending request and the explicit passkey button on the genuine same-origin approval page. Complete local verification using the browser's offered provider.
4. Verify the target website actually finishes login. “Assertion delivered” means transport completed, not that the relying party accepted it. Then test cancellation and return the target to `OFF` when finished.

`ON` means the target native connection and Chrome proxy attachment succeeded; it does not promise an approver is online. Do not enable the target proxy in the approver's browser profile, because it would intercept its own local WebAuthn request. A dual-role device needs separate profiles. A matching passkey must already exist in the approver's accessible credential store.

Changing a configuration file on disk does not update the extension's stored copy. After a scoped change, reload the affected extension and import its owning configuration when required. Keep credentials private during transfer.

## Routing and supported origins

**Approve here** changes a durable default with compare-and-swap revision checks. **Handle this request here (one-off)** overrides only that request. **Any device may claim** atomically assigns the first authorized claim. A claimed request never migrates because selection changes or a device sleeps. There is no presence-based takeover or parallel broadcast of signing operations.

The coordinator sees summaries, expiry, and ownership, not challenges or assertions. Targets verify signed assignments locally; the relying party verifies the final assertion signature. Restarting a target/browser invalidates outstanding requests. A claim/start timeout may be ambiguous: cancel the login and start a fresh request instead of retrying signing. Only delivery of an identical result has a bounded retry.

The standard allowlist is exact `https://accounts.google.com` with RP `google.com` or `accounts.google.com`, exact `https://idmsa.apple.com` with RP `apple.com`, and exact `https://auth.openai.com` with RP `openai.com`. Unsupported origins, cross-origin frames, registration, and extra WebAuthn extensions remain rejected. No origin spoofing, TLS interception, browser-policy bypass, or arbitrary-RP entitlement is used.

Actual Apple Account login remains incomplete because its `largeBlob`/`prf` extensions are rejected. Synthetic checks do not establish real Apple login. OpenAI transport support does not establish successful ChatGPT login; site verification or Permissions Policy may block WebAuthn. Complete website verification normally; do not override headers or bypass it.

## Scoped changes to an existing deployment

The policy updaters preview by default, preserve existing credentials, retain a private original, and refuse conflicting entries:

```sh
node v2/update-apple-policy.mjs /absolute/private/target-config.json
node v2/update-openai-policy.mjs /absolute/private/target-config.json
node v2/update-coordinator-endpoint.mjs /absolute/private/device-config.json \
  https://coordinator.example.ts.net:9472 https://coordinator2.example.ts.net:9472
```

Replace example hosts with the private endpoints. Add `--execute` only after checking the preview and confirming no login is pending. The coordinator updater requires the same tailnet and port, and changes only the coordinator endpoint. It does not change tokens, signing keys, RP policy, selection, services, or routing. Update the exact host permissions and private suffix together where necessary, and reload only affected services/extensions.

Enrollment helpers prepare mode-0600 private drafts and record source hashes; they do not apply drafts, reload services, operate Chrome, or select an approver:

```sh
node v2/prepare-desktop-enrollment.mjs /absolute/private/deployment \
  desktop "Desktop approver" target,target2 /absolute/private/desktop-drafts
node v2/prepare-target-enrollment.mjs /absolute/private/deployment \
  target approver target2 "Second target" https://target2.example.ts.net:9473 \
  19473 /absolute/private/target-drafts
```

Use actual private IDs/endpoints and add `--execute` after review. Extending an existing target into a dual-role device additionally requires `--extend-existing-target`. Verify source hashes against the live files, preserve backups, and wait until affected services have no pending login before applying. Retain existing identities, credentials, and selection. Copy only each device's own configuration and synchronize retained private deployment copies for later enrollment. Do not use the new-deployment provisioner to add a device to a live setup.

## Tests

```sh
npm ci --ignore-scripts
npm test
CHROME_TEST_BIN=/absolute/path/to/isolated/chrome-for-testing npm run test:browser
```

Browser tests use their own temporary profile and a virtual authenticator, not an existing browser session or real passkey. The optional `REMOTE_FIDO_TEST_LIVE_APPLE=1` and `REMOTE_FIDO_TEST_LIVE_OPENAI=1` modes reach the genuine relying-party origin but still do not prove a successful real-account login. They are separate, deliberate checks.

`v2/smoke.mjs target|approver private-config.json shared-uuid [google|apple|openai]` is a live cancellation-only transport check. Run it only with authority for the selected deployment. It does not open a browser or change selection and is not a substitute for physical acceptance.

For generated iOS projects, signing prerequisites, and device validation, see [iPhone/iPad approver](IOS-APPROVER.md).

## Stop or roll back

Disable the new target extension in its own profile before re-enabling the old 0.4 proxy. On a service host, `launchctl bootout gui/$(id -u)/de.lytiq.remote-fido-v2.target` or the `.coordinator` equivalent stops only that service. Disable only its new Tailscale Serve rule, such as HTTPS 9473 on the target or HTTPS 9472 on the coordinator. Preserve private configurations for a deliberate restart; do not delete unrelated services, keys, Chrome profiles, or Serve rules.
