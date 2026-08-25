import Foundation
import YubiKit

public protocol RemoteFidoPrompter: Sendable {
    func setPINRetriesRemaining(_ value: Int?) async
    func requestPIN(retriesRemaining: Int?) async -> WebAuthn.Authorization.PINReply
    func showTouchPrompt()
    func showVerificationPrompt()
    func showNotice(_ message: String)
}

public protocol RemoteFidoCancellationSink: Sendable {
    func arm(_ action: @escaping @Sendable () async -> Void) async
}

public enum CeremonyDriverError: Error, LocalizedError, Sendable {
    case streamEnded
    case responseCount(Int)
    case pinRetryGuard(Int)
    case tooManyPINPrompts

    public var errorDescription: String? {
        switch self {
        case .streamEnded:
            "WebAuthn status stream ended without a response"
        case .responseCount(let count):
            "expected one assertion response; received \(count)"
        case .pinRetryGuard(let retries):
            "only \(retries) PIN retry remains; stopping before the key can be blocked"
        case .tooManyPINPrompts:
            "three PIN prompts were rejected; stopping before temporary lockout"
        }
    }
}

private actor PINPromptCounter {
    private var count = 0

    func next() -> Int {
        count += 1
        return count
    }

    func value() -> Int { count }
}

public struct CeremonyDriver: Sendable {
    public let client: WebAuthn.Client
    public let request: AssertionRequest
    public let prompter: any RemoteFidoPrompter
    public let cancellation: any RemoteFidoCancellationSink

    public init(
        client: WebAuthn.Client,
        request: AssertionRequest,
        prompter: any RemoteFidoPrompter,
        cancellation: any RemoteFidoCancellationSink
    ) {
        self.client = client
        self.request = request
        self.prompter = prompter
        self.cancellation = cancellation
    }

    public func run() async throws -> WebAuthn.Authentication.Response {
        let pinPrompts = PINPromptCounter()
        var uvPolicy: WebAuthn.Authorization.UVPolicy = .preferred
        var didFallbackFromUV = false

        if request.userVerification == .discouraged {
            uvPolicy = .skipped
            prompter.showNotice(
                "Authenticator note: YubiKit may still require a PIN when this key has one configured."
            )
        }
        await prompter.setPINRetriesRemaining(nil)

        while true {
            let authorization = WebAuthn.Authorization(
                providePIN: {
                    _ = await pinPrompts.next()
                    return await prompter.requestPIN(retriesRemaining: nil)
                },
                uv: uvPolicy
            )
            do {
                let stream = await client.getAssertion(request.options, authorization: authorization)
                for try await status in stream {
                    switch status {
                    case .processing:
                        break
                    case .waitingForUser(let cancel):
                        await cancellation.arm(cancel)
                        prompter.showTouchPrompt()
                    case .waitingForUserVerification(let cancel, _):
                        await cancellation.arm(cancel)
                        prompter.showVerificationPrompt()
                    case .finished(let responses):
                        guard responses.count == 1, let response = responses.first else {
                            throw CeremonyDriverError.responseCount(responses.count)
                        }
                        return response
                    }
                }
                throw CeremonyDriverError.streamEnded
            } catch let error as WebAuthn.ClientError {
                switch error {
                case .pinRejected(let retries, _):
                    let count = await pinPrompts.value()
                    guard retries > 1 else {
                        throw CeremonyDriverError.pinRetryGuard(retries)
                    }
                    guard count < 3 else {
                        throw CeremonyDriverError.tooManyPINPrompts
                    }
                    await prompter.setPINRetriesRemaining(retries)
                    prompter.showNotice("Incorrect PIN; \(retries) retries remain. Try again.")
                case .uvRejected(let retries, _) where !didFallbackFromUV:
                    didFallbackFromUV = true
                    uvPolicy = .skipped
                    prompter.showNotice(
                        "Built-in verification was rejected (\(retries) retries remain); using the PIN."
                    )
                case .uvBlocked where !didFallbackFromUV:
                    didFallbackFromUV = true
                    uvPolicy = .skipped
                    prompter.showNotice("Built-in verification is locked; using the PIN.")
                default:
                    throw error
                }
            }
        }
    }
}
