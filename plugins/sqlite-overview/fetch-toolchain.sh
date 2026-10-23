#!/bin/sh
# Fetches the pinned build inputs for this plugin and unpacks them OUTSIDE the
# repository:
#
#   wasi-sdk 34.0               https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34
#   SQLite 3.54.1 amalgamation  https://sqlite.org/download.html
#
# Every archive is checked against the SHA-256 recorded below *before* it is
# unpacked, and nothing from the unpacked trees is executed here. Needs curl,
# tar, unzip and a POSIX shell.
#
#   ./fetch-toolchain.sh [PREFIX]        # default PREFIX is $HOME/.local
#
# Result:  $PREFIX/opt/wasi-sdk-34.0   and   $PREFIX/src/sqlite-amalgamation-3540100
# Then:    make WASI_SDK=$PREFIX/opt/wasi-sdk-34.0 SQLITE_SRC=$PREFIX/src/sqlite-amalgamation-3540100
set -eu

WASI_SDK_VERSION=34.0
SQLITE_VERSION=3.54.1
SQLITE_FILE=sqlite-amalgamation-3540100
# From the wasi-sdk-34 release page (asset digests).
WASI_SDK_SHA256_arm64_macos=9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9
WASI_SDK_SHA256_x86_64_macos=87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb
WASI_SDK_SHA256_arm64_linux=f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971
WASI_SDK_SHA256_x86_64_linux=b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4
# sqlite.org publishes SHA3-256 only (92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30,
# size 2990966, in the download page's product list); this SHA-256 was computed from that
# very file after the SHA3-256 matched.
SQLITE_SHA256=0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9

PREFIX=${1:-$HOME/.local}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)               PLATFORM=arm64-macos;   WASI_SHA=$WASI_SDK_SHA256_arm64_macos ;;
  Darwin-x86_64)              PLATFORM=x86_64-macos;  WASI_SHA=$WASI_SDK_SHA256_x86_64_macos ;;
  Linux-aarch64|Linux-arm64)  PLATFORM=arm64-linux;   WASI_SHA=$WASI_SDK_SHA256_arm64_linux ;;
  Linux-x86_64)               PLATFORM=x86_64-linux;  WASI_SHA=$WASI_SDK_SHA256_x86_64_linux ;;
  *) echo "no pinned wasi-sdk for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

fetch() { # url, sha256, archive name, destination dir, kind (tgz|zip)
  dest=$4
  if [ -e "$dest" ]; then echo "$dest already exists, leaving it alone"; return; fi
  tmp=$(mktemp -d)
  echo "downloading $1"
  curl -fsSL --retry 3 -o "$tmp/$3" "$1"
  got=$(sha256 "$tmp/$3")
  if [ "$got" != "$2" ]; then
    echo "SHA-256 mismatch for $3: expected $2, got $got" >&2
    rm -rf "$tmp"; exit 1
  fi
  mkdir -p "$dest"
  case $5 in
    tgz) tar -xzf "$tmp/$3" -C "$dest" --strip-components=1 ;;
    zip) mkdir "$tmp/x"; unzip -q "$tmp/$3" -d "$tmp/x"; mv "$tmp/x"/*/* "$dest" ;;
  esac
  rm -rf "$tmp"
  echo "unpacked $dest"
}

fetch "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION%.*}/wasi-sdk-${WASI_SDK_VERSION}-${PLATFORM}.tar.gz" \
  "$WASI_SHA" "wasi-sdk-${WASI_SDK_VERSION}-${PLATFORM}.tar.gz" "$PREFIX/opt/wasi-sdk-${WASI_SDK_VERSION}" tgz

fetch "https://sqlite.org/2026/${SQLITE_FILE}.zip" \
  "$SQLITE_SHA256" "${SQLITE_FILE}.zip" "$PREFIX/src/${SQLITE_FILE}" zip

echo
echo "next: make WASI_SDK=$PREFIX/opt/wasi-sdk-${WASI_SDK_VERSION} SQLITE_SRC=$PREFIX/src/${SQLITE_FILE}"
