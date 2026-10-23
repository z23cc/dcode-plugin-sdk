# DCode plugin SDK

Write plugins for DCode. A plugin is one WebAssembly file; the first extension point is the **diagram code block**: your plugin receives the source of a code block (for example a ```` ```dot ```` block) and returns an SVG picture. DCode shows the picture in chat and in documents, where it shows code blocks of the languages you declare.

A plugin cannot read files, open connections or keep data. The host gives it no capabilities at all, and the picture it returns is only displayed, never stored.

## What is here

| Path | What it is |
| --- | --- |
| [`SPEC.md`](SPEC.md) | **Plugin ABI 1**, the normative specification. Everything you need to write a plugin in any language that compiles to WebAssembly. |
| [`template/`](template) | A Rust crate to start from: the ABI glue is done, you write the renderer. |
| [`tools/check-plugin.mjs`](tools/check-plugin.mjs) | A checker for plugin authors: run it on your `.wasm` to see what `SPEC.md` would object to. Needs only Node 18 or newer. |
| [`examples/svgbob/`](examples/svgbob) | A plugin that wraps an existing library ([svgbob](https://github.com/ivanceras/svgbob), ASCII art to SVG). Written by an independent author who had only this SDK, as a check that it is enough; a worked example of adapting a web-oriented library to the SVG rules and of building for `wasm32-wasip1`. |
| [`plugins/graphviz-dot/`](plugins/graphviz-dot) | The reference plugin: Graphviz 16.1.0 compiled with wasi-sdk, renders DOT (```` ```dot ````, ```` ```graphviz ````). |

## Write a plugin

1. Read [`SPEC.md`](SPEC.md). The conformance checklist at the end is what a finished plugin has to satisfy.
2. Copy [`template/`](template) and follow its [README](template/README.md). It covers the manifest, building, signing and installing.

In short, a plugin exports `dcode_plugin_abi_version`, `dcode_alloc`, `dcode_free` and `dcode_render_block`, and carries a JSON manifest in a custom section named `dcode.plugin`.

## Check

Before you sign and install, run the checker on your build:

```sh
node tools/check-plugin.mjs dist/my-plugin.wasm --dev --sample good.txt --bad-sample bad.txt --out preview
```

`--sample` is a source file in your plugin's language that must render and `--bad-sample` one with a mistake that must return `1` with a message; both can be repeated. The checker needs nothing but Node 18 or newer. It reads the module and the manifest, verifies the signature (leave out `--dev` once the plugin is signed), calls the plugin the way the host does (a fresh instance per call, the 256 MiB memory maximum, the 5 s limit, no WASI capabilities), and reports `PASS`, `WARN` or `FAIL` for each point of the [conformance checklist](SPEC.md#conformance-checklist) it can test: the exports and imports, the manifest, return codes and the `out` record, option handling, determinism, odd and huge inputs, and the SVG (well-formed XML, nothing the host would remove, ids, fonts). `--out` writes every picture, light and dark, and an `index.html` to look at. It is a tool, not a test suite, and it cannot tell whether your pictures are right.

If you wrap an existing rendering library, expect to adapt its output: most produce SVG for a web page, with `<style>` blocks, CSS classes, named fonts, a background rectangle and ids that would clash when several pictures share a page. None of that is allowed ([SVG output](SPEC.md#svg-output)); turn it off if the library lets you, translate the rest to presentation attributes, and prefix the ids. [`examples/svgbob`](examples/svgbob) is a worked example. If a dependency pulls in `wasm-bindgen`, build for `wasm32-wasip1` ([Imports and WASI](SPEC.md#imports-and-wasi)).

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

This repository is under the [MIT License](LICENSE), with one exception: the **built** plugin `graphviz-dot.wasm` from `plugins/graphviz-dot/` contains Graphviz and is covered by the Eclipse Public License 2.0. See [`plugins/graphviz-dot/NOTICE.md`](plugins/graphviz-dot/NOTICE.md) and [`LICENSE-EPL-2.0.txt`](plugins/graphviz-dot/LICENSE-EPL-2.0.txt) there. The sources written for that plugin are MIT.
