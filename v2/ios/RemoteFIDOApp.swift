import SwiftUI

@main
struct RemoteFIDOApp: App {
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                List {
                    Section {
                        Label("Approve here", systemImage: "person.crop.circle.badge.checkmark")
                            .font(.largeTitle.bold())
                        Text("Use a passkey on this iPhone or iPad to approve a login on another computer. Your fingerprint, face data, and private keys stay on this device.")
                    }
                    Section("Set up Safari") {
                        Text("1. Enable Remote FIDO in Settings → Apps → Safari → Extensions.")
                        Text("2. Allow its Google and private tailnet website permissions.")
                        Text("3. In Safari’s extension menu, choose Remote FIDO, then Open approval dashboard.")
                        Text("4. Tap Choose configuration file in the Safari dashboard and select this device’s private JSON in Files. Your iPhone and iPad each need their own identity.")
                        Text("5. Register the exact Safari extension origin shown in the dashboard with the coordinator and target.")
                    }
                    Section("Manual routing") {
                        Text("Tap Approve here by default in the dashboard to select this device. There is no presence detection and no automatic takeover when a device wakes.")
                        Text("For a pending request, open its dedicated approval page, tap Use a passkey on this device, then use the system passkey prompt.")
                    }
                    Section("Prototype limitations") {
                        Text("Keep the Google approval tab in the foreground while approving. The dashboard tab does not need to stay active. Background push delivery is not implemented.")
                        Text("If delivery is interrupted, cancel the target login and start a new one. A started signing operation is never silently repeated.")
                        Text("Initial site support: accounts.google.com. Registration, cross-origin frames, and arbitrary website origins are disabled.")
                    }
                }
                .navigationTitle("Remote FIDO")
            }
        }
    }
}
