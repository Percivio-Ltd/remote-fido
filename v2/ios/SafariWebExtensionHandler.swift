import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        // No native authentication bypass, biometric data, or logging of
        // messages. All passkey operations use Safari in the genuine RP page.
        context.completeRequest(returningItems: [], completionHandler: nil)
    }
}
