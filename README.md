# DCode plugin SDK

Write plugins for DCode. A plugin is one WebAssembly file with two possible extension points:

- **diagram code blocks** (`renderBlock`): your plugin receives the source of a code block (for example a ```` ```dot ```` block) and returns an SVG picture. DCode shows the picture in chat and in documents, where it shows code blocks of the languages you declare.
- **file previews** (`renderFile`): your plugin receives a file that DCode cannot open itself (for example a `.sqlite` database) and returns an SVG picture or a static HTML page, shown in the file's tab in the workspace. The plugin declares the extensions it handles; the formats DCode previews itself (images, PDF, Word, Markdown, Mermaid) are not open to plugins.

A plugin cannot read files (a file previewer is handed the bytes of the one file it is asked about), open connections or keep data. The host gives it no capabilities at all, and what it returns is only displayed, never stored.

## What is here

| Path | What it is |
| --- | --- |
| [`SPEC.md`](SPEC.md) | **Plugin ABI 1**, the normative specification. Everything you need to write a plugin in any language that compiles to WebAssembly. |
| [`template/`](template) | A Rust crate to start from: the ABI glue is done, you write the renderer. |
| [`tools/check-plugin.mjs`](tools/check-plugin.mjs) | A checker for plugin authors: run it on your `.wasm` to see what `SPEC.md` would object to. Needs only Node 18 or newer. |
| [`examples/svgbob/`](examples/svgbob) | A plugin that wraps an existing library ([svgbob](https://github.com/ivanceras/svgbob), ASCII art to SVG). Written by an independent author who had only this SDK, as a check that it is enough; a worked example of adapting a web-oriented library to the SVG rules and of building for `wasm32-wasip1`. |
| [`plugins/graphviz-dot/`](plugins/graphviz-dot) | The reference plugin for code blocks: Graphviz 16.1.0 compiled with wasi-sdk, renders DOT (```` ```dot ````, ```` ```graphviz ````). |
| [`plugins/sqlite-overview/`](plugins/sqlite-overview) | The reference plugin for file previews: SQLite 3.54.1 compiled with wasi-sdk, shows the tables, the `CREATE` statements and the first rows of a `.sqlite`, `.sqlite3` or `.db` file as an HTML page. Public domain code (SQLite), MIT sources. |

## Write a plugin

1. Read [`SPEC.md`](SPEC.md). The conformance checklist at the end is what a finished plugin has to satisfy.
2. Copy [`template/`](template) and follow its [README](template/README.md). It covers the manifest, building, signing and installing.

In short, a plugin exports `dcode_plugin_abi_version`, `dcode_alloc` and `dcode_free`, plus `dcode_render_block` for a code-block renderer and `dcode_render_file` for a file previewer, and carries a JSON manifest in a custom section named `dcode.plugin`. The template is a code-block renderer; for a file previewer look at [`plugins/sqlite-overview/`](plugins/sqlite-overview), which has the same ABI glue and a `dcode_render_file` (written in C).

## Check

Before you sign and install, run the checker on your build:

```sh
node tools/check-plugin.mjs dist/my-plugin.wasm --dev --sample good.txt --bad-sample bad.txt --out preview
```

`--sample` is a source file in your plugin's language that must render and `--bad-sample` one with a mistake that must return `1` with a message; both can be repeated. For a file previewer the same two exist as `--file-sample` (a file the plugin must preview) and `--bad-file-sample` (for example a `.db` that is not a database, which must return `1` with a message):

```sh
node tools/check-plugin.mjs dist/my-previewer.wasm --dev --file-sample good.db --bad-file-sample notadb.db --out preview
```

The checker needs nothing but Node 18 or newer. It reads the module and the manifest, verifies the signature (leave out `--dev` once the plugin is signed), calls the plugin with each case in a fresh instance, with the host's limits and WASI answers (the 256 MiB maximum, which covers linear memory only, the 5 s limit, no WASI capabilities, the host's fixed `random_get` stream and error codes), and reports `PASS`, `WARN` or `FAIL` for each point of the [conformance checklist](SPEC.md#conformance-checklist) it can test: the exports and imports, the manifest, return codes and the `out` record, option handling, determinism, odd and huge inputs, and the SVG (well-formed XML, nothing the viewer would remove, ids, fonts) or, for a file previewer, the HTML page (nothing the viewer would remove, and 32 MiB files and damaged copies of your samples answered with a result, not a trap). `--out` writes every picture or page, light and dark, and an `index.html` to look at. A file previewer's HTML pages are written under the same content-security policy the viewer uses, without their `<link>` elements (a policy does not cover `dns-prefetch` and `preconnect`), and shown in sandboxed frames. That stops the page from loading anything, but it is not the viewer's sanitizing: a link stays in the page, and a browser may look up its host name ahead of time, and where a page depends on something the viewer removes, the checker says so while the preview looks different from DCode. It is a tool, not a test suite, and it cannot tell whether your pictures are right.

If you wrap an existing rendering library, expect to adapt its output: most produce SVG for a web page, with `<style>` blocks, CSS classes, named fonts, a background rectangle and ids that would clash when several pictures share a page. None of that is allowed ([SVG output](SPEC.md#svg-output)); turn it off if the library lets you, translate the rest to presentation attributes, and prefix the ids. [`examples/svgbob`](examples/svgbob) is a worked example. If a dependency pulls in `wasm-bindgen`, build for `wasm32-wasip1` ([Imports and WASI](SPEC.md#imports-and-wasi)).

### What a passing check means

- **The module and the manifest rules the host applies.** The manifest limits are `name` 100, `version` 64, `description` 2000, `homepage` 500 and each language 32, counted in UTF-16 code units (JavaScript's `String.length`, so `😀` counts 2), not in bytes. A non-empty `homepage` must parse with `new URL` as `http:` or `https:`. [SPEC.md](SPEC.md#manifest) has the full table.
- **Not a promise that every machine installs it.** The checker cannot see the public key a host remembers for your `id`, the languages and extensions other installed plugins already hold, or the state of the disk.
- **Stricter than the host on purpose.** It also rejects wrong argument handling, wrong export types, wrong return values and SVG or HTML content the viewer would remove. Do not compare the order or wording of its messages with `dcode plugin install`.
- **No sanitizing.** The host returns your SVG or HTML as you wrote it (it only limits the size and keeps HTML out of code blocks); the DCode client sanitizes the SVG and sandboxes the HTML. `--out` shows your output under the viewer's content-security policy but is not the client.
- **One engine at a time.** The checker compiles with the Node that runs it, so a different Node than your target host's may accept or refuse a feature differently: to predict a given host, run the checker on that host's own Node and V8. The feature table in [SPEC.md](SPEC.md#webassembly-features) was measured on Node 24.21.0 (V8 13.6); which Node a DCode build embeds comes from that build, and a host run from source runs under Bun.
- **Not a host simulation.** Up to four cases run in parallel, each in its own worker with its own 5 s timer: not the host's queue, compiled-module cache or GUI. `--show-log` prints what a call wrote with `fd_write` only when the call returns; the log of a call that traps or times out is not shown.

## Sign

DCode installs only signed plugins. Signatures are [minisign](https://jedisct1.github.io/minisign/) (Ed25519) signatures:

```sh
mkdir -p ~/.minisign
minisign -G -p my-plugin.pub -s ~/.minisign/my-plugin.key    # once; put the public key into plugin.json
minisign -S -s ~/.minisign/my-plugin.key -m plugin.wasm       # after every build; writes plugin.wasm.minisig
```

The public key goes in the manifest, so create the key before you build. DCode remembers the public key of the first version you install (the whole key, not just the key id) and accepts updates only from exactly that key: keep it safe. To change the key you must uninstall the plugin and install it again. Details are in [Signing](SPEC.md#signing).

## Install

```sh
dcode plugin install plugin.wasm            # looks for plugin.wasm.minisig next to it
dcode plugin install --dev plugin.wasm      # development: no signature needed, marked as a development build
dcode plugin list
```

`dcode plugin uninstall <id>`, `dcode plugin enable <id>` and `dcode plugin disable <id>` do the rest. Plugins are installed on the machine where the DCode host runs.

## License

This repository is under the [MIT License](LICENSE), with one exception: the **built** plugin `graphviz-dot.wasm` from `plugins/graphviz-dot/` contains Graphviz and is covered by the Eclipse Public License 2.0. See [`plugins/graphviz-dot/NOTICE.md`](plugins/graphviz-dot/NOTICE.md) and [`LICENSE-EPL-2.0.txt`](plugins/graphviz-dot/LICENSE-EPL-2.0.txt) there. The sources written for that plugin are MIT. The plugin `sqlite-overview.wasm` contains SQLite, which is in the public domain; its sources are MIT too (see [`plugins/sqlite-overview/NOTICE.md`](plugins/sqlite-overview/NOTICE.md)).
