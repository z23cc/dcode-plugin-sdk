# DCode plugin template (Rust)

A starting point for a DCode plugin written in Rust. The example plugin claims the code-block language `textbox` and draws the block's text inside a box. Replace `render` in `src/lib.rs` with your own code.

A plugin can have two extension points: code blocks (`renderBlock`, what this template does) and file previews (`renderFile`: DCode hands the plugin a file it cannot open itself, and the plugin returns an SVG or HTML page). A file previewer has the same ABI glue and a `dcode_render_file` function with a manifest key `renderFile` instead; see [`SPEC.md`](../SPEC.md) and the C example [`plugins/sqlite-overview/`](../plugins/sqlite-overview).

The contract this crate follows is in [`SPEC.md`](../SPEC.md) at the root of the repository (Plugin ABI 1). Read it once; the comments in `src/lib.rs` point to the parts that matter.

What is in the crate:

| File | What it is |
| --- | --- |
| `src/lib.rs` | The ABI glue (`dcode_plugin_abi_version`, `dcode_alloc`, `dcode_free`, `DcodeBuf`, the helper that hands a result to the host) and the example `dcode_render_block` / `render`. |
| `plugin.json` | The manifest. It is embedded in the `.wasm` file as the custom section `dcode.plugin`. |
| `Cargo.toml` | `cdylib`, and a release profile tuned for size. |
| `.cargo/config.toml` | Makes `wasm32-unknown-unknown` the default target, so `cargo build --release` is enough. |
| `build.sh` | `cargo build` plus a copy to `dist/`, with this machine's paths removed from the binary. |

## 1. Prerequisites

- Rust with the WebAssembly target: `rustup target add wasm32-unknown-unknown`
- [minisign](https://jedisct1.github.io/minisign/), to create a key and sign
- The `dcode` command line tool, to install the plugin
- Node 18 or newer, only to run `tools/check-plugin.mjs`

## 2. Make it yours

Copy this directory out of the repository, then:

1. In `Cargo.toml`, change `name` to your plugin's name.
2. In `plugin.json`, change:
   - `id`: reverse-domain notation is recommended (`io.github.your-name.text-box`). The rule is `^[a-z0-9]+([.-][a-z0-9]+)*$`, at most 64 characters. It identifies your plugin for good, so pick it once.
   - `name`, `version`, `description`, `homepage`. The host refuses a `name` over 100, a `version` over 64 (it must be `1.2.3`, with an optional `-pre` and `+build`), a `description` over 2000 and a `homepage` over 500 characters, counted in UTF-16 code units; a `homepage` must be an `http://` or `https://` address, or left out.
   - `renderBlock.languages`: the code-block languages you handle (1 to 16 entries, each at most 32 characters; lowercase letters, digits, `+`, `-`). Claiming `mermaid` or `wireframe` replaces DCode's own drawing of it. A language can belong to only one installed plugin.
   - `publicKey`: see the next step. The value in the template belongs to nobody; no signature can match it.
3. Write your renderer in `src/lib.rs`.
4. Regenerate the lock file. The crate rename (the lock file records the package name) and every dependency you add change it, and `build.sh` builds with `--locked`, which refuses to update it and stops with `cannot update the lock file` (exit status 101):

   ```sh
   cargo generate-lockfile
   ```

   Commit `Cargo.lock` afterwards: plugins are libraries, and a locked build is what makes the file reproducible.

## 3. Make a signing key

DCode only installs signed plugins (apart from [development mode](#6-install)), and the signature has to match the `publicKey` in the manifest. Create the key **before** you build, because the manifest is part of the signed file:

```sh
mkdir -p ~/.minisign
minisign -G -p my-plugin.pub -s ~/.minisign/my-plugin.key
```

- Put the secret key somewhere outside your project, and **back it up**. DCode remembers which public key signed the first version of a plugin (the whole 32-byte key, not the key id that `minisign` shows) and refuses updates signed with any other key. If you lose the key, you cannot update that plugin: users would have to uninstall it and install a new one, which then remembers the new key.
- Never commit the secret key. The `.gitignore` in this template ignores `*.key` as a second line of defence.
- `my-plugin.pub` has two lines. Copy the **second** one (it starts with `RW`) into `publicKey` in `plugin.json`:

```sh
cat my-plugin.pub
# untrusted comment: minisign public key: ...
# RWQ...                      <-- this line
```

## 4. Build

```sh
cargo build --release
# -> target/wasm32-unknown-unknown/release/<name>.wasm
```

or

```sh
./build.sh
# -> dist/<name>.wasm
```

`build.sh` uses `--locked` (so commit `Cargo.lock`) and strips local paths from the binary.

Look at what you built:

```sh
wasm-tools print dist/<name>.wasm | grep -E '^\s*\((import|export|@custom)'
```

You should see the memory and the four `dcode_*` exports, a `dcode.plugin` custom section with your manifest, and no imports at all. (`wasm-tools` is optional; it comes from `cargo install wasm-tools`.)

### Check it

`tools/check-plugin.mjs` in the SDK repository checks a plugin against `SPEC.md` without a DCode host. It needs only Node 18 or newer. Give it a source file in your plugin's language that should render, and one with a mistake that should not:

```sh
node path/to/tools/check-plugin.mjs dist/<name>.wasm --dev --sample good.txt --bad-sample bad.txt --out preview
```

It checks the module (memory, exports, imports, manifest), calls the plugin in a fresh instance for every case with the same memory and time limits as the host, checks the return codes and the SVG, throws odd inputs at it, and writes the pictures, in both themes, to `preview/index.html`. Drop `--dev` once the plugin is signed: it then also verifies the signature. Fix every `FAIL` line; `WARN` lines are advice.

### If `build.sh` builds but the plugin has imports

If you add a dependency and the check (or `dcode plugin install`) lists imports from `__wbindgen_placeholder__`, `__wbindgen_externref_xform__` or `env`, a crate in your dependency tree has pulled in `wasm-bindgen`, which assumes a browser, and the plugin would be refused. Build for `wasm32-wasip1` instead:

```sh
rustup target add wasm32-wasip1
```

In `.cargo/config.toml` change `target` to `wasm32-wasip1` and rename the `[target.wasm32-unknown-unknown]` table to `[target.wasm32-wasip1]`; in `build.sh` change `target/wasm32-unknown-unknown/release` to `target/wasm32-wasip1/release`. The module then imports only a few allowed functions of `wasi_snapshot_preview1` (`random_get`, `fd_write`, `proc_exit` and the like) instead of browser glue, and gets an `_initialize` export, which the host calls. See [Imports and WASI](../SPEC.md#imports-and-wasi). `examples/svgbob` in the repository is built this way.

### Wrapping an existing library

Many rendering libraries write SVG for a web page: a `<style>` block, CSS classes, a named font, a background rectangle, ids like `arrow` that two pictures on a page would share. `SPEC.md` forbids all of that ([SVG output](../SPEC.md#svg-output)), and the viewer removes it anyway, so the picture would come out wrong. If the library has options to switch the CSS and the backdrop off, use them; then translate what is left (classes become presentation attributes such as `fill`, `stroke` and `stroke-dasharray`), choose a generic font family and prefix the ids. `examples/svgbob` shows how for the `svgbob` crate. A library that panics or exhausts memory on large input needs limits of your own: return `1` with a message ([Limits](../SPEC.md#limits)).

## 5. Sign

Sign the file you are going to ship, **after** its last change. A rebuild, or any other change to the `.wasm`, means signing again.

```sh
minisign -S -s ~/.minisign/my-plugin.key -m dist/<name>.wasm
# -> dist/<name>.wasm.minisig
```

Keep `<name>.wasm.minisig` next to `<name>.wasm` and keep its name; install looks for it there. Publish the two files together.

## 6. Install

```sh
dcode plugin install dist/<name>.wasm
dcode plugin list
```

DCode shows the key id of your key at install time (the value `minisign` writes in the comment of your `.pub` file). Then put a block like this in a chat message or a document:

````
```textbox
Hello, DCode
```
````

**While you develop**, skip signing:

```sh
dcode plugin install --dev dist/<name>.wasm
```

A development install does not check the signature and is marked as a development version in the user interface. An `id` can exist only once, either as a development version or as a signed one; remove one before installing the other.

The other commands are `dcode plugin uninstall <id>`, `dcode plugin enable <id>` and `dcode plugin disable <id>`.

## Releasing an update

Raise `version` in `plugin.json`, rebuild, sign **with the same key**, and install the new file. A different key is refused, whatever the version. The one way to change a plugin's key is to ask users to uninstall it first and then install the new file.

## Before you publish

Run `tools/check-plugin.mjs` (see [Check it](#check-it)) and go through the [conformance checklist](../SPEC.md#conformance-checklist) in `SPEC.md`. The points people most often miss: return `1` (not a panic) for wrong source; no scripts, `foreignObject`, `<style>`, `style` attributes, external references or named fonts in the SVG; prefix every `id` in the SVG; and make output depend only on the inputs.
