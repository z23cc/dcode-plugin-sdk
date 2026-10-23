# Graphviz DOT plugin, layout-rs build (fallback)

A pure-Rust implementation of the DOT renderer for [Plugin ABI 1](../../SPEC.md), built on the [`layout-rs`](https://github.com/nadavrot/layout) crate. It was written first, as the lightweight option, and is kept as a fallback for the Graphviz build in [`../graphviz-dot`](../graphviz-dot). It uses its own id (`io.github.z23cc.graphviz-dot-layout-rs`), so both can exist side by side, but only one can own the `dot` and `graphviz` languages at a time.

- one `.wasm` file, about 190 KiB (77 KiB gzipped), no imports
- licensed MIT, together with its dependencies (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md))

## How it differs from the Graphviz build

| | layout-rs build | Graphviz build |
| --- | --- | --- |
| Clusters (`subgraph cluster_*`) | **Not drawn**: subgraphs are flattened, no box and no label | Drawn, nested, with labels and fills |
| Node shapes | `box`, `circle` (drawn as an ellipse), `doublecircle`, `record`, `Mrecord`; every other shape becomes an ellipse | All of them |
| `rankdir` | `TB` and `LR`; `BT` and `RL` act as `TB` | All four |
| `rank=same`, `splines`, `nodesep`, `ranksep`, `bgcolor` | Ignored | Honored |
| HTML-like labels | Not supported | Not supported (returns `1` with a message) |
| Identifiers | Unquoted identifiers are ASCII only | Unicode |
| Size limit | Slows sharply with size: 500 nodes take about 1 s, 1,000 nodes of a layered graph take more than 15 s | 8,000 nodes in 2 s (layered) |
| Syntax error messages | Terse (`port`, `Unknown token`), with the line | Graphviz's own messages, with the line |

Use the Graphviz build unless you need a plugin that is MIT licensed and small.

## Build

```sh
./build.sh                                  # needs Rust and the wasm32-unknown-unknown target
minisign -S -m dist/graphviz-dot-layout-rs.wasm
```

`src/svg.rs` is a theme-aware SVG backend that replaces layout-rs's own writer (which draws black on transparent, uses `context-stroke` markers and writes an empty `<textPath>` per edge); `src/lib.rs` is the ABI front end.
