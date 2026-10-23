# DCode Plugin ABI 1

**Plugin ABI 1** is the contract between a DCode plugin and the DCode host. A plugin is a single WebAssembly file; the host loads it, asks it to turn code blocks into pictures, and gives it nothing else.

**This document is normative.** If the README, the template, a plugin or a host implementation disagrees with it, this document is the reference and the other one has a bug. It is written so that you can build a plugin from it alone, without knowing how DCode is implemented.

The words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

## Contents

- [Overview](#overview)
- [Module shape](#module-shape)
- [WebAssembly features](#webassembly-features)
- [Exports](#exports)
- [`dcode_buf`](#dcode_buf)
- [`dcode_render_block` and return values](#dcode_render_block-and-return-values)
- [Options](#options)
- [Imports and WASI](#imports-and-wasi)
- [Manifest](#manifest)
- [Signing](#signing)
- [Limits](#limits)
- [State and re-entrancy](#state-and-re-entrancy)
- [SVG output](#svg-output)
- [Versioning](#versioning)
- [Conformance checklist](#conformance-checklist)

## Overview

A plugin is:

- one `.wasm` file, a WebAssembly core module, which carries its own manifest in a custom section named `dcode.plugin`;
- next to it, a `.minisig` signature file made with [minisign](https://jedisct1.github.io/minisign/).

Plugin ABI 1 has one extension point, the **block renderer**. The manifest lists the code-block languages the plugin handles (for example `dot`). When DCode shows a code block in one of those languages (in a chat message, or in a document in the viewer or the editor), it calls the plugin with the block's source and gets back an SVG picture, or an error message for the person who wrote the block.

Three properties of the platform shape everything below:

- **The host gives plugins no capabilities.** A plugin has no files, no network, no real clock and no environment. The only things it can do are compute and return text. A plugin that tries to import anything else is refused at install time.
- **Plugins only affect display.** What DCode stores is the plain code block. A plugin's output is shown, cached and thrown away; it is never written into a document. When a plugin is missing, disabled or removed, the block is shown as ordinary code and nothing breaks.
- **Every call is independent.** The host creates a fresh instance of the module for each call and discards it afterwards.

## Module shape

A plugin MUST be a WebAssembly **core module**. It MUST NOT be a component. It can be built for `wasm32-unknown-unknown`, or for `wasm32-wasip1` (the target of wasi-sdk and of Rust's `wasm32-wasip1`).

- The module MUST define exactly one linear memory, and MUST export it with the name `memory`. The memory MUST be 32-bit (`wasm32`) and MUST NOT be shared. It MUST be defined by the module, not imported. Its initial size MUST NOT exceed the memory limit (see [Limits](#limits)).
- The module MUST be a **library (reactor)**, not a **command**.
  - If it exports `_initialize` (wasi-sdk and Rust's `wasm32-wasip1` do this for libraries; it initializes libc and static constructors), the host calls `_initialize` exactly once, after instantiation and before any other export.
  - If it exports `_start`, it is a command (it ends by calling `proc_exit`) and is **rejected at install time**.
  - The module MAY have a start section. It runs during instantiation.
  - The time spent in the start section and in `_initialize` counts toward the time limit of the call.
- The host ignores exports other than those listed in [Exports](#exports) and `_initialize`.

*Non-normative.* In Rust, `crate-type = ["cdylib"]` with the `wasm32-unknown-unknown` target gives a suitable module without `_initialize`; see `template/`. With wasi-sdk, build a reactor (`-mexec-model=reactor`) and export the functions below by name.

## WebAssembly features

The host compiles a plugin with the WebAssembly engine of Node.js 24 (V8 13.6), with default settings and no flags. ABI 1 has no feature list of its own: a module that uses something the engine does not accept fails to compile and is **refused at install time**. The memory rules in [Module shape](#module-shape) apply on top of that.

Compilation was checked on Node 24.21.0 with one small module per feature:

| Feature | Accepted by the engine | Notes |
| --- | --- | --- |
| Core 1.0, mutable globals | yes | |
| Sign-extension operators | yes | Emitted by default by Rust and wasi-sdk |
| Non-trapping float-to-int | yes | Emitted by default by Rust and wasi-sdk |
| Multi-value | yes | Emitted by default by Rust and wasi-sdk |
| Bulk memory | yes | Emitted by default by Rust and wasi-sdk (`memory.copy`, `memory.fill`) |
| Reference types | yes | Emitted by default by Rust and wasi-sdk (explicit table index in `call_indirect`) |
| Fixed-width SIMD (128-bit), relaxed SIMD | yes | |
| Tail calls | yes | |
| Exception handling, `try_table`/`exnref` form | yes | The legacy `try`/`catch` form was not tested |
| Extended constant expressions | yes | |
| GC | yes | |
| Multiple memories, 64-bit memory, shared memory and atomics | yes, in the engine | **Not allowed by ABI 1**: the module must have exactly one 32-bit, non-shared memory |

The first six rows are the set that current toolchains emit without being asked: Rust 1.97 for `wasm32-unknown-unknown` and wasi-sdk 34 for `wasm32-wasip1` emit nothing beyond these, and so does the Graphviz reference plugin. **A plugin SHOULD stay within the first six rows.** The engine of a future host may differ from today's.

A plugin cannot use threads: a call runs on one thread, and shared memory is refused.

## Exports

A plugin MUST export these four functions and the memory:

| Export | Kind | WebAssembly type |
| --- | --- | --- |
| `memory` | memory | one 32-bit linear memory |
| `dcode_plugin_abi_version` | function | `() -> i32` |
| `dcode_alloc` | function | `(i32) -> i32` |
| `dcode_free` | function | `(i32, i32) -> ()` |
| `dcode_render_block` | function | `(i32, i32, i32, i32, i32, i32, i32) -> i32` |

The signatures in C. On `wasm32`, pointers and `size_t` are 32 bits wide, and the WebAssembly types above follow from that.

```c
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint8_t *ptr;
    size_t   len;
} dcode_buf;                                  /* 8 bytes on wasm32 */

uint32_t dcode_plugin_abi_version(void);
uint8_t *dcode_alloc(size_t len);
void     dcode_free(uint8_t *ptr, size_t len);

int32_t  dcode_render_block(const uint8_t *lang_ptr, size_t lang_len,   /* UTF-8 */
                            const uint8_t *src_ptr,  size_t src_len,    /* UTF-8 */
                            const uint8_t *opts_ptr, size_t opts_len,   /* UTF-8 JSON */
                            dcode_buf *out);
```

The same signatures in Rust (function bodies omitted; `usize` is 32 bits on `wasm32`):

```rust
#[repr(C)]
pub struct DcodeBuf {
    ptr: *mut u8,
    len: usize,
}

#[no_mangle]
pub extern "C" fn dcode_plugin_abi_version() -> u32;

#[no_mangle]
pub extern "C" fn dcode_alloc(len: usize) -> *mut u8;

#[no_mangle]
pub unsafe extern "C" fn dcode_free(ptr: *mut u8, len: usize);

#[no_mangle]
pub unsafe extern "C" fn dcode_render_block(
    lang_ptr: *const u8, lang_len: usize,
    src_ptr: *const u8, src_len: usize,
    opts_ptr: *const u8, opts_len: usize,
    out: *mut DcodeBuf,
) -> i32;
```

### `dcode_plugin_abi_version`

Returns `1`. The manifest's `abi` field MUST be the same number. The host calls this function once, in a fresh instance, as the last step of installation, and refuses the plugin if the result is not `1` or does not equal `abi`.

### `dcode_alloc`

Returns a pointer to `len` writable bytes in the plugin's memory, or null when the memory cannot be allocated. The host uses it to place the inputs of `dcode_render_block` in the plugin's memory.

- For `len == 0` it MUST return a **non-null** pointer. Null always means failure.
- The pointer needs no alignment beyond 1 byte.

### `dcode_free`

`dcode_free(ptr, len)` releases memory. It MUST be able to release:

- memory returned by `dcode_alloc(len)`; and
- the buffer that `dcode_render_block` left in `out` (see [`dcode_buf`](#dcode_buf)).

In both cases `len` is exactly the length the memory was created with. `dcode_free(ptr, 0)` MUST be harmless. The plugin may therefore use any allocator, as long as it can free by `(ptr, len)`.

## `dcode_buf`

`dcode_buf` is a pair of 32-bit little-endian integers, 8 bytes in total:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | `ptr`: address of the first byte in the plugin's memory |
| 4 | 4 | `len`: length in bytes |

- The `out` argument of `dcode_render_block` points to such a record. **Its address has no alignment guarantee**, so the plugin MUST write it with unaligned stores (in Rust, `ptr::write_unaligned`).
- The plugin allocates the bytes `ptr` points to. After reading them the host calls `dcode_free(ptr, len)`. The buffer MUST therefore be freeable with exactly that pair: `len` MUST be the size of the allocation, not the size of the part that is used. A Rust `Vec` with spare capacity does not qualify; a boxed slice does.
- A buffer of length 0 is allowed; its pointer MUST be non-null.

## `dcode_render_block` and return values

```c
int32_t dcode_render_block(lang, src, opts, out);
```

| Argument | Meaning |
| --- | --- |
| `lang_ptr`, `lang_len` | The language of the code block, UTF-8: **exactly one of the lowercase strings the plugin declared in its manifest**. The host matches languages case-insensitively by converting the block's language to lower case before it looks for a plugin, so a block fenced as `DOT` or `Dot` reaches a plugin that declared `dot`, and `lang` is `dot`. A plugin that declares more than one language can use `lang` to tell them apart. |
| `src_ptr`, `src_len` | The source text of the block: the text between the fences, UTF-8, at most 1 MiB (1,048,576 **bytes** of UTF-8, not characters). Lines may end in `\n` or `\r\n`. |
| `opts_ptr`, `opts_len` | The options, a UTF-8 JSON object. See [Options](#options). |
| `out` | Where to put the result: a [`dcode_buf`](#dcode_buf). |

The three inputs are owned by the host: the plugin MUST NOT free them or keep pointers to them after returning.

*How the host calls a plugin.* The host instantiates the module (the start section runs), calls `_initialize` if it is exported, calls `dcode_alloc` for each input and copies the input in, calls `dcode_render_block`, reads the result, calls `dcode_free` on the result and on the inputs, and discards the instance.

### Return values

| Value | Meaning | What `out` holds |
| --- | --- | --- |
| `0` | Success | A complete SVG document, UTF-8. See [SVG output](#svg-output). |
| `1` | The source is wrong: the user made a mistake; the plugin did nothing wrong | A message for the user: UTF-8 plain text, no markup, **not empty**. Say where (line and column, if you can) and what is wrong. If the message is empty, the host shows a fixed sentence instead ("the plugin reported an error in the source but gave no explanation"), so the user learns nothing. |
| `-1` | An argument is invalid | Not written |
| `-2` | Out of memory | Not written |

Details:

- **Return `1`, not a trap, for any input the user can type.** `1` is shown to the user as a problem in their block. A trap is shown as a broken plugin.
- Return `-1` when `src` is not valid UTF-8, when `opts` is not valid UTF-8 JSON or is not a JSON object, or when `out` is null. The host never sends such arguments; the code exists so that a plugin can be checked by hand.
- Return `-2` when the plugin **notices** that it cannot allocate memory it needs, including the result buffer; on `-1` and `-2` the plugin MUST NOT write `out`. This is a duty only where the plugin itself sees the failure: most Rust code, and most libraries, allocate infallibly and **trap** when `memory.grow` fails. That is acceptable: a trap is reported as a plugin failure, as described below. (The template reserves the result buffer fallibly and returns `-2` for it; the rest of its work is not fallible.)
- `-1` and `-2` are not source errors: the host treats them as a plugin failure, like any other return value outside the table.
- The result for `0` and `1` SHOULD be a pure function of `(lang, src, opts)`. The host caches both kinds of result by their inputs; output that varies with anything else only defeats the cache. (The fixed-seed `random_get` and the zero clock in [Imports and WASI](#imports-and-wasi) are there for this reason.)

### Failures the host reports itself

The plugin does not report these and cannot influence the message:

- a trap, including a Rust panic compiled with `panic = "abort"`;
- a call to `proc_exit`;
- running over the time limit or the output limit (see [Limits](#limits));
- running out of memory in a way that traps instead of returning `-2`, which is what a library that allocates infallibly does.

## Options

`opts` is a UTF-8 JSON **object**. Version 1 of the ABI defines one field:

```json
{ "theme": "light" }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `theme` | string, `"light"` or `"dark"` | The colour scheme of the surface the picture is drawn on. |

- If `theme` is missing, or is anything other than `"light"` or `"dark"`, the plugin MUST behave as if it were `"light"`.
- The plugin MUST ignore fields it does not know. Later versions of the host may add optional fields; fields are never removed and never change meaning within ABI 1.
- If `opts` is not a JSON object, the plugin returns `-1`.

## Imports and WASI

A plugin has **no imports**, or imports **only functions of `wasi_snapshot_preview1`**. The host provides the WASI functions as stubs that give the plugin no capability. That is the permission model of ABI 1: the host provides nothing, so a plugin can do nothing but compute.

The stubs exist so that C and Rust toolchains that expect a WASI environment (wasi-sdk, `wasm32-wasip1`) produce modules that work.

### What is refused

An import gets a plugin **refused at install time** in exactly three cases:

1. it imports anything from the module `env`;
2. it imports from any module other than `wasi_snapshot_preview1` (including `wasi_unstable` and any `wasi:` component-model name);
3. it imports a name from `wasi_snapshot_preview1` that does not exist in preview 1 (the list below), or imports something that is not a function from that module.

**Browser glue from dependencies.** A Rust dependency tree can pull in `wasm-bindgen` (for example through a UI or DOM crate that your renderer does not really need). Built for `wasm32-unknown-unknown`, such a module imports functions from `__wbindgen_placeholder__` or `__wbindgen_externref_xform__`, which is the second case above: **the plugin is refused at install time**. Build for `wasm32-wasip1` instead. `wasm-bindgen` then leaves the browser glue out, and the module imports only functions of `wasi_snapshot_preview1` (typically `random_get`, `environ_get`, `environ_sizes_get`, `fd_write` and `proc_exit`), which are allowed. `tools/check-plugin.mjs` names the offending imports. The `svgbob` example in this repository is built that way.

### The 46 functions

These are all the functions of `wasi_snapshot_preview1`. A plugin may import any of them. The host provides every one:

- **args, environment, clock:** `args_get`, `args_sizes_get`, `environ_get`, `environ_sizes_get`, `clock_res_get`, `clock_time_get`
- **fd:** `fd_advise`, `fd_allocate`, `fd_close`, `fd_datasync`, `fd_fdstat_get`, `fd_fdstat_set_flags`, `fd_fdstat_set_rights`, `fd_filestat_get`, `fd_filestat_set_size`, `fd_filestat_set_times`, `fd_pread`, `fd_prestat_dir_name`, `fd_prestat_get`, `fd_pwrite`, `fd_read`, `fd_readdir`, `fd_renumber`, `fd_seek`, `fd_sync`, `fd_tell`, `fd_write`
- **path:** `path_create_directory`, `path_filestat_get`, `path_filestat_set_times`, `path_link`, `path_open`, `path_readlink`, `path_remove_directory`, `path_rename`, `path_symlink`, `path_unlink_file`
- **other:** `poll_oneoff`, `proc_exit`, `proc_raise`, `random_get`, `sched_yield`
- **sockets:** `sock_accept`, `sock_recv`, `sock_send`, `sock_shutdown`

### What they do

| Function | Behavior |
| --- | --- |
| `fd_write` | For fd 1 and 2, the bytes go into a log buffer for this call and are reported as written. Only the first 16 KB is kept; the rest is dropped. The log is for the plugin author and is never part of the result. For a plugin installed with `--dev` the host writes each call's log to its own log, at level INFO, tagged with the plugin `id`. For a signed plugin the log is discarded, because it may contain the user's source text. For any other fd it returns `EBADF`. |
| `random_get` | Fills the buffer with pseudo-random bytes from a **fixed seed**. The sequence starts over at the beginning of every call, so equal inputs give equal outputs. |
| `clock_time_get` | Succeeds and returns a time of 0. |
| `args_sizes_get`, `args_get`, `environ_sizes_get`, `environ_get` | Succeed and report an empty list: no arguments, no environment variables. |
| `proc_exit` | Ends the call immediately. It is a **plugin failure**, whatever the exit code. |
| Every other `fd_*` function and every `path_*` function, including the file-system ones (`path_open`, `fd_read`, `fd_readdir`, ...) and `fd_prestat_get`, `fd_prestat_dir_name` (30 functions in all) | Return `EBADF` (8). They **do not trap**. |
| `sched_yield` | Succeeds. |
| The remaining 7 functions (`clock_res_get`, `poll_oneoff`, `proc_raise`, `sock_accept`, `sock_recv`, `sock_send`, `sock_shutdown`) | Return `ENOSYS` (52). They **do not trap**. |

`fd_prestat_get` returning `EBADF` is not incidental. The first time a program opens a file by path (`fopen`, `open`, ...), wasi-libc probes pre-opened directories from fd 3 upwards, and stops only when it gets `EBADF`; any other error code makes it abort the call with `proc_exit(71)`, which is a plugin failure. (Checked with wasi-sdk 34: with `EBADF`, `fopen` fails with `ENOENT` and the program carries on; with `ENOSYS` the call aborts.) That is why the host answers `EBADF` there.

Because no directory is pre-opened, a plugin cannot read or write any file; every attempt fails with an error code, and a program that handles errors normally keeps running. A C library built with wasi-sdk therefore installs and runs; it simply finds no files.

## Manifest

The manifest is a UTF-8 JSON object stored in **exactly one** custom section named `dcode.plugin`.

```json
{
  "id": "io.github.example.graphviz-dot",
  "name": "Graphviz DOT",
  "version": "1.0.0",
  "abi": 1,
  "description": "Renders ```dot blocks as diagrams.",
  "homepage": "https://github.com/example/graphviz-dot",
  "publicKey": "RWRc97Nm84XTJv7qi9b3TruYb7D1/cjylG9RkrdC11jlLC7X0svsnlYC",
  "renderBlock": { "languages": ["dot", "graphviz"] }
}
```

| Field | Required | Rule |
| --- | --- | --- |
| `id` | yes | Reverse-domain notation is recommended (`io.github.example.graphviz-dot`). The rule the host enforces is the regular expression `^[a-z0-9]+([.-][a-z0-9]+)*$` and at most 64 characters: lowercase letters and digits in groups separated by single `.` or `-`. An `id` with a single group (`mydiagrams`) is accepted. It cannot change after installation: a different `id` is a different plugin. |
| `name` | yes | A non-empty string. The name shown to users. |
| `version` | yes | A [semantic version](https://semver.org), for example `1.2.3` or `1.2.3-beta.1`. |
| `abi` | yes | The number `1`. It MUST equal the result of `dcode_plugin_abi_version()`. |
| `description` | no | A string, one sentence of what the plugin does. |
| `homepage` | no | A string, the address of the plugin's home page. Information for humans only. |
| `publicKey` | yes | The author's minisign public key: the base64 string on the second line of the `.pub` file (it starts with `RW`). The signature is checked with this key. |
| `renderBlock` | yes (ABI 1 has no other extension point) | An object with the key `languages`. |
| `renderBlock.languages` | yes | An array of 1 to 16 strings. Each uses only lowercase letters, digits, `+` and `-`. `mermaid` and `wireframe` are built into DCode and cannot be claimed. |

Further rules:

- Keys the host does not know are ignored.
- **A language can belong to only one installed plugin.** Installing a plugin that declares a language already claimed by another installed plugin is refused. The user has to remove the other one first.
- The manifest is part of the signed file, so a change to it needs a new signature.

**Embedding the manifest.** In Rust, keep it in a `plugin.json` file next to `Cargo.toml` and include it in the module (this is what `template/` does):

```rust
#[used]
#[link_section = "dcode.plugin"]
pub static MANIFEST: [u8; include_bytes!("../plugin.json").len()] = *include_bytes!("../plugin.json");
```

With other languages, build the module and then add the custom section with a tool of your choice. Do it **before signing**, because the signature covers the whole file.

## Signing

Plugins MUST be signed, with one exception for development.

- Sign with minisign: `minisign -S -m plugin.wasm` writes `plugin.wasm.minisig`. Keep that file next to the plugin and keep the name `<file name>.wasm.minisig`. Both minisign signature types are accepted: the pre-hashed type that current minisign writes by default, and the legacy type.
- The signature covers the **entire `.wasm` file**, so the manifest is covered too. Any change to the file, even one bit, invalidates it. Build first, then sign, and never edit a signed file.
- The host verifies the signature with the `publicKey` in the manifest, and the signature's key id has to match that key. Ed25519 verification is strict RFC 8032 (no ZIP-215 leniency), the same as OpenSSL's.

A valid signature proves only that the file has not been modified and that it comes from the holder of that key. **Whether the key deserves trust is decided by the person who installs the plugin.** DCode helps with trust on first use:

- At install time DCode shows the key's **key id**. It is written the way `minisign` writes it in the comment of the `.pub` file (`untrusted comment: minisign public key: E8B20833B171CF7A`): 16 uppercase hexadecimal digits, the eight key-id bytes read as a little-endian number, so that you can compare it with what your own tools print. (The key id is also bytes 3 to 10 of the base64-decoded `publicKey`, in file order; the displayed form is those bytes reversed.)
- After the first installation, DCode remembers that this plugin `id` belongs to this key. An update MUST be signed with the same key, or it is refused. A lost or leaked key therefore cannot be replaced for an existing plugin: back the secret key up and protect it.
- If a plugin is uninstalled and installed again, that is a new first installation. DCode then tells the user which key the plugin used before.

**Development mode.** `dcode plugin install --dev <file>.wasm` skips the signature check. The plugin is marked as a development version in the user interface. An `id` can exist only once: either as a development version or as a signed one.

## Limits

The host enforces the limits. A plugin does not declare them.

| Item | Limit | When exceeded |
| --- | --- | --- |
| `.wasm` file size | 32 MiB | The plugin is refused at install time |
| Linear memory | 256 MiB (4096 pages of 64 KiB) | `memory.grow` fails; the plugin returns `-2` or traps |
| Time for one call, counting instantiation, the start section, `_initialize` and `dcode_render_block` | 5 s | The host terminates the call and reports that rendering timed out |
| Source size | 1 MiB, counted in UTF-8 bytes (1,048,576) | The plugin is not called; the host reports a failure |
| Output size (`out.len`) | 8 MiB (8,388,608 bytes) | The output is discarded and reported as a plugin failure |
| Log kept from `fd_write` | 16 KB, the first 16 KB | The rest is dropped; the log is kept only for `--dev` plugins (see [Imports and WASI](#imports-and-wasi)) |

**The source limit is a transport limit.** The host accepts 1 MiB of source; that does not mean a plugin can render 1 MiB of source in 5 s and 256 MiB. A plugin SHOULD set its own, smaller limits (on bytes, lines, line length or on whatever drives its cost) and return `1` with a message that says which limit was exceeded and what to do ("split the diagram"), instead of running into the time limit.

About the memory limit: before compiling a module the host rewrites its memory section so that the maximum is 256 MiB. If the module declares a smaller maximum, the smaller one stays. The file on disk is not changed, so the signature stays valid. A module whose *initial* memory is already larger than the limit cannot be installed. A module needs no declared maximum of its own, but it is useful to declare the same one: then a plugin that you run outside the host fails where it would fail inside. For Rust, add `-C link-arg=--max-memory=268435456` to the rustflags (the template does); with wasi-sdk, link with `-Wl,--max-memory=268435456`.

## State and re-entrancy

- **Every call gets a new instance**, and the instance is discarded after the call. Globals, statics, heap contents and the WASI log all start fresh. A plugin cannot keep state from one call to the next, so two code blocks cannot affect each other, and a leak inside one call does no harm.
- The host compiles a module once per plugin version and keeps the compiled module. Do not rely on that for anything except speed.
- A plugin MUST NOT assume it is called only once, and MUST NOT assume that calls arrive in any order.

## SVG output

On return value `0`, `out` holds one complete SVG document.

**Format**

- UTF-8, well-formed XML 1.0, with `<svg xmlns="http://www.w3.org/2000/svg" ...>` as the root element. An XML declaration is optional.
- Text taken from the source MUST be escaped (`&`, `<`, `>` and, inside attributes, `"`). Characters that XML 1.0 does not allow (control characters other than tab, line feed and carriage return, and U+FFFE and U+FFFF) MUST be removed or replaced; one of them makes the whole document unparsable.
- The SVG SHOULD have a `viewBox` and `width`/`height`, so that the host can scale it.
- The SVG SHOULD NOT paint a background over its whole area. The host draws it on the surface that matches `theme`. Choose line and text colors that read well on a light surface when `theme` is `"light"`, and light line and text colors on a dark one when `theme` is `"dark"`.

**What it MUST NOT contain**

- these elements: `<script>`, `<foreignObject>`, `<image>`, `<a>`, `<style>`, and the animation elements `<animate>`, `<animateMotion>`, `<animateTransform>` and `<set>`;
- the `style` attribute on any element, and event handler attributes (`onclick`, `onload`, and so on). Use **presentation attributes** instead: `fill`, `stroke`, `stroke-width`, `stroke-dasharray`, `font-family`, `font-size`, `stop-color`, `opacity` and the like;
- references to anything outside the document: no `href` or `xlink:href` except `#fragment` references, no `url()` except `url(#id)`, no `@import`, no `javascript:` URLs;
- fonts other than the generic families `sans-serif`, `serif`, `monospace` and `system-ui`. There is no `@font-face` and no named font: the host cannot load one and the machine that displays the picture might not have it.

**What the host does about it.** The host sanitizes every SVG before it shows it, and it **always** removes the following. A plugin MUST NOT depend on any of it:

| Removed | Why |
| --- | --- |
| The elements listed above | Scripts and `foreignObject` run or embed arbitrary content; `<image>` and `<a>` reach outside the document; animation can change what the picture shows after it was reviewed. `<style>` is removed because a CSS rule in it applies to the whole page, not only to your drawing, so one plugin could restyle the host's interface or another plugin's picture. |
| The `style` attribute | The same reason: CSS in an attribute can position the picture over the host's interface (`position: fixed`), load resources (`url()`), or hide and restyle other content. Presentation attributes cannot do any of that. |
| `href` and `xlink:href` unless the value starts with `#`; any attribute value with a `url()` that does not point at `#id` | Nothing may reach outside the document. |

If nothing usable is left after sanitizing, that is, there is no `<svg>` root element, the host shows a **plugin failure**, not an empty picture.

That is a second line of defence, not permission to produce such content: **what the plugin outputs is the author's responsibility.** A picture that depends on removed content is shown broken. A common trap: a gradient whose colours are written as `<stop style="stop-color:red">` loses its colours, because the `style` attribute is removed; write `<stop stop-color="red"/>`.

**Shared documents.** The host may place SVGs from several code blocks, and from several plugins, in one HTML document. The SVGs then share one namespace for `id`s. Therefore:

- Give every element `id` a prefix that tells your picture from every **other** picture on the page: your plugin's own prefix plus a hash of the source text and `theme` (for example `bob-3a1c9e4d7b2f6a10-arrow`). Two blocks with exactly the same source and theme then get exactly the same ids, and that is fine: the elements behind those ids are identical too, so it does not matter which of them a reference reaches. What must not happen is that two **different** pictures share an id. So do not use a fixed prefix, a counter that restarts for every call, or the ids of the library you call, unprefixed.
- Do not use `<style>` blocks or `style` attributes. The host removes them (see above), and they would leak into other pictures if it did not.

## Versioning

- There are two version numbers, and they are independent. `abi` is the version of this contract; `version` is the plugin's own.
- The host supports **one ABI major version at a time**. A plugin whose `abi` the host does not support is refused. There is no compatibility layer.
- **A new extension point is a new export function plus a new key in the manifest.** It does not change the ABI major version, and plugins that were built before it keep working. In ABI 1, `renderBlock` and `dcode_render_block` are required because they are the only extension point.
- Within ABI 1, the options object only gains optional fields.
- The version moves to ABI 2 only when an export is removed, or when the signature or the meaning of an existing export changes. Plugins then have to be rebuilt against the new document.

## Conformance checklist

Go through this before you publish a plugin. `tools/check-plugin.mjs` in this repository checks most of it for you: the module shape, the manifest, the signature, the return codes and the SVG rules (see the README); what it cannot know, such as whether your plugin's output is correct, stays with you.

**Module**

- [ ] It is a core module with one `memory`, defined in the module and exported, 32-bit, not shared. The initial size is at most 256 MiB.
- [ ] It exports `dcode_plugin_abi_version`, `dcode_alloc`, `dcode_free` and `dcode_render_block`, and does not export `_start`.
- [ ] If it exports `_initialize`, the module works when `_initialize` runs once, first, and nothing else sets it up.
- [ ] It has no imports, or only imports from the 46 names of `wasi_snapshot_preview1`. Nothing comes from `env`.
- [ ] Only WebAssembly features listed in [WebAssembly features](#webassembly-features) are used.

**Functions**

- [ ] `dcode_plugin_abi_version()` returns `1`, the same as `abi` in the manifest.
- [ ] `dcode_alloc(0)` returns non-null; a failed allocation returns null.
- [ ] `dcode_free(ptr, len)` releases memory from `dcode_alloc(len)` and the buffer returned in `out`, with the same `len` as at allocation. `dcode_free(ptr, 0)` is harmless.
- [ ] `dcode_render_block` returns `0`, `1`, `-1` or `-2` exactly as the table says, and writes `out` (with an unaligned store) only on `0` and `1`.
- [ ] Invalid UTF-8 in `src`, and `opts` that is not a JSON object, give `-1`.
- [ ] A missing or unknown `theme` means light; unknown option fields are ignored.
- [ ] It does not free the inputs.
- [ ] No input the user can type makes it trap or hang: wrong syntax returns `1` with a message that names the line and the problem. Try empty input, random bytes, very long lines, and a 1 MiB source.
- [ ] Equal inputs give equal output, and nothing is kept between calls.

**Manifest and signature**

- [ ] There is exactly one `dcode.plugin` section, and it is UTF-8 JSON with the fields in [Manifest](#manifest).
- [ ] `id` and `languages` follow the character rules; no language is `mermaid` or `wireframe`.
- [ ] `publicKey` is your minisign public key; the `.wasm` was signed with the matching secret key **after** its last change; `<file>.wasm.minisig` sits next to it.
- [ ] The secret key is backed up, and is not in version control.

**Output**

- [ ] The SVG is well-formed XML, with an `svg` root element in the SVG namespace, and escaped text.
- [ ] No `<script>`, `<foreignObject>`, `<image>`, `<a>`, `<style>` or animation element; no `style` attribute and no event handler attribute; no `href` or `url()` that points outside the document. Colours and strokes are presentation attributes.
- [ ] Only generic font families.
- [ ] Both themes are drawn and readable on their surfaces; the SVG has no full-size background.
- [ ] Ids are prefixed with something derived from the source.
- [ ] A source of 1 MiB finishes within 5 s and 256 MiB and produces at most 8 MiB.

### What happens at install time

`dcode plugin install` stops at the first failing step and says why: the file is within 32 MiB; the module compiles; the manifest is valid; the required exports exist and the imports are allowed; the signature is valid (skipped with `--dev`); the key matches the one remembered for this `id`; none of the languages is claimed by another installed plugin; the memory limit can be applied to the module; finally the host instantiates the module in a worker and calls `dcode_plugin_abi_version()`, which has to return `1`.
