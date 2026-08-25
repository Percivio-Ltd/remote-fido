#if os(macOS)
import Darwin
import Dispatch
import Foundation
import RemoteFidoCore
import YubiKit

private enum SecureTTYError: Error, LocalizedError {
    case unavailable
    case readFailed(Int32)
    case tooLong
    case cancelled

    var errorDescription: String? {
        switch self {
        case .unavailable: "no controlling Terminal is available for PIN entry"
        case .readFailed(let code): "could not read the PIN from the Terminal (errno \(code))"
        case .tooLong: "PIN input exceeded 255 bytes"
        case .cancelled: "PIN entry was cancelled"
        }
    }
}

private final class SecureTTYRead: @unchecked Sendable {
    private let lock = NSLock()
    private let fd: Int32
    private var original = termios()
    private var source: DispatchSourceRead?
    private var continuation: CheckedContinuation<String, Error>?
    private var bytes = Data()
    private var finished = false

    init(prompt: String) throws {
        fd = Darwin.open("/dev/tty", O_RDWR | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw SecureTTYError.unavailable }
        guard tcgetattr(fd, &original) == 0 else {
            Darwin.close(fd)
            throw SecureTTYError.unavailable
        }
        var hidden = original
        hidden.c_lflag &= ~tcflag_t(ECHO)
        guard tcsetattr(fd, TCSAFLUSH, &hidden) == 0 else {
            Darwin.close(fd)
            throw SecureTTYError.unavailable
        }
        _ = prompt.withCString { Darwin.write(fd, $0, strlen($0)) }
    }

    func value() async throws -> String {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                self.continuation = continuation
                let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .global())
                self.source = source
                source.setEventHandler { [weak self] in self?.readAvailable() }
                source.resume()
                lock.unlock()
            }
        } onCancel: {
            self.cancel()
        }
    }

    func cancel() {
        finish(.failure(SecureTTYError.cancelled))
    }

    private func readAvailable() {
        var buffer = [UInt8](repeating: 0, count: 256)
        let count = Darwin.read(fd, &buffer, buffer.count)
        if count > 0 {
            bytes.append(buffer, count: count)
            if bytes.count > 256 {
                finish(.failure(SecureTTYError.tooLong))
                return
            }
            if let newline = bytes.firstIndex(where: { $0 == 10 || $0 == 13 }) {
                let line = bytes.prefix(upTo: newline)
                guard let value = String(data: line, encoding: .utf8) else {
                    finish(.failure(SecureTTYError.readFailed(EILSEQ)))
                    return
                }
                finish(.success(value))
            }
        } else if count == 0 {
            finish(.failure(SecureTTYError.cancelled))
        } else if errno != EAGAIN && errno != EINTR {
            finish(.failure(SecureTTYError.readFailed(errno)))
        }
    }

    private func finish(_ result: Result<String, Error>) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        finished = true
        let continuation = self.continuation
        self.continuation = nil
        let source = self.source
        self.source = nil
        var restore = original
        _ = tcsetattr(fd, TCSAFLUSH, &restore)
        _ = Darwin.write(fd, "\n", 1)
        source?.cancel()
        Darwin.close(fd)
        lock.unlock()
        continuation?.resume(with: result)
    }
}

actor TerminalPrompter: RemoteFidoPrompter {
    private var activeRead: SecureTTYRead?
    private var retriesRemaining: Int?

    func setPINRetriesRemaining(_ value: Int?) {
        retriesRemaining = value
    }

    func requestPIN(retriesRemaining _: Int?) async -> WebAuthn.Authorization.PINReply {
        let suffix = self.retriesRemaining.map { " (\($0) retries remain)" } ?? ""
        while true {
            do {
                let read = try SecureTTYRead(prompt: "YubiKey PIN\(suffix): ")
                activeRead = read
                let pin = try await read.value()
                activeRead = nil
                guard (4...63).contains(pin.utf8.count) else {
                    showNotice("PIN must contain between 4 and 63 UTF-8 bytes; the key was not tried.")
                    continue
                }
                return .pin(pin)
            } catch {
                activeRead = nil
                showNotice("PIN entry failed: \(error.localizedDescription)")
                return .cancel
            }
        }
    }

    nonisolated func showTouchPrompt() {
        writeStderr("\u{7}TOUCH YUBIKEY NOW — touch once while the key glows.\n")
    }

    nonisolated func showVerificationPrompt() {
        writeStderr("\u{7}VERIFY ON YUBIKEY NOW.\n")
    }

    nonisolated func showNotice(_ message: String) {
        writeStderr(message + "\n")
    }

    func cancelCurrent() {
        activeRead?.cancel()
        activeRead = nil
    }
}

func writeStderr(_ text: String) {
    FileHandle.standardError.write(Data(text.utf8))
}
#endif
