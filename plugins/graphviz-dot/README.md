# Graphviz DOT plugin

Renders ` ```dot ` and ` ```graphviz ` code blocks with [Graphviz](https://graphviz.org) 16.1.0. It is the reference plugin for [Plugin ABI 1](../../SPEC.md): a real C program (Graphviz's `dot` layout and SVG renderer) compiled to WebAssembly with [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) as a WASI reactor, with a thin C front end that implements the ABI.

- id: `io.github.z23cc.graphviz-dot`, languages: `dot`, `graphviz`
- one `.wasm` file, about 745 KiB (277 KiB gzipped); imports only `wasi_snapshot_preview1`, exports `_initialize` and the four `dcode_*` functions
- **License: the binary is covered by the Eclipse Public License 2.0** because it contains Graphviz. See [NOTICE.md](NOTICE.md) and [LICENSE-EPL-2.0.txt](LICENSE-EPL-2.0.txt). The sources written for this plugin are MIT, like the rest of the repository.

## Install

```sh
dcode plugin install graphviz-dot.wasm          # signed release: needs graphviz-dot.wasm.minisig next to it
dcode plugin install --dev graphviz-dot.wasm    # a build you made yourself, unsigned
```

## What it does

- **Layout:** the `dot` engine, always. A `layout=neato` (or `fdp`, ...) attribute in the source is ignored.
- **Output:** one SVG per block, no background (a `bgcolor` you set is honored), text in generic font families (`sans-serif`, `serif`, `monospace`) chosen from the `fontname` you give (default Helvetica, so `sans-serif`). Graphviz measures text with its built-in metric tables, so the layout does not depend on any installed font; the browser's font may be slightly wider or narrower.
- **Themes:** `theme: "dark"` turns the default black ink (lines, arrowheads, text, cluster borders) into light grey. Anything you set yourself is left alone. Two conveniences on top: text on a node with an explicit fill is black or white, whichever reads better, unless you set `fontcolor`; and ink inside a cluster follows the cluster's fill, so a `style=filled color=lightgrey` cluster stays readable on a dark page.
- **Clusters, records, ports, `rank=same`, `rankdir`, `splines` (including `ortho`), edge labels, the full set of shapes and arrowheads** work as in Graphviz.
- **Syntax errors** return `1` with Graphviz's message, for example `syntax error in line 4 near ';'`. Graphviz reports where it noticed the problem, which can be a line after the mistake (an unclosed `[` or string, a missing `}` at the end of the input).
- **Ids** in the SVG are prefixed with a hash of the source and theme, so several diagrams can share a page.
- Graphviz warnings (unknown shape, unknown arrow type, ...) go to the plugin log (`fd_write` to stderr), not to the user.

## What it does not do

| Not supported | What happens |
| --- | --- |
| HTML-like labels (`label=<...>`) | Returns `1`: "HTML-like labels (label=<...>) are not supported by this plugin; use plain or record labels". This build has no XML parser (no expat). |
| Other layout engines (`neato`, `fdp`, `circo`, ...) | The `layout` attribute is ignored and `dot` is used. |
| `URL`, `href`, `image`, `stylesheet`, `shapefile` and similar | Blanked before rendering, so the SVG has no links, images or external references. |
| Other output formats | SVG only. |
| Absurd numeric values | `minlen`, `penwidth`, `margin`, `ratio`, `peripheries`, ... are clamped to a generous maximum (for example `minlen` 100, `penwidth` 20). Without it a value like `minlen=99999999` or `margin=inf` hangs or crashes Graphviz. |

## Limits we measured

Measured on an Apple Silicon laptop with Node 24, one fresh instance per call, memory capped at 256 MiB, on generated graphs of the shapes below. Your numbers will differ with the machine and the shape of the graph.

| Graph | Nodes | Time | SVG size |
| --- | ---: | ---: | ---: |
| Typical agent diagram, clusters and labels | 15 to 300 | 1 to 23 ms | 12 to 216 KB |
| Layered, 20 per rank | 5,000 | 0.9 s | 4.0 MB |
| Layered, 20 per rank | 8,000 | 2.2 s | 6.4 MB |
| Balanced binary tree | 12,000 | 0.8 s | 7.2 MB |
| Random DAG with long edges | 5,000 | 3.5 s | 4.0 MB |
| Random DAG with long edges | 8,000 | 10.5 s | over the 5 s limit |

Memory stays far below the limit (64 MiB at 12,000 nodes). The practical ceiling is the host's **8 MiB output limit**: Graphviz writes roughly 0.8 KB of SVG per node, so about 10,000 nodes. A layered graph of 12,000 nodes takes 5.4 s and 9.7 MB and is refused.

A first render in a fresh process takes 6 to 9 ms (the engine compiles functions lazily); later renders take 0.1 to 0.4 ms for small graphs.

## Build

You need `make`, `xxd`, `curl` and a POSIX shell. Everything else is downloaded, pinned and checksum-verified.

```sh
./fetch-toolchain.sh                 # wasi-sdk 34.0 -> ~/.local/opt, Graphviz 16.1.0 source -> ~/.local/src
make                                 # -> dist/graphviz-dot.wasm
minisign -S -m dist/graphviz-dot.wasm   # -> dist/graphviz-dot.wasm.minisig
```

`fetch-toolchain.sh` records the SHA-256 of every archive and unpacks them outside this repository; nothing from the unpacked trees is run. `make` compiles the needed Graphviz sources one by one (no `configure`, no libtool) with the hand-written `config.h`, links a reactor module, and embeds `plugin.json` as the `dcode.plugin` custom section.

The build is reproducible: compiling with the toolchain in two different directories gives byte-identical files.

### Files

| File | Purpose |
| --- | --- |
| `src/plugin.c` | The Plugin ABI 1 front end: exports, option parsing, theme handling, error capture, SVG clean-up |
| `src/builtins.c` | Registers the `dot` layout engine and the SVG renderer statically, since there is no `dlopen` |
| `config.h` | Replaces the file `./configure` would generate: no dynamic loading, no cairo, pango, fontconfig, expat or zlib |
| `Makefile` | The list of Graphviz sources and the compile and link flags |
| `fetch-toolchain.sh` | Pinned, checksum-verified download of wasi-sdk and Graphviz |
| `plugin.json` | The manifest |
| `examples/` | The DOT inputs used to check the plugin: 26 that render and 6 with syntax errors |

### WebAssembly features used

Mutable globals, sign-extension, non-trapping float-to-int, multi-value, bulk memory and reference types: what wasi-sdk 34 emits by default. No exceptions (Graphviz only uses `setjmp` in `gvpr`, which is not part of this build), no threads, no SIMD. See "WebAssembly features" in [SPEC.md](../../SPEC.md).
