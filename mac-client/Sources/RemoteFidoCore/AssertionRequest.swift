import Foundation
import YubiKit

public enum AssertionRequestError: Error, LocalizedError, Sendable {
    case invalid(String)

    public var errorDescription: String? {
        switch self {
        case .invalid(let message): message
        }
    }
}

public struct AssertionRequest: Sendable {
    public let origin: WebAuthn.Origin
    public let originString: String
    public let rpId: String
    public let timeoutMilliseconds: Int
    public let userVerification: WebAuthn.UserVerificationPreference
    public let userVerificationText: String
    public let allowedCredentialIDs: [Data]
    public let options: WebAuthn.Authentication.Options

    public init(json data: Data) throws {
        let wire: WireRequest
        do {
            wire = try JSONDecoder().decode(WireRequest.self, from: data)
        } catch {
            throw AssertionRequestError.invalid("invalid assertion request JSON: \(error)")
        }

        guard let parsedOrigin = try? WebAuthn.Origin(wire.origin),
              parsedOrigin.stringValue == wire.origin
        else {
            throw AssertionRequestError.invalid("origin must be a canonical secure origin")
        }
        guard !wire.options.rpId.isEmpty,
              wire.options.rpId.utf8.count <= 253,
              !wire.options.rpId.contains("\n"),
              !wire.options.rpId.contains("\0")
        else {
            throw AssertionRequestError.invalid("invalid relying-party ID")
        }
        let host = parsedOrigin.host.lowercased()
        let normalizedRpId = wire.options.rpId.lowercased()
        guard host == normalizedRpId || host.hasSuffix("." + normalizedRpId) else {
            throw AssertionRequestError.invalid("origin is not within the relying-party ID")
        }
        guard (30_000...300_000).contains(wire.options.timeout) else {
            throw AssertionRequestError.invalid("timeout must be between 30000 and 300000 ms")
        }
        guard (1...16).contains(wire.options.allowCredentials.count) else {
            throw AssertionRequestError.invalid("between one and 16 allowed credentials are required")
        }

        let challenge = try Self.decodeBase64URL(
            wire.options.challenge,
            label: "challenge",
            length: 16...1024
        )
        let credentialIDs = try wire.options.allowCredentials.map { descriptor in
            guard descriptor.type == "public-key" else {
                throw AssertionRequestError.invalid("allowed credential is not a public key")
            }
            return try Self.decodeBase64URL(
                descriptor.id,
                label: "credential ID",
                length: 1...1024
            )
        }

        let verification: WebAuthn.UserVerificationPreference
        switch wire.options.userVerification {
        case "required": verification = .required
        case "preferred": verification = .preferred
        case "discouraged": verification = .discouraged
        default:
            throw AssertionRequestError.invalid("invalid user-verification preference")
        }

        self.origin = parsedOrigin
        self.originString = wire.origin
        self.rpId = wire.options.rpId
        self.timeoutMilliseconds = wire.options.timeout
        self.userVerification = verification
        self.userVerificationText = wire.options.userVerification
        self.allowedCredentialIDs = credentialIDs
        self.options = WebAuthn.Authentication.Options(
            challenge: challenge,
            rpId: wire.options.rpId,
            allowCredentials: credentialIDs.map {
                WebAuthn.CredentialDescriptor(type: "public-key", id: $0)
            },
            userVerification: verification,
            timeout: nil,
            extensions: nil
        )
    }

    public var expectedClientDataJSON: Data {
        let challenge = options.challenge.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let values: [(String, String)] = [
            ("type", "webauthn.get"),
            ("challenge", challenge),
            ("origin", originString),
        ]
        let encoded = values.map { key, value in
            "\(Self.jsonString(key)):\(Self.jsonString(value))"
        }.joined(separator: ",")
        return Data("{\(encoded),\"crossOrigin\":false}".utf8)
    }

    public func validateResponseJSON(_ data: Data) throws {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              root["type"] as? String == "public-key",
              let identifier = root["id"] as? String,
              identifier == root["rawId"] as? String,
              root["authenticatorAttachment"] as? String == "cross-platform",
              let response = root["response"] as? [String: Any],
              let clientDataText = response["clientDataJSON"] as? String,
              let returnedClientData = try? Self.decodeBase64URL(
                  clientDataText,
                  label: "returned client data",
                  length: 1...4096
              ),
              returnedClientData == expectedClientDataJSON,
              let returnedCredential = try? Self.decodeBase64URL(
                  identifier,
                  label: "returned credential ID",
                  length: 1...1024
              ),
              allowedCredentialIDs.contains(returnedCredential),
              root["clientExtensionResults"] is [String: Any]
        else {
            throw AssertionRequestError.invalid("WebAuthn response is not bound to the request")
        }
    }

    /// The exporter has already validated the origin/RP suffix relationship.
    /// Reject obvious single-label public suffixes here; a future generic relay
    /// should replace this with a complete Public Suffix List implementation.
    public static func isDefinitelyPublicSuffix(_ candidate: String) -> Bool {
        !candidate.contains(".")
    }

    private static func decodeBase64URL(
        _ text: String,
        label: String,
        length: ClosedRange<Int>
    ) throws -> Data {
        guard !text.isEmpty,
              text.unicodeScalars.allSatisfy({
                  ("A"..."Z").contains(Character(String($0)))
                      || ("a"..."z").contains(Character(String($0)))
                      || ("0"..."9").contains(Character(String($0)))
                      || $0 == "-" || $0 == "_"
              })
        else {
            throw AssertionRequestError.invalid("\(label) is not canonical base64url")
        }
        var base64 = text.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64.append(String(repeating: "=", count: (4 - base64.count % 4) % 4))
        guard let decoded = Data(base64Encoded: base64), length.contains(decoded.count) else {
            throw AssertionRequestError.invalid("\(label) length is outside the accepted range")
        }
        return decoded
    }

    private static func jsonString(_ value: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
        return String(decoding: data, as: UTF8.self)
    }
}

private struct WireRequest: Decodable {
    let origin: String
    let options: WireOptions
}

private struct WireOptions: Decodable {
    let allowCredentials: [WireCredential]
    let challenge: String
    let rpId: String
    let timeout: Int
    let userVerification: String
}

private struct WireCredential: Decodable {
    let id: String
    let type: String
}
