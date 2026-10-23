#!/bin/sh
# Build dist/<package-name>.wasm.
# Sign it afterwards with `minisign -S -m dist/<package-name>.wasm` (see README.md).
set -eu
cd "$(dirname "$0")"

# The first `name = ` in Cargo.toml is the package name. Cargo names the output
# after it, with `-` turned into `_`.
name=$(sed -n 's/^name = "\(.*\)"/\1/p' Cargo.toml | head -n 1)
lib=$(echo "$name" | tr - _)

# Keep this machine's paths out of the binary (panic messages embed them).
# Without this, two builds on two machines differ and leak a home directory.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=/home --remap-path-prefix=$(pwd)=."
cargo build --release --locked

mkdir -p dist
cp "target/wasm32-unknown-unknown/release/$lib.wasm" "dist/$name.wasm"
echo "built dist/$name.wasm ($(wc -c < "dist/$name.wasm") bytes, $(gzip -9 -c "dist/$name.wasm" | wc -c) gzipped)"
