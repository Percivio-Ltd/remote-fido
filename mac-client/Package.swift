// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "RemoteFidoMacClient",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
    ],
    products: [
        .library(name: "RemoteFidoCore", targets: ["RemoteFidoCore"]),
        .executable(name: "remote-fido-assert", targets: ["RemoteFidoAssert"]),
    ],
    dependencies: [
        .package(url: "https://github.com/Yubico/yubikit-swift.git", exact: "1.3.0"),
    ],
    targets: [
        .target(
            name: "RemoteFidoCore",
            dependencies: [
                .product(name: "YubiKit", package: "yubikit-swift"),
            ]
        ),
        .target(
            name: "RemoteFidoHID",
            dependencies: ["RemoteFidoCore"],
            linkerSettings: [
                .linkedFramework("IOKit"),
            ]
        ),
        .executableTarget(
            name: "RemoteFidoAssert",
            dependencies: [
                "RemoteFidoCore",
                "RemoteFidoHID",
                .product(name: "YubiKit", package: "yubikit-swift"),
            ]
        ),
        .testTarget(
            name: "RemoteFidoCoreTests",
            dependencies: ["RemoteFidoCore"]
        ),
    ]
)
