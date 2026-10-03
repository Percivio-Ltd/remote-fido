# iPhone/iPad approver

This is a foreground Safari Web Extension path, not a background push signer. The containing SwiftUI app launches the dashboard. Each mobile device needs a separate enrolled identity, tailnet connectivity, and a real credential accessible to Safari.

The browser gesture starts `navigator.credentials.get()` synchronously. Polling and completion use extension messages rather than page-context networking. Messages bind the extension, tab, top frame, exact page, request UUID, nonce, and document ID when Safari provides it. Bearer credentials remain in extension storage. Interrupted delivery does not silently repeat signing, and only identical result transport receives one retry within the original deadline.

Node and virtual-authenticator checks are not Safari hardware acceptance. A generated project, an unsigned build, successful signing, installation, and successful physical-device login are distinct validation steps. This repository makes no claim that a signed app or hardware deployment currently exists.

## Generate and build

First configure the exact hosts and tailnet suffix in a private deployment copy as described in [setup](SETUP-0.5.md). The iOS generator reuses that copy's approver resources and host permissions.

Select an absolute build root explicitly. The source checkout and any existing generated output must remain inside its resolved filesystem location; missing/relative roots and symlink escapes fail closed. For a checkout deliberately chosen as the build root:

```sh
REMOTE_FIDO_BUILD_ROOT="$PWD" node v2/build-ios.mjs
```

This generates `build/ios/RemoteFIDO.xcodeproj`, resources, Swift sources, and plists without compiling or signing. Generated files stay ignored. With working Xcode/device and simulator SDKs, an explicit unsigned build is available:

```sh
REMOTE_FIDO_BUILD_ROOT="$PWD" node v2/build-ios.mjs --build
```

Alternatively, open the generated project in Xcode or run an explicit device build:

```sh
IOS_PROJECT_DIR="$PWD/build/ios"
xcodebuild -project "$IOS_PROJECT_DIR/RemoteFIDO.xcodeproj" \
  -scheme RemoteFIDO -configuration Debug -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$IOS_PROJECT_DIR/Derived-iphoneos" \
  CODE_SIGNING_ALLOWED=NO build
```

Signing requires the operator's legitimate Apple Developer team, valid agreements, certificates, and device provisioning. Set the team privately in Xcode or use `DEVELOPMENT_TEAM="$APPLE_TEAM_ID"` only after explicitly selecting the authorized account/team. Omit `CODE_SIGNING_ALLOWED=NO` for that separate signing step. Do not publish team identifiers, provisioning profiles, or private keys, and do not reset accounts or replace certificates to work around an unrelated gate. No TestFlight upload or App Store release is performed by these commands.

## Enroll and test a physical device

1. Pair, unlock, and trust the authorized device; enable Developer Mode where required. Install and run the containing app with Xcode.
2. Enable Remote FIDO in iOS Settings → Apps → Safari → Extensions and grant its exact relying-party and tailnet permissions. Connect Tailscale.
3. Open the approval dashboard from Safari. Copy the exact `safari-web-extension://…` origin from **Browser permission setup**; never use a wildcard CORS allowance.
4. Prepare a distinct identity using the observed origin:

   ```sh
   node v2/prepare-mobile-enrollment.mjs /absolute/private/deployment \
     iphone "iPhone" safari-web-extension://ACTUAL-UUID /absolute/private/iphone-drafts
   ```

5. Review the preview before adding `--execute`. Verify draft source hashes still match the live configurations, preserve backups, and wait until no login is pending before applying and reloading affected services. Enroll a second device from the updated deployment, not an obsolete snapshot.
6. Transfer only the owning device's approver configuration through a private channel and import it using Files in the dashboard. Never reuse another device's identity.
7. Choose **Approve here by default**. Start an authorized Google passkey login on the target, approve the pending request, and use the explicit button in the genuine Google approval tab. Complete Face ID or Touch ID through the system prompt.
8. Verify that the target website finishes login. Separately test cancellation, changing selection, and backgrounding Safari. A sleeping or backgrounded device must not trigger another signer automatically.

Keep the approval tab in the foreground while signing. If opening or delivery is interrupted, cancel the target login and begin again only after the local slot clears. Do not repeat the signing gesture for an already-started request. Background push and locked-device execution are not promised.

## Non-hardware checks

```sh
npm test
CHROME_TEST_BIN=/absolute/chrome-for-testing npm run test:browser
REMOTE_FIDO_BUILD_ROOT="$PWD" node v2/build-ios.mjs
CHROME_TEST_BIN=/absolute/chrome-for-testing node tests/browser/mobile-ui.mjs
```

These commands do not establish Safari API compatibility, real credential-provider behavior, physical biometric verification, or acceptance by the relying party. Keep device- and account-specific test evidence private.

Apple references: [Safari extension compatibility](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility), [Safari extensions on iOS](https://developer.apple.com/videos/play/wwdc2021/10104/), and [development signing](https://help.apple.com/xcode/mac/current/en.lproj/dev60b6fbbc7.html).
