#!/bin/zsh

set -euo pipefail

script_dir=${0:A:h}
source_version=$(<"$script_dir/VERSION")
install_dir="$HOME/Library/Application Support/LYTiQ/Remote FIDO Exporter"
desktop_launcher="$HOME/Desktop/Remote FIDO Exporter.command"
cli_launcher="$HOME/bin/remote-fido"
allow_client=""
port=9471
apply=0
desktop=0

usage() {
  print -u2 -- "usage: ${0:t} --allow-client TAILSCALE_IP [--port PORT] [--desktop] [--apply]"
}

while (( $# )); do
  case "$1" in
    --allow-client) shift; allow_client=${1:-} ;;
    --port) shift; port=${1:-} ;;
    --desktop) desktop=1 ;;
    --apply) apply=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
  shift
done

if [[ "$allow_client" != 100.<64-127>.<0-255>.<0-255> ||
      "$port" != <1-65535> ]]; then
  print -u2 -- "STOP allow-client must be a Tailscale IPv4 address and port must be valid"
  exit 64
fi

autoload -Uz is-at-least
if [[ -r "$install_dir/VERSION" ]]; then
  installed_version=$(<"$install_dir/VERSION")
  if is-at-least "$source_version" "$installed_version" &&
      [[ "$installed_version" != "$source_version" ]]; then
    print -u2 -- "WARNING target already has newer remote FIDO exporter $installed_version"
    print -u2 -- "STOP source $source_version was not installed"
    exit 3
  fi
fi

node_bin=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
  [[ -x "$candidate" ]] && node_bin=$candidate && break
done
tailscale_bin=""
for candidate in /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do
  [[ -x "$candidate" ]] && tailscale_bin=$candidate && break
done
assert_bin="$script_dir/build/remote-fido-assert"

if [[ -z "$node_bin" || -z "$tailscale_bin" || ! -x "$assert_bin" ]]; then
  print -u2 -- "STOP Node.js, Tailscale, and build/remote-fido-assert are required"
  exit 1
fi
if ! (cd "$script_dir" && /usr/bin/shasum -a 256 -c SHA256SUMS >/dev/null); then
  print -u2 -- "STOP native assertion client checksum verification failed"
  exit 1
fi
if (( desktop )) && [[ -e "$desktop_launcher" &&
    ! -L "$desktop_launcher" ]]; then
  print -u2 -- "WARNING desktop launcher already exists and is not a symlink"
  print -u2 -- "STOP existing launcher was not overwritten"
  exit 3
fi
if [[ -e "$cli_launcher" && ! -L "$cli_launcher" ]]; then
  print -u2 -- "WARNING command launcher already exists and is not a symlink"
  print -u2 -- "STOP existing $cli_launcher was not overwritten"
  exit 3
fi

print -- "MATCH Node.js $($node_bin --version)"
print -- "MATCH native assertion client $(/usr/bin/shasum -a 256 "$assert_bin" | /usr/bin/awk '{print $1}')"
print -- "TARGET exporter=$install_dir"
print -- "TARGET client=$allow_client:$port"
print -- "TARGET command=$cli_launcher"
(( desktop )) && print -- "TARGET launcher=$desktop_launcher"
if (( ! apply )); then
  print -- "WOULD INSTALL remote FIDO exporter $source_version"
  exit 0
fi

/bin/mkdir -p "$install_dir/LICENSES"
/usr/bin/install -m 0644 "$script_dir/VERSION" "$install_dir/VERSION"
/usr/bin/install -m 0755 "$script_dir/exporter.mjs" "$install_dir/exporter.mjs"
/usr/bin/install -m 0644 "$script_dir/protocol.mjs" "$install_dir/protocol.mjs"
/usr/bin/install -m 0755 "$assert_bin" "$install_dir/remote-fido-assert"
/usr/bin/install -m 0755 "$script_dir/run-exporter.command" "$install_dir/run-exporter.command"
/usr/bin/install -m 0644 "$script_dir/THIRD_PARTY_NOTICES.md" \
  "$install_dir/THIRD_PARTY_NOTICES.md"
/usr/bin/install -m 0644 "$script_dir/LICENSES/Apache-2.0.txt" \
  "$install_dir/LICENSES/Apache-2.0.txt"

config_path="$install_dir/config.json"
/usr/bin/plutil -create xml1 "$config_path"
/usr/bin/plutil -insert allowClient -string "$allow_client" "$config_path"
/usr/bin/plutil -insert port -integer "$port" "$config_path"
/usr/bin/plutil -convert json "$config_path"
/bin/chmod 0600 "$config_path"

/bin/rm -rf "$install_dir/.venv"
/bin/rm -f "$install_dir/assert-client.py" "$install_dir/touch-probe.py" \
  "$install_dir/requirements.txt"

if (( desktop )); then
  /bin/rm -f "$desktop_launcher"
  /bin/ln -s "$install_dir/run-exporter.command" "$desktop_launcher"
fi
/bin/mkdir -p "${cli_launcher:h}"
/bin/rm -f "$cli_launcher"
/bin/ln -s "$install_dir/run-exporter.command" "$cli_launcher"

print -- "INSTALLED remote FIDO exporter $source_version"
print -- "LAUNCH $cli_launcher"
