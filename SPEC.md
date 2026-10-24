# DCode Plugin ABI 1

**Plugin ABI 1** is the contract between a DCode plugin and the DCode host. A plugin is a single WebAssembly file; the host loads it, asks it to turn code blocks into pictures or to preview a file, and gives it nothing else.

**This document is normative.** If the README, the template, a plugin or a host implementation disagrees with it, this document is the reference and the other one has a bug. It is written so that you can build a plugin from it alone, without knowing how DCode is implemented.

The words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

## Contents

- [Overview](#overview)
- [Module shape](#module-shape)
- [WebAssembly features](#webassembly-features)
- [Exports](#exports)
- [`dcode_buf`](#dcode_buf)
- [`dcode_render_block` and return values](#dcode_render_block-and-return-values)
- [`dcode_render_file` and return values](#dcode_render_file-and-return-values)
- [Options](#options)
- [Imports and WASI](#imports-and-wasi)
- [Manifest](#manifest)
- [Signing](#signing)
- [Limits](#limits)
- [State and re-entrancy](#state-and-re-entrancy)
- [SVG output](#svg-output)
- [HTML output](#html-output)
- [Versioning](#versioning)
- [Conformance checklist](#conformance-checklist)

## Overview

A plugin is:

- one `.wasm` file, a WebAssembly core module, which carries its own manifest in a custom section named `dcode.plugin`;
- next to it, a `.minisig` signature file made with [minisign](https://jedisct1.github.io/minisign/).

Plugin ABI 1 has two extension points. A plugin implements at least one of them, and says which in its manifest:

- the **block renderer** (`renderBlock`). The manifest lists the code-block languages the plugin handles (for example `dot`). When DCode shows a code block in one of those languages (in a chat message, or in a document in the viewer or the editor), it calls the plugin with the block's source and gets back an SVG picture, or an error message for the person who wrote the block.
- the **file previewer** (`renderFile`). The manifest lists file extensions (for example `.sqlite`). When a person opens a file with one of those extensions in a workspace, and DCode has no preview of its own for that format, it calls the plugin with the file's name and bytes and gets back an SVG picture or an HTML page, or a message about why the file cannot be shown.

Three properties of the platform shape everything below:

- **The host gives plugins no capabilities.** A plugin has no files, no network, no real clock and no environment. The only things it can do are compute and return text. (A file previewer is *given* the bytes of one file as an argument; it cannot open any file.) A plugin that tries to import anything else is refused at install time.
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

The DCode host compiles a plugin with the WebAssembly engine of the Node.js it runs on, with default settings and no flags. Which Node.js and V8 a given DCode uses is a property of that build (a release build embeds the Node.js that built it), not of this document. A module that uses something the engine does not accept fails to compile and is **refused at install time**. On top of that the host refuses the modules marked below, and the memory rules in [Module shape](#module-shape) apply.

**Which engine the table describes.** Compilation was checked on Node 24.21.0 (V8 13.6.233.17) with one small module per feature. That is a measurement, not a statement about the engine of any DCode release: take the Node and V8 version of the host you target from its build record or its runtime. Other engines can meet a plugin, and the table does not describe them: `tools/check-plugin.mjs` compiles with whichever Node runs it (it starts on Node 18 or newer, but a different V8 can accept or refuse a feature differently from this table, so to predict a given host run the checker on that host's own Node and V8), and a host started from source (a development run) uses Bun, whose engine is JavaScriptCore, on which nothing here was measured.

| Feature | Accepted by Node 24.21.0 | Notes |
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
| GC (struct, array, rec and sub types) | yes, in the engine | **Refused at install time**: the type section may contain function types only. GC objects live in the engine's own heap, not in the linear memory, so the 256 MiB limit would not apply to them |
| Multiple memories, 64-bit memory, shared memory and atomics | yes, in the engine | **Not allowed by ABI 1**: the module must have exactly one 32-bit, non-shared memory |

The first six rows are the set that current toolchains emit without being asked: Rust 1.97 for `wasm32-unknown-unknown` and wasi-sdk 34 for `wasm32-wasip1` emit nothing beyond these, and so does the Graphviz reference plugin. **A plugin SHOULD stay within the first six rows.** The engine of a future host may differ from today's.

A plugin cannot use threads: a call runs on one thread, and shared memory is refused. The **memory limit covers the linear memory only**; that is why anything that allocates outside it, such as GC objects, is refused.

## Exports

A plugin MUST export the memory and the first three functions below, and the render function of each extension point its [manifest](#manifest) declares:

| Export | Kind | WebAssembly type | Required |
| --- | --- | --- | --- |
| `memory` | memory | one 32-bit linear memory | always |
| `dcode_plugin_abi_version` | function | `() -> i32` | always |
| `dcode_alloc` | function | `(i32) -> i32` | always |
| `dcode_free` | function | `(i32, i32) -> ()` | always |
| `dcode_render_block` | function | `(i32, i32, i32, i32, i32, i32, i32) -> i32` | when the manifest has `renderBlock` |
| `dcode_render_file` | function | `(i32, i32, i32, i32, i32, i32, i32) -> i32` | when the manifest has `renderFile` |

The host ignores a render function the manifest does not declare, with one exception: if the module exports `dcode_render_file`, it MUST take exactly 7 parameters, declared or not. The host reads the parameter count when it installs the plugin and on every call, and any other count is a failure.

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

int32_t  dcode_render_file(const uint8_t *name_ptr, size_t name_len,    /* UTF-8, no path */
                           const uint8_t *data_ptr, size_t data_len,    /* any bytes */
                           const uint8_t *opts_ptr, size_t opts_len,    /* UTF-8 JSON */
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

#[no_mangle]
pub unsafe extern "C" fn dcode_render_file(
    name_ptr: *const u8, name_len: usize,
    data_ptr: *const u8, data_len: usize,
    opts_ptr: *const u8, opts_len: usize,
    out: *mut DcodeBuf,
) -> i32;
```

### `dcode_plugin_abi_version`

Returns `1`. The manifest's `abi` field MUST be the same number. The host calls this function once, in a fresh instance, as the last step of installation, and refuses the plugin if the result is not `1` or does not equal `abi`.

### `dcode_alloc`

Returns a pointer to `len` writable bytes in the plugin's memory, or null when the memory cannot be allocated. The host uses it to place the inputs of `dcode_render_block` and `dcode_render_file` in the plugin's memory.

- For `len == 0` it MUST return a **non-null** pointer. Null always means failure. (An empty file is passed to a file previewer, and the host allocates its zero bytes like any other input.)
- The pointer needs no alignment beyond 1 byte.

### `dcode_free`

`dcode_free(ptr, len)` releases memory. It MUST be able to release:

- memory returned by `dcode_alloc(len)`; and
- the buffer that `dcode_render_block` or `dcode_render_file` left in `out` (see [`dcode_buf`](#dcode_buf)).

In both cases `len` is exactly the length the memory was created with. `dcode_free(ptr, 0)` MUST be harmless. The plugin may therefore use any allocator, as long as it can free by `(ptr, len)`.

## `dcode_buf`

`dcode_buf` is a pair of 32-bit little-endian integers, 8 bytes in total:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | `ptr`: address of the first byte in the plugin's memory |
| 4 | 4 | `len`: length in bytes |

- The `out` argument of `dcode_render_block` and of `dcode_render_file` points to such a record. **Its address has no alignment guarantee**, so the plugin MUST write it with unaligned stores (in Rust, `ptr::write_unaligned`).
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

The three inputs are owned by the host: the plugin MUST NOT free them or keep pointers to them after returning. The host may or may not call `dcode_free` on them (the current host does not: it discards the instance once it has read the result), so a plugin MUST NOT depend on the inputs being freed, nor on their not being freed.

*How the host calls a plugin.* The host instantiates the module (the start section runs), calls `_initialize` if it is exported, calls `dcode_alloc` for each input and copies the input in, calls `dcode_render_block`, reads the result, calls `dcode_free` on the result, and discards the instance.

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

## `dcode_render_file` and return values

*Since DCode **0.2.2**. Older versions do not know `renderFile`; see [Manifest](#manifest) for how they treat such a plugin.*

```c
int32_t dcode_render_file(name, data, opts, out);
```

| Argument | Meaning |
| --- | --- |
| `name_ptr`, `name_len` | The name of the file the person opened, UTF-8: the last part of its path, **never a directory**. Its case is as it is on disk (`Data.DB` arrives as `Data.DB`), and it can hold spaces, markup characters and any Unicode. It is text taken from outside: escape it like any other text from the file. |
| `data_ptr`, `data_len` | The whole file, **any bytes**: not necessarily UTF-8, and possibly none at all (an empty file is passed too). At most 32 MiB (33,554,432 bytes); a larger file is never read and the plugin is not called. |
| `opts_ptr`, `opts_len` | The options, a UTF-8 JSON object, the same as for `dcode_render_block`. See [Options](#options). |
| `out` | Where to put the result: a [`dcode_buf`](#dcode_buf). |

The three inputs are owned by the host: the plugin MUST NOT free them or keep pointers to them after returning, and MUST NOT depend on whether the host calls `dcode_free` on them (see [`dcode_render_block`](#dcode_render_block-and-return-values)). The host calls the function the same way as `dcode_render_block` (a fresh instance, `_initialize`, `dcode_alloc` and a copy for each input, the call, `dcode_free` on the result). The file lives in the plugin's linear memory for the whole call: a 32 MiB file takes 32 MiB of the 256 MiB, and a plugin that copies it or builds large structures from it has less than it may think. The plugin cannot read a part of a file later; it has all of it, or nothing.

### Return values

| Value | Meaning | What `out` holds |
| --- | --- | --- |
| `0` | Success: a picture | A complete SVG document, UTF-8. See [SVG output](#svg-output). |
| `2` | Success: an HTML page | UTF-8 HTML, a complete document or only what belongs in `<body>`. See [HTML output](#html-output). **Only `dcode_render_file` can return `2`**: if `dcode_render_block` returns it, the host treats the call as a plugin failure, because a code block is only ever drawn from SVG. |
| `1` | The file is not something the plugin can show: not in the format its extension says, damaged, encrypted, unsupported | A message for the person who opened the file: UTF-8 plain text, no markup, **not empty**. DCode shows it in place of the preview. If the message is empty, the host shows a fixed sentence instead. |
| `-1` | An argument is invalid | Not written |
| `-2` | Out of memory | Not written |

Details:

- **Return `1`, not a trap, for any file a person can open.** A file with the right extension and the wrong content, a damaged file, an encrypted one, an empty one and a truncated one are all ordinary. `1` is shown as "this file cannot be previewed, and why"; a trap is shown as a broken plugin.
- Return `-1` when `name` is not valid UTF-8, when `opts` is not valid UTF-8 JSON or is not a JSON object, or when `out` is null. **`data` is never invalid**: whatever its bytes, the answer is `0`, `1` or `2`. The host never sends the arguments that give `-1`; the code exists so that a plugin can be checked by hand.
- `-2` and a trap from running out of memory are as for [`dcode_render_block`](#dcode_render_block-and-return-values): the plugin returns `-2` only where it notices the failure, and on `-1` and `-2` it MUST NOT write `out`. Both are plugin failures.
- The result for `0`, `1` and `2` SHOULD be a pure function of `(name, data, opts)`. The host caches by the plugin id and version, the file's metadata identity (real path, the name passed to the plugin, device, inode, size, modification time and change time), and the theme, not by content, so output that varies with anything else only confuses. This detects common replacements and preserved-mtime rewrites, but it is neither a content hash nor an atomic snapshot: a change that leaves that metadata equal, or happens after the worker's final check, can still be missed.
- **Show a start, not everything.** The output is limited to 8 MiB and the call to 5 s, and a person looks at a preview for a moment. A previewer SHOULD show the beginning of a big file (the first rows of a table, the first screen of a log), say that it is a part, and stop adding content before the output limit rather than run into it. Never do work whose cost grows with the whole file when a part is enough: an unbounded `COUNT(*)` on a 30 MiB database is such a thing.
- Everything in [Failures the host reports itself](#failures-the-host-reports-itself) applies here too.

## Options

`opts` is a UTF-8 JSON **object**, the same for both render functions. Version 1 of the ABI defines one field:

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
| `fd_write` | For fd 1 and 2, the bytes go into a log buffer for this call and are reported as written. Only the first 16 KiB (16,384 bytes) are kept; the rest is dropped, but the count reported is still the full length. The kept bytes are joined first and decoded as UTF-8 once (an invalid byte becomes U+FFFD and a leading byte-order mark is dropped), so a character split between two iovecs or two calls decodes whole, and one cut off by the 16 KiB end decodes as U+FFFD. The log is for the plugin author and is never part of the result. For a plugin installed with `--dev` the host writes each call's log to its own log, at level INFO, tagged with the plugin `id`. For a signed plugin the log is discarded, because it may contain the user's source text. For any other fd it returns `EBADF`. |
| `random_get` | Fills the buffer with pseudo-random bytes from a **fixed seed**. The sequence starts over at the beginning of every call, so equal inputs give equal outputs, and any split of the same total length into several calls gives the same bytes. The current host and `check-plugin.mjs` use xorshift32 starting from the state `0x9e3779b9` and write the low 8 bits of each new state. It is not secret and not a cryptographic generator, so a plugin MUST NOT use it as one; depend on the stream being fixed, not on particular bytes. |
| `clock_time_get` | Succeeds and returns a time of 0. |
| `args_sizes_get`, `args_get`, `environ_sizes_get`, `environ_get` | Succeed and report an empty list: no arguments, no environment variables. |
| `proc_exit` | Ends the call immediately. It is a **plugin failure**, whatever the exit code. |
| Every other `fd_*` function and every `path_*` function, including the file-system ones (`path_open`, `fd_read`, `fd_readdir`, ...) and `fd_prestat_get`, `fd_prestat_dir_name` (30 functions in all) | Return `EBADF` (8). They **do not trap**. |
| `sched_yield` | Succeeds. |
| The remaining 7 functions (`clock_res_get`, `poll_oneoff`, `proc_raise`, `sock_accept`, `sock_recv`, `sock_send`, `sock_shutdown`) | Return `ENOSYS` (52). They **do not trap**. |

**Pointers, lengths and `EFAULT`.** Pointers and lengths a plugin passes are unsigned 32-bit values. A stub that reads or writes the plugin's memory checks the whole range first. A range that is not inside the memory, or a call made before the instance has a memory (from a start section), returns `EFAULT` (21) and does not trap. That applies to `fd_write` (the iovec array, each buffer and the `nwritten` pointer), `random_get`, `clock_time_get`, `args_sizes_get` and `environ_sizes_get`; a bad fd still gives `EBADF` first. A call checks its pointers in order, so an `EFAULT` can come after earlier effects: `fd_write` has already logged the buffers before the bad one, and `args_sizes_get` has already written the count. Pages added by `memory.grow` are inside the memory from then on.

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

A file previewer declares `renderFile` instead of, or as well as, `renderBlock`:

```json
{
  "id": "io.github.example.sqlite-overview",
  "name": "SQLite overview",
  "version": "1.0.0",
  "abi": 1,
  "publicKey": "RWRc97Nm84XTJv7qi9b3TruYb7D1/cjylG9RkrdC11jlLC7X0svsnlYC",
  "renderFile": { "extensions": [".sqlite", ".sqlite3", ".db"] }
}
```

| Field | Required | Rule |
| --- | --- | --- |
| `id` | yes | Reverse-domain notation is recommended (`io.github.example.graphviz-dot`). The rule the host enforces is the regular expression `^[a-z0-9]+([.-][a-z0-9]+)*$` and at most 64 characters: lowercase letters and digits in groups separated by single `.` or `-`. An `id` with a single group (`mydiagrams`) is accepted. It cannot change after installation: a different `id` is a different plugin. |
| `name` | yes | A non-empty string of at most 100 UTF-16 code units. The name shown to users. |
| `version` | yes | A [semantic version](https://semver.org), for example `1.2.3` or `1.2.3-beta.1`, of at most 64 UTF-16 code units. The rule the host enforces is the regular expression `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`, which is looser than semver.org (it admits `01.2.3`); write a real semantic version anyway. |
| `abi` | yes | The number `1`. It MUST equal the result of `dcode_plugin_abi_version()`. |
| `description` | no | A string of at most 2000 UTF-16 code units, one sentence of what the plugin does. |
| `homepage` | no | A string of at most 500 UTF-16 code units, the address of the plugin's home page. Omitted or `""` means none. Anything else MUST be an `http:` or `https:` URL that JavaScript's `new URL(value)` accepts: `example.com` and `ftp://example.com` are refused (`manifest-invalid`). Information for humans only. |
| `publicKey` | yes | The author's minisign public key: the base64 string on the second line of the `.pub` file (it starts with `RW`). The signature is checked with this key. The host reads the base64 strictly: white space around it is ignored, but a space or line break inside it, a character outside the standard alphabet (the URL-safe `-` and `_` too) or a value that is not 42 bytes starting with `Ed` is refused (`manifest-invalid`). The host ignores the top bit of each of those two tag bytes, as `Buffer`'s ASCII decoding does; no tool writes such a key. |
| `renderBlock` | one of `renderBlock` and `renderFile`, at least | An object with the key `languages`. |
| `renderBlock.languages` | yes, with `renderBlock` | An array of 1 to 16 strings. Each uses only lowercase letters, digits, `+` and `-`, and has at most 32 characters. `mermaid` and `wireframe` may be claimed too: DCode draws them itself, and an enabled plugin that declares one draws it instead. |
| `renderFile` | one of `renderBlock` and `renderFile`, at least | An object with the key `extensions`. |
| `renderFile.extensions` | yes, with `renderFile` | An array of 1 to 16 strings, no duplicates. Each is a dot and then lowercase letters, digits, `+` and `-` (`^\.[a-z0-9][a-z0-9+-]*$`), at most 16 characters long: `.sqlite`. It names the end of the file name, so for `archive.tar.gz` only `.gz` counts. The host lowers the case of a file's extension before it looks for a plugin, so `.DB` reaches a plugin that declared `.db`. |

Further rules:

- **Lengths count UTF-16 code units**, as JavaScript's `String.length` does: not bytes and not code points. `é` counts 1 (two bytes) and `😀` counts 2. A string of exactly the limit is accepted and one unit more is refused. The 1 MiB source limit in [Limits](#limits) is the other kind of count, in UTF-8 bytes.
- Keys the host does not know are ignored.
- **A plugin declares `renderBlock`, `renderFile` or both.** A manifest with neither is refused (`manifest-invalid`). The exports the module must have follow from the manifest ([Exports](#exports)).
- **A language can belong to only one installed plugin.** Installing a plugin that declares a language already claimed by another installed plugin is refused. The user has to remove the other one first.
- **A file extension can belong to only one installed plugin**, in the same way: the plugin installed later is refused (`extension-taken`).
- **A plugin cannot declare a format DCode previews itself:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.pdf`, `.docx`, `.md`, `.markdown`, `.mmd` and `.mermaid`. Such a manifest is refused (`extension-builtin`). A previewer would receive every file of that kind that the person opens, so the platform lets a plugin fill a gap and never replace a preview that exists. (That is deliberately different from languages: a plugin may take over `mermaid` or `wireframe` blocks.) `.dot` and `.gv` are not on the list, because DCode cannot draw DOT by itself. The list belongs to DCode and later versions may add formats to it; `tools/check-plugin.mjs` carries a copy.
- **Older DCode versions.** A version from before `renderFile` ([`dcode_render_file`](#dcode_render_file-and-return-values) says since when) requires `renderBlock`. It refuses a plugin that declares only `renderFile` (`manifest-invalid`), and it installs a plugin that declares both and ignores `renderFile`, as it ignores any key it does not know.
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
- A plugin is identified by its **whole public key**: the 32-byte Ed25519 key inside `publicKey`. This is what "the same key" means below. The key id is not part of the identity (see the next list).

A valid signature proves only that the file has not been modified and that it comes from the holder of that key. **Whether the key deserves trust is decided by the person who installs the plugin.** DCode helps with trust on first use:

- At install time DCode shows the key's **key id** and its full public key. The key id is written the way `minisign` writes it in the comment of the `.pub` file (`untrusted comment: minisign public key: E8B20833B171CF7A`): 16 uppercase hexadecimal digits, the eight key-id bytes read as a little-endian number, so that you can compare it with what your own tools print. (The key id is bytes 3 to 10 of the base64-decoded `publicKey`, in file order; the displayed form is those bytes reversed.) **The key id is for display only.** It is eight bytes that anyone can set to any value when they build a public key of their own, so two different keys can carry the same key id. DCode never treats it as the identity of an author.
- After the first installation, DCode remembers that this plugin `id` belongs to this **public key**. An update MUST be signed with exactly the same public key, all 32 bytes, or it is refused. A different key that carries the same key id does not count. A lost or leaked key therefore cannot be replaced for an existing plugin: back the secret key up and protect it.
- **There is one way to change the key of a plugin: uninstall it, then install it again.** The public key of the new installation becomes the one that is remembered. Tell your users to do that if you ever have to change the key; there is no other path, and an update signed with another key is refused whatever its version number.
- If a plugin is uninstalled and installed again, that is a new first installation. DCode then tells the user which key the plugin used before, so a changed key is visible.

**Development mode.** `dcode plugin install --dev <file>.wasm` skips the signature check. The plugin is marked as a development version in the user interface. An `id` can exist only once: either as a development version or as a signed one.

## Limits

The host enforces the limits. A plugin does not declare them.

| Item | Limit | When exceeded |
| --- | --- | --- |
| `.wasm` file size | 32 MiB | The plugin is refused at install time |
| Linear memory (the limit covers nothing else: not the engine's own heap, which is why GC types are refused, and not the whole process) | 256 MiB (4096 pages of 64 KiB) | `memory.grow` fails; the plugin returns `-2` or traps |
| Time for one call of `dcode_render_block` or `dcode_render_file`, counting instantiation, the start section, `_initialize` and the render function | 5 s | The host terminates the call and reports that rendering timed out |
| Source size (`renderBlock`) | 1 MiB, counted in UTF-8 bytes (1,048,576) | The plugin is not called; the host reports a failure |
| File size (`renderFile`) | 32 MiB (33,554,432 bytes) | The file is not read and the plugin is not called; the person is told that the file is too large to preview |
| Output size (`out.len`), for both render functions | 8 MiB (8,388,608 bytes) | The output is discarded and reported as a plugin failure |
| Log kept from `fd_write` | 16 KiB (16,384 bytes), the first 16 KiB | The rest is dropped; the log is kept only for `--dev` plugins (see [Imports and WASI](#imports-and-wasi)) |

The 5 s clock starts when the host hands the call to the thread that runs plugins, and everything that thread does for the call is inside it. For a file previewer that includes **reading the file from disk** (a file on a slow or network disk uses part of the 5 s before the plugin starts) and, on the first call after an install, compiling the module. Time spent waiting in the queue behind other calls is not counted.

**The source limit is a transport limit.** The host accepts 1 MiB of source; that does not mean a plugin can render 1 MiB of source in 5 s and 256 MiB of linear memory. A plugin SHOULD set its own, smaller limits (on bytes, lines, line length or on whatever drives its cost) and return `1` with a message that says which limit was exceeded and what to do ("split the diagram"), instead of running into the time limit. The same goes for the file limit: a file previewer gets up to 32 MiB, sitting in its own memory, and SHOULD preview a start of it instead of working through all of it.

About the memory limit: before compiling a module the host rewrites its memory section so that the maximum is 256 MiB. If the module declares a smaller maximum, the smaller one stays. The file on disk is not changed, so the signature stays valid. A module whose *initial* memory is already larger than the limit cannot be installed. A module needs no declared maximum of its own, but it is useful to declare the same one: then a plugin that you run outside the host fails where it would fail inside. For Rust, add `-C link-arg=--max-memory=268435456` to the rustflags (the template does); with wasi-sdk, link with `-Wl,--max-memory=268435456`.

## State and re-entrancy

- **Every call gets a new instance**, and the instance is discarded after the call. Globals, statics, heap contents and the WASI log all start fresh. A plugin cannot keep state from one call to the next, so two code blocks cannot affect each other, and a leak inside one call does no harm.
- The host compiles a module once per plugin version and keeps the compiled module. Do not rely on that for anything except speed.
- A plugin MUST NOT assume it is called only once, and MUST NOT assume that calls arrive in any order.

## SVG output

On return value `0`, of either render function, `out` holds one complete SVG document.

**Format**

- UTF-8, well-formed XML 1.0, with `<svg xmlns="http://www.w3.org/2000/svg" ...>` as the root element. An XML declaration is optional.
- Text taken from the source MUST be escaped (`&`, `<`, `>` and, inside attributes, `"`). Characters that XML 1.0 does not allow (control characters other than tab, line feed and carriage return, and U+FFFE and U+FFFF) MUST be removed or replaced; one of them makes the whole document unparsable.
- The SVG SHOULD have a `viewBox` and `width`/`height`, so that the viewer can scale it.
- The SVG SHOULD NOT paint a background over its whole area. The viewer draws it on the surface that matches `theme`. Choose line and text colors that read well on a light surface when `theme` is `"light"`, and light line and text colors on a dark one when `theme` is `"dark"`.

**What it MUST NOT contain**

- these elements: `<script>`, `<foreignObject>`, `<image>`, `<a>`, `<style>`, and the animation elements `<animate>`, `<animateMotion>`, `<animateTransform>` and `<set>`;
- the `style` attribute on any element, and event handler attributes (`onclick`, `onload`, and so on). Use **presentation attributes** instead: `fill`, `stroke`, `stroke-width`, `stroke-dasharray`, `font-family`, `font-size`, `stop-color`, `opacity` and the like;
- references to anything outside the document: no `href` or `xlink:href` except `#fragment` references, no `url()` except `url(#id)`, no `@import`, no `javascript:` URLs. In the attributes that can refer to a resource (`fill`, `stroke`, `mask`, `filter`, `clip-path`, `marker`, `marker-start`, `marker-mid`, `marker-end`, `cursor`, and the like) a reference to a resource is written `url(#id)` and nothing else;
- a backslash `\` in any attribute value. A browser reads `\` in a CSS value as an escape, so `u\rl(https://example.com/)` and `\75 rl(https://example.com/)` both mean `url(https://example.com/)`. No SVG attribute needs a backslash, so none may contain one;
- `image-set(` or `-webkit-image-set(` in any attribute value: they take an address as a string and fetch it just as `url()` does;
- fonts other than the generic families `sans-serif`, `serif`, `monospace` and `system-ui`. There is no `@font-face` and no named font: the viewer cannot load one and the machine that displays the picture might not have it.

**What the viewer does about it.** The host does not sanitize: it returns the SVG as the plugin wrote it. It limits the size, requires UTF-8 and, for a code block, refuses the HTML return value `2`; it does not look inside the markup. The *viewer*, DCode's own client (the desktop app and the phone), sanitizes every SVG before it shows it, and it **always** removes the following. A plugin MUST NOT depend on any of it:

| Removed | Why |
| --- | --- |
| The elements listed above | Scripts and `foreignObject` run or embed arbitrary content; `<image>` and `<a>` reach outside the document; animation can change what the picture shows after it was reviewed. `<style>` is removed because a CSS rule in it applies to the whole page, not only to your drawing, so one plugin could restyle the viewer's interface or another plugin's picture. |
| The `style` attribute | The same reason: CSS in an attribute can position the picture over the viewer's interface (`position: fixed`), load resources (`url()`), or hide and restyle other content. Presentation attributes cannot do any of that. |
| `href` and `xlink:href` unless the value starts with `#` | Nothing may reach outside the document. |
| In an attribute that can refer to a resource (`fill`, `stroke`, `mask`, `filter`, `clip-path`, `marker*`, `cursor`, and the like): a `url(` that is not followed by `#id)` | The same: only `url(#id)` stays; an address, a `data:` URL or an empty `url()` is a way out of the document. |
| Any attribute value that contains a backslash | CSS escapes can spell a function name so that a text search for `url(` does not see it: `u\rl(`, `\75 rl(`. The viewer does not try to decode them. |
| Any attribute value that contains `image-set(` or `-webkit-image-set(` | They load a resource from an address, like `url()`. |

Where the table says an attribute, the viewer removes that attribute and keeps the element. If nothing usable is left after sanitizing, that is, there is no `<svg>` root element, the viewer shows a **plugin failure**, not an empty picture.

That is a second line of defence, not permission to produce such content: **what the plugin outputs is the author's responsibility.** A picture that depends on removed content is shown broken. A common trap: a gradient whose colours are written as `<stop style="stop-color:red">` loses its colours, because the `style` attribute is removed; write `<stop stop-color="red"/>`.

**Shared documents.** The viewer may place SVGs from several code blocks, and from several plugins, in one HTML document. The SVGs then share one namespace for `id`s. Therefore:

- Give every element `id` a prefix that tells your picture from every **other** picture on the page: your plugin's own prefix plus a hash of the source text and `theme` (for example `bob-3a1c9e4d7b2f6a10-arrow`). Two blocks with exactly the same source and theme then get exactly the same ids, and that is fine: the elements behind those ids are identical too, so it does not matter which of them a reference reaches. What must not happen is that two **different** pictures share an id. So do not use a fixed prefix, a counter that restarts for every call, or the ids of the library you call, unprefixed.
- Do not use `<style>` blocks or `style` attributes. The viewer removes them (see above), and they would leak into other pictures if it did not.

## HTML output

On return value `2` of `dcode_render_file`, `out` holds an HTML page. DCode never runs it: it shows it as a static page, with the precautions below. A code block never gets HTML; `dcode_render_block` returns SVG only.

**Why so strict.** A file previewer reads the person's file, and the only way out of the plugin is its output. So DCode treats the HTML as untrusted, and shows it in a way that cannot send anything anywhere, whatever the plugin writes.

**Format**

- UTF-8 HTML: a complete document, or only what belongs in `<body>`. Use headings, paragraphs, lists, tables, `<pre>` and plain text. A `<style>` element in `<head>`, or a `style` attribute, sets colours, borders, fonts and layout.
- Text taken from the file (its name, its content) MUST be escaped: `&`, `<` and `>` in text, and also `"` and `'` in attribute values. Characters that HTML does not allow (control characters other than tab, line feed and carriage return) SHOULD be removed or replaced.
- The page SHOULD NOT paint a background over its whole area; the viewer draws the surface that matches `theme`. Choose colours that read well on a light surface when `theme` is `"light"`, and light text and borders on a dark one when `theme` is `"dark"`. Use generic font families (`sans-serif`, `serif`, `monospace`, `system-ui`, `ui-monospace`); the viewer cannot load a named font.
- Keep it static and self-contained: no script, no link that must be followed, no image or font from outside. An image or font can be embedded as a `data:` URL; it counts toward the 8 MiB.

**What the viewer does with it**

1. **It builds the document itself.** From the plugin's page it takes the content of `<body>` and the `<style>` elements of `<head>`; everything else in the page (`<title>`, `<meta>`, ...) is dropped. It puts that into its own document, which starts with a base style of its own (the theme's text colour, a 14 px system font, some padding, a transparent background; yours come after it and win) and a policy: `Content-Security-Policy: default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`. Under it no request of any kind can be made, whatever the markup says: images and fonts load only from `data:` URLs. The policy comes before any of the plugin's text.
2. **It sanitizes the markup** (DOMPurify, with the HTML, SVG and SVG-filter profiles). It removes these elements: `script`, `link`, `meta`, `base`, `form`, `iframe`, `frame`, `frameset`, `object`, `embed`, `portal`. Removing an element does not always remove what is inside it: `script` and `iframe` go with everything inside them, and so do `noscript`, `noembed`, `noframes`, `plaintext` and `xmp`, which DOMPurify drops by default; for the others (`form`, `object`, `portal`, `frame`, `frameset`, and the elements that cannot have content, `link`, `meta`, `base`, `embed`) only the element itself goes, and its text and child elements stay in the page, sanitized in turn. A `<form>` is replaced by what was inside it. One exception: a `<frameset>` that comes first in the page (nothing but white space before it), or that stands in the place of `<body>` in a whole document, replaces the body when the HTML is parsed, and the page ends up **empty**; after any other content the parser ignores the `<frameset>` tag and what was inside stays. It removes these attributes: `href`, `xlink:href`, `ping`, `action`, `formaction`, `srcset`, `background`, and every event handler (`onclick`, `onload`, ...). `src` is kept only on `img`, `video`, `audio`, `source` and `track` (the elements DOMPurify lets carry a `data:` URL), and only when its value, after leading spaces and tabs are ignored, starts with `data:` in lower case (`^[ \t]*data:`, case-sensitive): `DATA:`, `Data:`, and a scheme with whitespace or control characters inside (`da\nta:`) are removed. On any other element `src` is removed even if it holds a `data:` URL (an `<input type="image">` shows nothing), and **`poster` is always removed**: a `<video poster="data:...">` loses its poster. DOMPurify also drops attributes it does not know (`foo="x"`, `referrerpolicy`) and keeps the usual ones (`class`, `id`, `title`, `style`, `align`, `width`, `height`, `lang`, `dir`, `colspan`, `rowspan`, `aria-*`, `data-*`). Links therefore are plain text and cannot be followed. `<style>` elements and `style` attributes are kept. An inline `<svg>` is kept too (with the rules above applied inside it), which is a way to draw a chart in a page.
3. **It shows the result in a frame with `sandbox=""`**, with no `allow-*` token and `referrerpolicy="no-referrer"`: no script, no navigation, no forms, no pop-ups, and the page has an origin of its own. The frame fills the viewer's tab and scrolls inside, so the page does not report its height and needs no script for it.

**Do not write `url(...)` or `@import` that point outside the page** (`background: url(https://...)`). The sanitizer leaves them in the CSS; the policy refuses them. The browser starts the request and the policy stops it before anything leaves the process, but it is the policy and not the sanitizer that does it, which is one more reason for a plugin not to depend on it. Colours, borders, fonts and layout need no `url()`; a picture can be a `data:` URL.

That is a second line of defence, not permission to produce such content: **what the plugin outputs is the author's responsibility**, and a page that depends on removed content is shown without it (a table of links shows the link texts and nothing to click). `tools/check-plugin.mjs` reports the elements, attributes and URLs the viewer would remove.

## Versioning

- There are two version numbers, and they are independent. `abi` is the version of this contract; `version` is the plugin's own.
- The host supports **one ABI major version at a time**. A plugin whose `abi` the host does not support is refused. There is no compatibility layer.
- **A new extension point is a new export function plus a new key in the manifest.** It does not change the ABI major version, and plugins that were built before it keep working. `renderFile` and `dcode_render_file` were added this way, after `renderBlock`; a plugin needs at least one extension point, and only the render functions its manifest declares.
- Within ABI 1, the options object only gains optional fields.
- The version moves to ABI 2 only when an export is removed, or when the signature or the meaning of an existing export changes. Plugins then have to be rebuilt against the new document.

## Conformance checklist

Go through this before you publish a plugin. `tools/check-plugin.mjs` in this repository checks most of it for you: the module shape, the manifest, the signature, the return codes and the SVG and HTML rules (see the README). A pass means the file follows the rules the host applies; it is not a promise that a particular DCode installs it, because the checker cannot see the public key that host remembers for the `id`, the languages and extensions other installed plugins hold, or the state of its disk. Its author diagnostics (arguments, export types, return values, what the viewer would remove from an SVG or HTML page) are stricter than the host's install check on purpose, and it neither sanitizes nor simulates the viewer. What it cannot know, such as whether your plugin's output is correct, stays with you.

**Module**

- [ ] It is a core module with one `memory`, defined in the module and exported, 32-bit, not shared. The initial size is at most 256 MiB.
- [ ] It exports `dcode_plugin_abi_version`, `dcode_alloc` and `dcode_free`, the render function of each extension point its manifest declares (`dcode_render_block` for `renderBlock`, `dcode_render_file` for `renderFile`), and does not export `_start`. If it exports `dcode_render_file`, that function takes exactly 7 parameters.
- [ ] If it exports `_initialize`, the module works when `_initialize` runs once, first, and nothing else sets it up.
- [ ] It has no imports, or only imports from the 46 names of `wasi_snapshot_preview1`. Nothing comes from `env`.
- [ ] Only WebAssembly features listed in [WebAssembly features](#webassembly-features) are used, and no GC types.

**Functions**

- [ ] `dcode_plugin_abi_version()` returns `1`, the same as `abi` in the manifest.
- [ ] `dcode_alloc(0)` returns non-null; a failed allocation returns null.
- [ ] `dcode_free(ptr, len)` releases memory from `dcode_alloc(len)` and the buffer returned in `out`, with the same `len` as at allocation. `dcode_free(ptr, 0)` is harmless.
- [ ] `dcode_render_block` returns `0`, `1`, `-1` or `-2` exactly as the table says, and writes `out` (with an unaligned store) only on `0` and `1`.
- [ ] Invalid UTF-8 in `src`, and `opts` that is not a JSON object, give `-1`.
- [ ] A missing or unknown `theme` means light; unknown option fields are ignored.
- [ ] It does not free the inputs, and works whether or not the host frees them.
- [ ] No input the user can type makes it trap or hang: wrong syntax returns `1` with a message that names the line and the problem. Try empty input, random bytes, very long lines, and a 1 MiB source.
- [ ] Equal inputs give equal output, and nothing is kept between calls.

**File previewer** (`renderFile`)

- [ ] `dcode_render_file` returns `0` (SVG), `2` (HTML), `1` (with a message), `-1` or `-2` exactly as the table says, and writes `out` (with an unaligned store) only on `0`, `1` and `2`. `dcode_render_block` never returns `2`.
- [ ] `name` that is not valid UTF-8, and `opts` that is not a JSON object, give `-1`. `data` is never invalid.
- [ ] Any bytes give `0`, `1` or `2` and never a trap or a hang: an empty file, one byte, random bytes, a damaged copy of a real file, a file with the right extension and the wrong content, 32 MiB of anything. The last finishes within 5 s and 256 MiB of linear memory and gives at most 8 MiB of output.
- [ ] A file that is not in the format returns `1` with a message that says so.
- [ ] The file name and every text from the file are escaped in the output. The preview shows a start of a big file and says that it is a part.
- [ ] The HTML has nothing the viewer removes: no `<script>`, `<link>`, `<meta>`, `<base>`, `<form>`, `<iframe>`, `<object>`, `<embed>`; no `href`, `ping`, `action`, `srcset`, `poster` or event handler attribute; `src` only on `img`, `video`, `audio`, `source` and `track`, and only as a `data:` URL; no `<frameset>`. Both themes are drawn and readable.
- [ ] It does not change the inputs, and equal inputs give equal output.

**Manifest and signature**

- [ ] There is exactly one `dcode.plugin` section, and it is UTF-8 JSON with the fields in [Manifest](#manifest), within their length limits, and at least one of `renderBlock` and `renderFile`.
- [ ] `id`, `languages` and `extensions` follow the character rules. If a language is `mermaid` or `wireframe`, you mean to replace DCode's own drawing of it. No extension is one of the formats DCode previews itself.
- [ ] `publicKey` is your minisign public key; the `.wasm` was signed with the matching secret key **after** its last change; `<file>.wasm.minisig` sits next to it. Your plugin's identity is that whole public key, so a later update must use the same one.
- [ ] The secret key is backed up, and is not in version control.

**Output**

- [ ] The SVG is well-formed XML, with an `svg` root element in the SVG namespace, and escaped text.
- [ ] No `<script>`, `<foreignObject>`, `<image>`, `<a>`, `<style>` or animation element; no `style` attribute and no event handler attribute; no backslash and no `image-set(` in any attribute value; no `href` or `url()` that points outside the document, and resource references in `fill`, `stroke`, `mask`, `filter`, `clip-path`, `marker*` and `cursor` only as `url(#id)`. Colours and strokes are presentation attributes.
- [ ] Only generic font families.
- [ ] Both themes are drawn and readable on their surfaces; the SVG has no full-size background.
- [ ] Ids are prefixed with something derived from the source.
- [ ] A source of 1 MiB finishes within 5 s and 256 MiB of linear memory and produces at most 8 MiB.

### What happens at install time

`dcode plugin install` stops at the first failing step and says why: the file is within 32 MiB; the module compiles; the manifest is valid (types, length limits, at least one extension point), and none of its extensions is a format DCode previews itself; the exports the manifest calls for exist (`dcode_render_file` with 7 parameters) and the imports are allowed; the signature is valid (skipped with `--dev`); the key matches the one remembered for this `id`; none of the languages or extensions is claimed by another installed plugin; the memory limit can be applied to the module; finally the host instantiates the module in a worker and calls `dcode_plugin_abi_version()`, which has to return `1`.
