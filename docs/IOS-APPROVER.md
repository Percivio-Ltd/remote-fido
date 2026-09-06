# iPhone / iPad approver — 0.5.1 development

The mobile client is a Safari Web Extension packaged in a small SwiftUI app.
It uses a genuine Google HTTPS page to invoke Safari's passkey UI. It does not
request Apple's arbitrary-RP browser entitlement or transport biometric data.
The working Mac deployment is unchanged by this development work.

## Implemented and checked

- Responsive phone/tablet dashboard with a visible **Choose configuration
  file…** control, manual selection, one-off approval and local cancellation.
- A nonpersistent background controller owns a durable single-execution record.
  The foreground Google content script delivers its result using internal
  extension messages. The dashboard may be inactive during the gesture.
- Result messages bind the extension, tab, top frame, exact page, request UUID,
  random nonce and document ID when exposed by Safari. The nonce is confined
  to the isolated content world; bearer credentials and tickets remain in
  extension storage and are never injected into the website.
- Background restart can resume an already mounted operation. Interrupted
  opening/delivery never silently repeats signing. Only identical result
  transport gets one retry; the original deadline is retained.
- Enrollment drafts preserve the coordinator key and existing device/bridge
  credentials. iPhone and iPad receive separate identities. No live service
  configuration or approver selection has been changed by the preparation.

Validation on 2026-09-06: **42 Node tests pass**. The production content
ceremony passes real Chrome-for-Testing API checks using a virtual authenticator,
including mobile event delivery without a dashboard, exact sender binding and
independently verified signatures. Mocked controller tests cover worker restart,
competing requests, expiry, cancellation, wrong senders and ambiguous delivery.
The generated mobile dashboard loads without JavaScript errors at 390px and
1024px widths; screenshots were visually checked. Swift sources type-check
against the iOS 26.5 SDK for arm64 iOS 17. Generated plists validate.

**These are not Safari hardware tests. No signed installable app exists yet.**
The app and embedded Safari extension now also compile and link successfully
with Xcode 26.6 on **Tintagel** for the arm64 iPhoneOS 26.5 SDK (unsigned).
The user reported successful real Mac-to-Mac Apple-passkey forwarding on
2026-09-06; that does not establish iOS compatibility.

## Build host and current signing gate

The operator selected **Tintagel for compilation and signing**. Tidepool remains
the coordinator only; Nimue, iPhone and iPad are approvers. Generating project
files in the source checkout does not run an approver there. No Tidepool Xcode
repair is needed for this route.

On 2026-09-06 Tintagel's existing Apple Development certificate matched the
operator's requested Apple account and team `HMJ2B32DZG`. Xcode built both targets
successfully after correcting PBX metadata serialization. The subsequent
automatic-signing attempt reached Apple but was refused with:

> Unable to process request - PLA Update available

Apple requires the account holder to review and accept the updated Developer
Program License Agreement before it will issue the app's provisioning profiles.
The Gmail Chrome profile on Tintagel has the Apple Developer login open; the
website was not yet signed in when checked. No agreement was accepted. The
remembered iPhone was unavailable, and an iPad was not listed. Connect/unlock
and trust each device for installation; no hardware install has occurred.

Reproduce the build by running `node v2/build-ios.mjs` in the source checkout,
then copying the generated project, Swift files, plist and `Resources/` from
`build/ios/` into an isolated build directory on Tintagel. On Tintagel:

```sh
IOS_PROJECT_DIR=/absolute/path/to/staged/project
xcodebuild -project "$IOS_PROJECT_DIR/RemoteFIDO.xcodeproj" \
  -scheme RemoteFIDO -configuration Debug -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$IOS_PROJECT_DIR/Derived-iphoneos" \
  CODE_SIGNING_ALLOWED=NO build
```

After the account holder resolves Apple's agreement gate, use a separate
`Derived-signed` directory, omit `CODE_SIGNING_ALLOWED=NO`, and add
`-allowProvisioningUpdates DEVELOPMENT_TEAM=HMJ2B32DZG` for the authorized
development signing attempt. Do not reset accounts or replace certificates to
work around Apple's gate. Use Xcode to run on the paired devices with Developer
Mode enabled. No TestFlight upload or App Store release is part of this build.

## Enroll and test each physical device

1. Install and run the containing app. In iOS Settings → Apps → Safari →
   Extensions, enable Remote FIDO and allow its Google and tailnet sites.
2. Connect Tailscale on the device. In Safari's extension menu, choose Remote
   FIDO → **Open approval dashboard**.
3. Expand **Browser permission setup** and copy its exact
   `safari-web-extension://…` origin. Do not use a wildcard CORS allowance.
4. Prepare a separate identity using the actual origin, for example:

   ```sh
   node v2/prepare-mobile-enrollment.mjs /Volumes/BigStore/remote-fido-v2-deployment iphone "iPhone" safari-web-extension://ACTUAL-UUID /Volumes/BigStore/remote-fido-iphone-enrollment
   ```

   Review the preview, then add `--execute` to write private config drafts.
   This command never edits or reloads the running services. Before applying
   drafts, verify their recorded source hashes match the live configs and no
   login is pending. Copy the updated target config to its actual host and
   reload only the affected v2 services. Preserve a recoverable config backup.
   Enroll iPad **from the updated deployment**, not from an obsolete snapshot.
5. Transfer only the owning device's `iphone-approver.json` or
   `ipad-approver.json` through a private channel, then choose it using Files
   in the dashboard. These are credentials: do not commit or paste them into
   chats. Never reuse Nimue's identity for either device.
6. Choose **Approve here by default**. Start the Google passkey login in
   Tintagel's already configured Gmail Chrome profile. Tap **Approve this
   login** on the phone/tablet, then the button in the Google approval tab.
   Complete Face ID / Touch ID using the system passkey prompt.
7. Verify the website on Tintagel actually finishes login. Then test cancellation,
   changing selection between phone and tablet, and backgrounding Safari. A
   backgrounded/sleeping device must not cause another signer to take over.

Keep the approval tab in foreground while signing; no background push or
locked-device execution is promised. If opening or delivery was interrupted,
cancel the target login and start a fresh login after the local slot clears.
Do not retry the signing gesture for an already-started request.

Browser test commands (isolated profiles only):

```sh
npm test
CHROME_TEST_BIN=/absolute/chrome-for-testing npm run test:browser
node v2/build-ios.mjs
CHROME_TEST_BIN=/absolute/chrome-for-testing node tests/browser/mobile-ui.mjs
```

Apple references: [Safari extension compatibility](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility),
[Safari extensions on iOS](https://developer.apple.com/videos/play/wwdc2021/10104/),
[development signing](https://help.apple.com/xcode/mac/current/en.lproj/dev60b6fbbc7.html).
