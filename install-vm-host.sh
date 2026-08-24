#!/bin/zsh

set -euo pipefail

script_dir=${0:A:h}
source_version=$(<"$script_dir/VERSION")
extension_id=agnmnnemjpbpgjambapffefalbmengaf
native_host_name=de.lytiq.remote_fido
install_dir="$HOME/Library/Application Support/LYTiQ/Remote FIDO"
manifest_dir="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
manifest_path="$manifest_dir/$native_host_name.json"
chrome_app="/Applications/Google Chrome.app"
connect_ip=""
port=9471
apply=0

usage() {
  print -u2 -- "usage: ${0:t} --connect TAILSCALE_IP [--port PORT] [--apply]"
}

while (( $# )); do
  case "$1" in
    --connect) shift; connect_ip=${1:-} ;;
    --port) shift; port=${1:-} ;;
    --apply) apply=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
  shift
done

if [[ "$connect_ip" != 100.<64-127>.<0-255>.<0-255> ||
      "$port" != <1-65535> ]]; then
  print -u2 -- "STOP connect must be a Tailscale IPv4 address and port must be valid"
  exit 64
fi
if [[ ! -d "$chrome_app" ]]; then
  print -u2 -- "STOP Google Chrome is not installed"
  exit 1
fi
chrome_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$chrome_app/Contents/Info.plist")
autoload -Uz is-at-least
if ! is-at-least 115 "$chrome_version"; then
  print -u2 -- "STOP Chrome $chrome_version predates webAuthenticationProxy support"
  exit 2
fi

node_bin=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
  [[ -x "$candidate" ]] && node_bin=$candidate && break
done
if [[ -z "$node_bin" ]]; then
  print -u2 -- "STOP Node.js is required in Homebrew or ~/.local/bin"
  exit 1
fi

if [[ -r "$install_dir/VERSION" ]]; then
  installed_version=$(<"$install_dir/VERSION")
  if is-at-least "$source_version" "$installed_version" &&
      [[ "$installed_version" != "$source_version" ]]; then
    print -u2 -- "WARNING target already has newer remote FIDO $installed_version"
    print -u2 -- "STOP source $source_version was not installed"
    exit 3
  fi
fi
if [[ -e "$manifest_path" ]]; then
  existing_name=$(/usr/bin/plutil -extract name raw -o - "$manifest_path" 2>/dev/null || true)
  existing_origin=$(/usr/bin/plutil -extract allowed_origins.0 raw -o - "$manifest_path" 2>/dev/null || true)
  if [[ "$existing_name" != "$native_host_name" ||
        "$existing_origin" != "chrome-extension://$extension_id/" ]]; then
    print -u2 -- "WARNING $manifest_path belongs to a different native host"
    print -u2 -- "STOP existing Chrome integration was not overwritten"
    exit 3
  fi
fi

print -- "MATCH Chrome $chrome_version"
print -- "MATCH Node.js $($node_bin --version)"
print -- "TARGET exporter=$connect_ip:$port"
print -- "TARGET extension=$extension_id"
print -- "TARGET native-host=$manifest_path"
if (( ! apply )); then
  print -- "WOULD INSTALL remote FIDO $source_version for the current user"
  print -- "WOULD NOT load or approve the unpacked Chrome extension"
  exit 0
fi

/bin/mkdir -p "$install_dir/extension" "$manifest_dir"
/usr/bin/install -m 0644 "$script_dir/VERSION" "$install_dir/VERSION"
/usr/bin/install -m 0644 "$script_dir/protocol.mjs" "$install_dir/protocol.mjs"
/usr/bin/install -m 0755 "$script_dir/native-host.mjs" "$install_dir/native-host.mjs"
/usr/bin/install -m 0755 "$script_dir/native-host-wrapper" "$install_dir/native-host-wrapper"
/usr/bin/install -m 0755 "$script_dir/probe-native-host.mjs" "$install_dir/probe-native-host.mjs"
/usr/bin/install -m 0644 "$script_dir/extension/manifest.json" "$install_dir/extension/manifest.json"
/usr/bin/install -m 0644 "$script_dir/extension/service-worker.js" "$install_dir/extension/service-worker.js"

config_path="$install_dir/config.json"
/usr/bin/plutil -create xml1 "$config_path"
/usr/bin/plutil -insert connect -string "$connect_ip" "$config_path"
/usr/bin/plutil -insert port -integer "$port" "$config_path"
/usr/bin/plutil -convert json "$config_path"
/bin/chmod 0600 "$config_path"

/usr/bin/plutil -create xml1 "$manifest_path"
/usr/bin/plutil -insert name -string "$native_host_name" "$manifest_path"
/usr/bin/plutil -insert description -string "LYTiQ remote FIDO over Tailscale" "$manifest_path"
/usr/bin/plutil -insert path -string "$install_dir/native-host-wrapper" "$manifest_path"
/usr/bin/plutil -insert type -string stdio "$manifest_path"
/usr/bin/plutil -insert allowed_origins -json \
  "[\"chrome-extension://$extension_id/\"]" "$manifest_path"
/usr/bin/plutil -convert json "$manifest_path"
/bin/chmod 0600 "$manifest_path"

print -- "INSTALLED remote FIDO $source_version"
print -- "EXTENSION PATH $install_dir/extension"
print -- "STOPPED before Chrome extension approval"
