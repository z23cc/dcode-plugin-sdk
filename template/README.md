# DCode plugin template (Rust)

A starting point for a DCode plugin written in Rust. The example plugin claims the code-block language `textbox` and draws the block's text inside a box. Replace `render` in `src/lib.rs` with your own code.

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

## 2. Make it yours

Copy this directory out of the repository, then:

1. In `Cargo.toml`, change `name` to your plugin's name.
2. In `plugin.json`, change:
   - `id`: reverse-domain notation is recommended (`io.github.your-name.text-box`). The rule is `^[a-z0-9]+([.-][a-z0-9]+)*$`, at most 64 characters. It identifies your plugin for good, so pick it once.
   - `name`, `version`, `description`, `homepage`.
   - `renderBlock.languages`: the code-block languages you handle (1 to 16 entries; lowercase letters, digits, `+`, `-`). `mermaid` and `wireframe` are taken. A language can belong to only one installed plugin.
   - `publicKey`: see the next step. The value in the template belongs to nobody; no signature can match it.
3. Write your renderer in `src/lib.rs`.

## 3. Make a signing key

DCode only installs signed plugins (apart from [development mode](#6-install)), and the signature has to match the `publicKey` in the manifest. Create the key **before** you build, because the manifest is part of the signed file:

```sh
mkdir -p ~/.minisign
minisign -G -p my-plugin.pub -s ~/.minisign/my-plugin.key
```

- Put the secret key somewhere outside your project, and **back it up**. DCode remembers which key signed the first version of a plugin and refuses updates signed with any other key. If you lose the key, you cannot update that plugin.
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

Raise `version` in `plugin.json`, rebuild, sign **with the same key**, and install the new file. A different key is refused.

## Before you publish

Go through the [conformance checklist](../SPEC.md#conformance-checklist) in `SPEC.md`. The points people most often miss: return `1` (not a panic) for wrong source; no scripts, `foreignObject`, external references or named fonts in the SVG; prefix every `id` in the SVG; and make output depend only on the inputs.
