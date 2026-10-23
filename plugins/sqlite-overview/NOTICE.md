# Notices for `sqlite-overview.wasm`

The binary `sqlite-overview.wasm` is built from the sources in this directory together with
the third-party code listed here. The files written for this plugin (`src/`, `Makefile`,
`fetch-toolchain.sh`, `plugin.json`) are MIT licensed like the rest of this repository.

## SQLite 3.54.1 (public domain)

- SQLite is in the public domain. The authors dedicated it to the public domain and
  disclaim copyright. See <https://sqlite.org/copyright.html>. The binary contains the
  amalgamation source `sqlite3.c`, unmodified, compiled with the options in the `Makefile`.
- The exact source release is `sqlite-amalgamation-3540100.zip`, available at
  <https://sqlite.org/2026/sqlite-amalgamation-3540100.zip> (SHA-256
  `0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9`; sqlite.org lists its
  SHA3-256, `92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30`, which matches).
  `fetch-toolchain.sh` downloads and verifies it, and `make` builds the binary from it with
  the files in this directory, so anyone can rebuild `sqlite-overview.wasm` from source.
- Every source file of SQLite carries its blessing, which `sqlite3.c` repeats:

  ```
  May you do good and not evil.
  May you find forgiveness for yourself and forgive others.
  May you share freely, never taking more than you give.
  ```

## wasi-libc and compiler runtime (from wasi-sdk 34.0)

The module is statically linked with wasi-libc and the LLVM compiler runtime, taken unmodified
from wasi-sdk 34.0 (<https://github.com/WebAssembly/wasi-sdk>).

- wasi-libc is licensed `Apache-2.0 WITH LLVM-exception`, `Apache-2.0` and `MIT`. It includes
  code derived from musl libc (MIT) and dlmalloc (public domain, CC0). See
  <https://github.com/WebAssembly/wasi-libc> for the license files.
- The compiler runtime is `Apache-2.0 WITH LLVM-exception`.

We found no GPL- or LGPL-licensed code among the sources that go into the binary.
