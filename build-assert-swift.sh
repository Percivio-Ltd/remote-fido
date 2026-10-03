#!/bin/zsh

set -euo pipefail

script_dir=${0:A:h}
package_dir="$script_dir/mac-client"
output_dir="$script_dir/build"

/bin/mkdir -p "$output_dir"
/usr/bin/xcrun swift build --package-path "$package_dir" -c release --arch arm64
/usr/bin/xcrun swift build --package-path "$package_dir" -c release --arch x86_64

arm_binary="$package_dir/.build/arm64-apple-macosx/release/remote-fido-assert"
intel_binary="$package_dir/.build/x86_64-apple-macosx/release/remote-fido-assert"
output="$output_dir/remote-fido-assert"

/usr/bin/lipo -create "$arm_binary" "$intel_binary" -output "$output"
/usr/bin/codesign --force --sign - --options runtime "$output"
/bin/chmod 0755 "$output"

hash=$(/usr/bin/shasum -a 256 "$output" | /usr/bin/awk '{print $1}')
print -- "$hash  build/remote-fido-assert" > "$script_dir/SHA256SUMS"
print -- "BUILT $output"
print -- "SHA256 $hash"
