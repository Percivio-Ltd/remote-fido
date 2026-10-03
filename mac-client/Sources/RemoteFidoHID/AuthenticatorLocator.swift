#if os(macOS)
import Foundation
import IOKit
import IOKit.hid

public enum AuthenticatorLocatorError: Error, LocalizedError, Sendable {
    case managerOpen(IOReturn)
    case expectedOne(Int)
    case expectedPath(String)

    public var errorDescription: String? {
        switch self {
        case .managerOpen(let code):
            "could not enumerate FIDO HID devices (IOKit \(code))"
        case .expectedOne(let count):
            "exactly one FIDO authenticator is required; found \(count)"
        case .expectedPath(let path):
            "the attached authenticator no longer matches \(path)"
        }
    }
}

public struct AuthenticatorIdentity: Codable, Equatable, Sendable {
    public let path: String
    public let name: String
    public let vendorID: Int?
    public let productID: Int?
    public let locationID: Int?
    public let serialNumber: String?

    public var displayLine: String {
        let product = if let vendorID, let productID {
            String(format: "%04x:%04x", vendorID, productID)
        } else {
            "unknown product"
        }
        return "\(path): \(name) [\(product)]"
    }
}

public enum AuthenticatorLocator {
    public static func list() throws -> [AuthenticatorIdentity] {
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        let filter: [String: Any] = [
            kIOHIDDeviceUsagePageKey as String: 0xF1D0,
            kIOHIDDeviceUsageKey as String: 0x01,
        ]
        IOHIDManagerSetDeviceMatching(manager, filter as CFDictionary)
        let result = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        guard result == kIOReturnSuccess else {
            throw AuthenticatorLocatorError.managerOpen(result)
        }
        defer { IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone)) }

        guard let devices = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice> else {
            return []
        }
        return devices.compactMap(identity).sorted { $0.path < $1.path }
    }

    public static func exactlyOne(expectedPath: String? = nil) throws -> AuthenticatorIdentity {
        let devices = try list()
        guard devices.count == 1, let device = devices.first else {
            throw AuthenticatorLocatorError.expectedOne(devices.count)
        }
        if let expectedPath, device.path != expectedPath {
            throw AuthenticatorLocatorError.expectedPath(expectedPath)
        }
        return device
    }

    private static func identity(_ device: IOHIDDevice) -> AuthenticatorIdentity? {
        let service = IOHIDDeviceGetService(device)
        var registryID: UInt64 = 0
        guard IORegistryEntryGetRegistryEntryID(service, &registryID) == kIOReturnSuccess else {
            return nil
        }
        let name = property(device, kIOHIDProductKey) as? String ?? "FIDO authenticator"
        return AuthenticatorIdentity(
            path: "ioreg://\(registryID)",
            name: name,
            vendorID: numberProperty(device, kIOHIDVendorIDKey),
            productID: numberProperty(device, kIOHIDProductIDKey),
            locationID: numberProperty(device, kIOHIDLocationIDKey),
            serialNumber: property(device, kIOHIDSerialNumberKey) as? String
        )
    }

    private static func property(_ device: IOHIDDevice, _ key: String) -> Any? {
        IOHIDDeviceGetProperty(device, key as CFString)
    }

    private static func numberProperty(_ device: IOHIDDevice, _ key: String) -> Int? {
        (property(device, key) as? NSNumber)?.intValue
    }
}
#endif
