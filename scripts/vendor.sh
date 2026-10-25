#!/bin/zsh
# Prepares vendor/bin for development and packaging:
#   pcm-out   — compiled from native/pcm-out.swift
#   librespot — copied from Homebrew (it links only system frameworks)
set -e
ROOT="${0:A:h:h}"
OUT="$ROOT/vendor/bin"
mkdir -p "$OUT"

xcrun swiftc -O -o "$OUT/pcm-out" "$ROOT/native/pcm-out.swift"

LIBRESPOT="$(command -v librespot || true)"
if [[ -z "$LIBRESPOT" ]]; then
  print -u2 "librespot not found. Install it first: brew install librespot"
  exit 1
fi
install -m 755 "$(readlink -f "$LIBRESPOT")" "$OUT/librespot"
chmod +x "$OUT/librespot" "$OUT/pcm-out"

# Anything outside system libraries would break on other Macs.
for bin in "$OUT"/*; do
  if otool -L "$bin" | tail -n +2 | grep -v -E '^\s+(/System/|/usr/lib/)' | grep -q .; then
    print -u2 "$bin links non-system libraries:"
    otool -L "$bin" | tail -n +2 | grep -v -E '^\s+(/System/|/usr/lib/)' >&2
    exit 1
  fi
done
print "vendor/bin ready: $(ls "$OUT" | tr '\n' ' ')"
