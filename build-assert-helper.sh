#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
output=${1:-$script_dir/build/remote-fido-assert}
pkg_config=${PKG_CONFIG:-}

if [[ -z $pkg_config ]]; then
  for candidate in "${commands[pkg-config]:-}" \
      /opt/homebrew/bin/pkg-config /usr/local/bin/pkg-config; do
    if [[ -n $candidate && -x $candidate ]]; then
      pkg_config=$candidate
      break
    fi
  done
fi

if [[ -z $pkg_config || ! -x $pkg_config ]]; then
  print -u2 "pkg-config is required (install Homebrew pkgconf/libfido2)"
  exit 1
fi

mkdir -p -- ${output:h}
compile_flags=("${(@s: :)$($pkg_config --cflags libfido2)}")
link_flags=("${(@s: :)$($pkg_config --libs libfido2)}")

xcrun clang \
  -std=c11 \
  -Wall -Wextra -Werror \
  -O2 \
  $compile_flags \
  "$script_dir/assert-helper.c" \
  $link_flags \
  -o "$output"
codesign --force --sign - "$output"
codesign --verify --strict "$output"
"$output" --self-test
print "built $output"
