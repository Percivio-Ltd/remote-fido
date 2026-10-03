#if os(macOS)
import Darwin
import Dispatch
import Foundation
import RemoteFidoCore
import RemoteFidoHID
import YubiKit

private enum TerminalReason: Sendable {
    case signal
    case deadline
    case finished
}

private actor CancellationCoordinator: RemoteFidoCancellationSink {
    private let prompter: TerminalPrompter
    private var reason: TerminalReason?
    private var connection: HIDFIDOConnection?
    private var action: (@Sendable () async -> Void)?

    init(prompter: TerminalPrompter) {
        self.prompter = prompter
    }

    func bind(_ connection: HIDFIDOConnection) async -> Bool {
        guard reason == nil else {
            await connection.close(error: nil)
            return false
        }
        self.connection = connection
        return true
    }

    func arm(_ action: @escaping @Sendable () async -> Void) {
        guard reason == nil else { return }
        self.action = action
    }

    func claim(_ newReason: TerminalReason) -> Bool {
        guard reason == nil else { return false }
        reason = newReason
        return true
    }

    func cleanup() async {
        await prompter.cancelCurrent()
        let action = self.action
        self.action = nil
        let connection = self.connection
        self.connection = nil
        await action?()
        await connection?.close(error: nil)
    }

    func finish() async -> Bool {
        guard claim(.finished) else {
            await cleanup()
            return false
        }
        await cleanup()
        return true
    }

    func terminalReason() -> TerminalReason? { reason }
}

private final class ProcessSignals: @unchecked Sendable {
    private let coordinator: CancellationCoordinator
    private let term: DispatchSourceSignal
    private let interrupt: DispatchSourceSignal

    init(coordinator: CancellationCoordinator) {
        self.coordinator = coordinator
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
        interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
        let handler: @Sendable () -> Void = { [coordinator] in
            Task {
                guard await coordinator.claim(.signal) else { return }
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) { Darwin._exit(2) }
                await coordinator.cleanup()
            }
        }
        term.setEventHandler(handler: handler)
        interrupt.setEventHandler(handler: handler)
        term.resume()
        interrupt.resume()
    }

    func cancel() {
        term.cancel()
        interrupt.cancel()
    }
}

private enum Mode {
    case list
    case ready
    case emitClientData
    case assertion
}

private struct Arguments {
    var mode = Mode.assertion
    var device: String?
    var timeoutMilliseconds: Int?
    var userVerification: String?

    init(_ values: [String]) throws {
        var index = 0
        while index < values.count {
            let option = values[index]
            switch option {
            case "--list": mode = .list
            case "--ready": mode = .ready
            case "--emit-client-data": mode = .emitClientData
            case "--device", "--timeout-ms", "--uv":
                index += 1
                guard index < values.count else { throw UsageError() }
                let value = values[index]
                if option == "--device" { device = value }
                if option == "--timeout-ms" { timeoutMilliseconds = Int(value) }
                if option == "--uv" { userVerification = value }
            default:
                if !option.hasPrefix("-") && device == nil {
                    device = option
                } else {
                    throw UsageError()
                }
            }
            index += 1
        }
    }
}

private struct UsageError: Error, LocalizedError {
    var errorDescription: String? {
        "usage: remote-fido-assert [--list|--ready|--emit-client-data] [--device ioreg://ID] [--timeout-ms N] [--uv required|preferred|discouraged]"
    }
}

private struct RemoteFidoAssert {
    static func run() async {
        do {
            let arguments = try Arguments(Array(CommandLine.arguments.dropFirst()))
            switch arguments.mode {
            case .list:
                for device in try AuthenticatorLocator.list() {
                    print(device.displayLine)
                }
            case .ready:
                try await ready(expectedPath: arguments.device)
            case .emitClientData:
                let request = try readRequest()
                FileHandle.standardOutput.write(request.expectedClientDataJSON)
                FileHandle.standardOutput.write(Data([10]))
            case .assertion:
                try await assertCredential(arguments: arguments)
            }
        } catch {
            writeStderr("remote-fido-assert failed: \(humanMessage(error))\n")
            Darwin.exit(1)
        }
    }

    private static func ready(expectedPath: String?) async throws {
        let identity = try AuthenticatorLocator.exactlyOne(expectedPath: expectedPath)
        let connection = try await HIDFIDOConnection()
        do {
            let session = try await CTAP2.Session.makeSession(connection: connection)
            _ = try await session.getInfo()
            await connection.close(error: nil)
            _ = try AuthenticatorLocator.exactlyOne(expectedPath: identity.path)
            print(identity.displayLine)
        } catch {
            await connection.close(error: error)
            throw error
        }
    }

    private static func assertCredential(arguments: Arguments) async throws {
        let request = try readRequest()
        if let timeout = arguments.timeoutMilliseconds,
           timeout != request.timeoutMilliseconds {
            throw AssertionRequestError.invalid("timeout policy changed between exporter and client")
        }
        if let verification = arguments.userVerification,
           verification != request.userVerificationText {
            throw AssertionRequestError.invalid("user-verification policy changed between exporter and client")
        }

        let identity = try AuthenticatorLocator.exactlyOne(expectedPath: arguments.device)
        let prompter = TerminalPrompter()
        let coordinator = CancellationCoordinator(prompter: prompter)
        let signals = ProcessSignals(coordinator: coordinator)
        let deadline = Task {
            try? await Task.sleep(for: .milliseconds(request.timeoutMilliseconds))
            guard !Task.isCancelled, await coordinator.claim(.deadline) else { return }
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { Darwin._exit(1) }
            await coordinator.cleanup()
        }

        do {
            let connection = try await HIDFIDOConnection()
            guard await coordinator.bind(connection) else {
                throw CancellationError()
            }
            _ = try AuthenticatorLocator.exactlyOne(expectedPath: identity.path)
            let session = try await CTAP2.Session.makeSession(connection: connection)
            let client = WebAuthn.Client(
                session: session,
                origin: request.origin,
                allowedExtensions: [],
                isPublicSuffix: AssertionRequest.isDefinitelyPublicSuffix
            )
            let driver = CeremonyDriver(
                client: client,
                request: request,
                prompter: prompter,
                cancellation: coordinator
            )
            let response = try await driver.run()
            let output = try response.toJSON()
            try request.validateResponseJSON(output)
            deadline.cancel()
            guard await coordinator.finish() else {
                throw CancellationError()
            }
            signals.cancel()
            FileHandle.standardOutput.write(output)
            FileHandle.standardOutput.write(Data([10]))
        } catch {
            deadline.cancel()
            await coordinator.cleanup()
            signals.cancel()
            switch await coordinator.terminalReason() {
            case .signal:
                writeStderr("assertion client canceled\n")
                Darwin.exit(2)
            case .deadline:
                throw AssertionRequestError.invalid("local assertion deadline expired")
            default:
                throw error
            }
        }
    }

    private static func readRequest() throws -> AssertionRequest {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard !data.isEmpty, data.count <= 1_048_576 else {
            throw AssertionRequestError.invalid("assertion request input is empty or too large")
        }
        return try AssertionRequest(json: data)
    }

    private static func humanMessage(_ error: Error) -> String {
        if let clientError = error as? WebAuthn.ClientError {
            switch clientError {
            case .pinAuthBlocked:
                return "PIN authentication is temporarily blocked; unplug and reinsert the key"
            case .pinBlocked:
                return "the key PIN is blocked and requires a FIDO reset"
            case .pinNotSet:
                return "user verification is required but this key has no PIN configured"
            case .forcePinChange:
                return "the authenticator requires a PIN change"
            case .timeout:
                return "the authenticator touch window expired"
            case .cancelled:
                return "the authenticator operation was cancelled"
            case .noCredentials:
                return "this key has none of the requested credentials"
            case .authenticatorNotAvailable:
                return "the authenticator disconnected or became unavailable"
            default:
                return String(describing: clientError)
            }
        }
        return error.localizedDescription
    }
}

await RemoteFidoAssert.run()
#endif
