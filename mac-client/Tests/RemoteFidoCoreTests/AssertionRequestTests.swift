import Foundation
import Testing
@testable import RemoteFidoCore

private func requestJSON(
    origin: String = "https://auth.openai.com",
    rpId: String = "openai.com",
    timeout: Int = 180_000,
    verification: String = "required",
    credentialID: String = "FBUW"
) -> Data {
    Data("""
    {"origin":"\(origin)","options":{"allowCredentials":[{"id":"\(credentialID)","type":"public-key"}],"challenge":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","rpId":"\(rpId)","timeout":\(timeout),"userVerification":"\(verification)"}}
    """.utf8)
}

@Test func decodesExporterContract() throws {
    let request = try AssertionRequest(json: requestJSON())
    #expect(request.originString == "https://auth.openai.com")
    #expect(request.rpId == "openai.com")
    #expect(request.timeoutMilliseconds == 180_000)
    #expect(request.allowedCredentialIDs == [Data([0x14, 0x15, 0x16])])
}

@Test func clientDataMatchesBrowserOrdering() throws {
    let request = try AssertionRequest(json: requestJSON())
    #expect(String(decoding: request.expectedClientDataJSON, as: UTF8.self) ==
        "{\"type\":\"webauthn.get\",\"challenge\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"origin\":\"https:\\/\\/auth.openai.com\",\"crossOrigin\":false}")
}

@Test func rejectsPolicyDriftAndUnsafeInputs() {
    #expect(throws: Error.self) { try AssertionRequest(json: requestJSON(origin: "https://evil.example")) }
    #expect(throws: Error.self) { try AssertionRequest(json: requestJSON(timeout: 29_999)) }
    #expect(throws: Error.self) { try AssertionRequest(json: requestJSON(verification: "maybe")) }
    #expect(throws: Error.self) { try AssertionRequest(json: requestJSON(credentialID: "bad=")) }
}

@Test func validatesBoundResponseAndAllowsMissingUserHandle() throws {
    let request = try AssertionRequest(json: requestJSON())
    let clientData = request.expectedClientDataJSON.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    let response = Data("""
    {"authenticatorAttachment":"cross-platform","clientExtensionResults":{},"id":"FBUW","rawId":"FBUW","response":{"authenticatorData":"AQ","clientDataJSON":"\(clientData)","signature":"Ag"},"type":"public-key"}
    """.utf8)
    try request.validateResponseJSON(response)
}
