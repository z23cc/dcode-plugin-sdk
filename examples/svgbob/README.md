# svgbob plugin (example)

Renders ` ```bob ` code blocks, ASCII-art diagrams, as SVG with [svgbob](https://github.com/ivanceras/svgbob) 0.7.6.

````markdown
```bob
+-------+     +-------+
| Input |---->|  SVG  |
+-------+     +-------+
```
````

This is a plugin that **wraps an existing library**. It was written by an independent author, an AI agent that was given only this SDK and no knowledge of DCode's internals, as a check that the SDK is enough to build, sign and verify a plugin. Their notes on what was hard fed back into `SPEC.md`, the template and `tools/check-plugin.mjs`. The source is kept here as a worked example of integrating a library that was written for web pages.

## What it shows

- **A library whose SVG breaks the rules.** svgbob's default output has a `<style>` block, CSS classes for arrowheads and dashed lines, a named font, a full-size backdrop, and ids that two diagrams on one page would share. The plugin turns svgbob's styling off and then translates its classes into presentation attributes (`fill`, `stroke`, `stroke-dasharray`, `marker-end`), uses `monospace`, draws no backdrop, and prefixes the marker ids with `bob-` and a hash of the source and theme. See `paint` in `src/lib.rs`.
- **Building for `wasm32-wasip1`.** Built for `wasm32-unknown-unknown`, this plugin's dependency tree pulls in `wasm-bindgen` (svgbob uses `sauron`, which assumes a browser) and the module imports browser glue, which is refused at install time. For `wasm32-wasip1` the same code imports only five allowed functions of `wasi_snapshot_preview1` (`random_get`, `environ_get`, `environ_sizes_get`, `fd_write`, `proc_exit`). The target is set in `.cargo/config.toml`.
- **Limits of its own.** 8192 bytes, 128 lines, 256 columns per line (tabs count as four) and 2048 non-blank characters. A larger block returns `1` with a message that says which limit was hit, long before the host's 1 MiB transport limit or the 5 s time limit matter. CSS legends (`# Legend:`) are not supported and return `1`.
- **Input handling.** Characters that XML 1.0 forbids are replaced by spaces; a null pointer with a non-zero length returns `-1`; an unknown theme means light.
- **The memory maximum**, 256 MiB, declared in the module (`--max-memory=268435456`), so that a local run fails where the host would.

Plugin language `bob`, id `io.github.local.svgbob`.

## Build, check, sign

You need Rust with the `wasm32-wasip1` target (`rustup target add wasm32-wasip1`), Node 18 or newer, and [minisign](https://jedisct1.github.io/minisign/).

```sh
./build.sh                                    # -> dist/dcode-plugin-svgbob.wasm
node ../../tools/check-plugin.mjs dist/dcode-plugin-svgbob.wasm --dev \
  --sample samples/diagram.bob --bad-sample samples/legend.bob --out dist/preview
```

`./build.sh` uses the committed `Cargo.lock`. If you change the crate name or the dependencies, run `cargo generate-lockfile` first, as the [template README](../../template/README.md) says.

The `publicKey` in `plugin.json` belongs to a disposable key that was made for the exercise; its secret key is not part of this repository. **Make your own key** (`minisign -G`), put the public key into `plugin.json`, build, and sign (`minisign -S -m dist/dcode-plugin-svgbob.wasm`). Then drop `--dev` from the check, and it verifies the signature too. For a quick try without a key: `dcode plugin install --dev dist/dcode-plugin-svgbob.wasm`.

## License

The code in this directory is MIT licensed, like the rest of this repository. **svgbob is licensed under the Apache License 2.0**, and its dependencies have their own licenses; see [NOTICE.md](NOTICE.md) for the list and for what you must include if you distribute a built `.wasm`.
