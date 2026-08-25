#!/bin/zsh

set -euo pipefail

runtime_dir=${0:A:h}
config_path="$runtime_dir/config.json"
version=$(<"$runtime_dir/VERSION")

if [[ ! -r "$config_path" ]]; then
  print -u2 -- "STOP missing exporter configuration: $config_path"
  exit 1
fi

allow_client=$(/usr/bin/plutil -extract allowClient raw -o - "$config_path")
port=$(/usr/bin/plutil -extract port raw -o - "$config_path")
if [[ "$allow_client" != 100.<64-127>.<0-255>.<0-255> ||
      "$port" != <1-65535> ]]; then
  print -u2 -- "STOP exporter configuration is invalid"
  exit 64
fi

node_bin=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
  [[ -x "$candidate" ]] && node_bin=$candidate && break
done
tailscale_bin=""
for candidate in /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do
  [[ -x "$candidate" ]] && tailscale_bin=$candidate && break
done
token_bin=""
for candidate in /opt/homebrew/bin/fido2-token /usr/local/bin/fido2-token; do
  [[ -x "$candidate" ]] && token_bin=$candidate && break
done
python_bin="$runtime_dir/.venv/bin/python"

for required in "$node_bin" "$tailscale_bin" "$token_bin" "$python_bin"; do
  if [[ -z "$required" || ! -x "$required" ]]; then
    print -u2 -- "STOP the installed Remote FIDO runtime is incomplete"
    exit 1
  fi
done

device_output=$($token_bin -L)
devices=("${(@f)device_output}")
devices=("${(@)devices:#}")
if (( ${#devices} != 1 )); then
  print -u2 -- "STOP exactly one FIDO authenticator is required; found ${#devices}"
  exit 2
fi

print -- "REMOTE FIDO $version"
print -- "KEY ${devices[1]}"
print -- "CLIENT $allow_client"
print -- "The PIN and touch stay on this Mac. Press Control-C to stop."

$tailscale_bin serve --bg --yes --tcp="$port" --proxy-protocol=1 \
  "tcp://127.0.0.1:$port"

export REMOTE_FIDO_ASSERT_MODE=python
export REMOTE_FIDO_PYTHON="$python_bin"
export FIDO2_TOKEN_BIN="$token_bin"
exec "$node_bin" "$runtime_dir/exporter.mjs" \
  --listen 127.0.0.1 \
  --proxy-protocol 1 \
  --allow-client "$allow_client" \
  --port "$port"
