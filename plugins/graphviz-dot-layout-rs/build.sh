#!/bin/sh
# Build dist/graphviz-dot-layout-rs.wasm. Sign it afterwards with `minisign -S -m dist/graphviz-dot-layout-rs.wasm`.
set -eu
cd "$(dirname "$0")"

# Keep this machine's paths out of panic messages embedded in the binary.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=/home --remap-path-prefix=$(pwd)=."
cargo build --release --locked

mkdir -p dist
cp target/wasm32-unknown-unknown/release/graphviz_dot_layout_rs.wasm dist/graphviz-dot-layout-rs.wasm
echo "built dist/graphviz-dot-layout-rs.wasm ($(wc -c < dist/graphviz-dot-layout-rs.wasm) bytes, $(gzip -9 -c dist/graphviz-dot-layout-rs.wasm | wc -c) gzipped)"
