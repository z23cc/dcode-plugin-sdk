# DCode plugin SDK

Write plugins for DCode. A plugin is one WebAssembly file; the first extension point is the **diagram code block**: your plugin receives the source of a code block (for example a ```` ```dot ```` block) and returns an SVG picture. DCode shows the picture in chat and in documents, where it shows code blocks of the languages you declare.

A plugin cannot read files, open connections or keep data. The host gives it no capabilities at all, and the picture it returns is only displayed, never stored.

## What is here

| Path | What it is |
| --- | --- |
| [`SPEC.md`](SPEC.md) | **Plugin ABI 1**, the normative specification. Everything you need to write a plugin in any language that compiles to WebAssembly. |
| [`template/`](template) | A Rust crate to start from: the ABI glue is done, you write the renderer. |
| [`plugins/graphviz-dot/`](plugins/graphviz-dot) | The reference plugin: renders Graphviz DOT (```` ```dot ````, ```` ```graphviz ````). |
| [`plugins/graphviz-dot-layout-rs/`](plugins/graphviz-dot-layout-rs) | A second DOT plugin, pure Rust on [`layout-rs`](https://crates.io/crates/layout-rs). Smaller, with less DOT coverage. |

## Write a plugin

1. Read [`SPEC.md`](SPEC.md). The conformance checklist at the end is what a finished plugin has to satisfy.
2. Copy [`template/`](template) and follow its [README](template/README.md). It covers the manifest, building, signing and installing.

In short, a plugin exports `dcode_plugin_abi_version`, `dcode_alloc`, `dcode_free` and `dcode_render_block`, and carries a JSON manifest in a custom section named `dcode.plugin`.

## Sign

DCode installs only signed plugins. Signatures are [minisign](https://jedisct1.github.io/minisign/) (Ed25519) signatures:

```sh
mkdir -p ~/.minisign
minisign -G -p my-plugin.pub -s ~/.minisign/my-plugin.key    # once; put the public key into plugin.json
minisign -S -s ~/.minisign/my-plugin.key -m plugin.wasm       # after every build; writes plugin.wasm.minisig
```

The public key goes in the manifest, so create the key before you build. DCode remembers the key of the first version you install and accepts updates only from the same key: keep it safe. Details are in [Signing](SPEC.md#signing).

## Install

```sh
dcode plugin install plugin.wasm            # looks for plugin.wasm.minisig next to it
dcode plugin install --dev plugin.wasm      # development: no signature needed, marked as a development build
dcode plugin list
```

`dcode plugin uninstall <id>`, `dcode plugin enable <id>` and `dcode plugin disable <id>` do the rest. Plugins are installed on the machine where the DCode host runs.

## License

Unless a directory carries its own license files, this repository is under the [MIT License](LICENSE). The built plugin in `plugins/graphviz-dot/` contains Graphviz, which is under the Eclipse Public License 1.0; see the license files in that directory.
