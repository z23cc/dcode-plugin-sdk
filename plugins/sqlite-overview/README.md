# SQLite overview plugin

Shows an overview of a SQLite database file: the tables, their `CREATE` statements and the first rows. It is a **file previewer** (`renderFile`), the second extension point of Plugin ABI 1, and the first plugin that uses it. Real SQLite ([3.54.1](https://sqlite.org/download.html), the amalgamation) compiled to WebAssembly with [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) as a WASI reactor, with a thin C front end that implements the ABI.

- id: `io.github.z23cc.sqlite-overview`, extensions: `.sqlite`, `.sqlite3`, `.db`
- one `.wasm` file, 714 KiB (300 KiB gzipped); **no imports at all** (not even from `wasi_snapshot_preview1`); exports `_initialize`, `memory` and `dcode_plugin_abi_version`, `dcode_alloc`, `dcode_free`, `dcode_render_file`
- **Status: feasibility build (version 0.1.0).** It works, it is not signed and not released, and the `renderFile` contract it implements is not in [SPEC.md](../../SPEC.md) yet. `tools/check-plugin.mjs` does not know `renderFile` yet either.
- **License:** SQLite is in the public domain. The sources written for this plugin (`src/`, `Makefile`, `fetch-toolchain.sh`, `plugin.json`) are MIT, like the rest of this repository. wasi-libc and the compiler runtime come from wasi-sdk 34.0 (Apache-2.0 WITH LLVM-exception, MIT, public domain; see [`../graphviz-dot/NOTICE.md`](../graphviz-dot/NOTICE.md)).

## The contract this plugin implements

```c
int32_t dcode_render_file(const uint8_t *name, size_t name_len,   /* file name, UTF-8, no path */
                          const uint8_t *data, size_t data_len,   /* the whole file */
                          const uint8_t *opts, size_t opts_len,   /* {"theme":"light"|"dark"} */
                          dcode_buf *out);
```

| Return | Meaning | `out` |
| --- | --- | --- |
| `2` | HTML | a complete HTML document |
| `1` | the file is not something the plugin can read | a message for the person: UTF-8, at most 1000 bytes, control characters and bytes that are not UTF-8 replaced by `?` |
| `-1` | invalid argument (`out` null, `name` not UTF-8, `opts` not a JSON object) | not written |
| `-2` | out of memory | not written |

(`0` is SVG, as for `dcode_render_block`; this plugin never returns it.)

## What it does

1. The file must start with `SQLite format 3\0`; otherwise it returns `1`: "Not a SQLite database: ...".
2. It opens the bytes **read-only and without copying them**: `sqlite3_open(":memory:")` and `sqlite3_deserialize(..., SQLITE_DESERIALIZE_READONLY)`. The first read (the schema) is where a wrong page size, a damaged header, an encrypted file or a truncated file shows up; that returns `1` with SQLite's message ("file is not a database", "database disk image is malformed", ...).
3. For each table (not `sqlite_*`): the `CREATE` statement (at most 4000 characters), the column names (from `pragma_table_xinfo`; at most 100 columns), and the first 20 rows. Cells are cut at 200 characters, a BLOB is shown as `BLOB, N bytes` (it is only measured, never read: `length()` on a column does not load it), `NULL` is shown as such. A table with more than 20 rows says so; the row count is never computed (no unbounded `COUNT(*)`).
4. Only the first 50 tables get this treatment; the rest are listed by name.
5. Virtual tables are listed with their `CREATE` statement; their rows are not read (the modules are not compiled in).
6. All text is HTML-escaped; bytes that are not UTF-8 and control characters become U+FFFD. Output stops adding rows at 6 MiB and says "Truncated".
7. A **WAL-mode** database is opened from a copy of the bytes whose header says "rollback journal" (bytes 18 and 19 changed from 2 to 1). Without that, SQLite cannot open it from memory ("unable to open database file": the WAL needs shared memory, which `memdb` does not have). The pages are the same, so the main file reads fine; changes that are still in the `-wal` file are not visible, and the page says so (the note appears only when the header says WAL). A main file copied while a writer still holds everything in the `-wal` is a valid, nearly empty database: the page says "0 tables" and shows the WAL note.

Safety settings on the connection: `SQLITE_DBCONFIG_DEFENSIVE`, `SQLITE_DBCONFIG_TRUSTED_SCHEMA` off (a view or trigger in a hostile database cannot call functions that are not marked safe), and a progress handler that stops a query after about 100 million VM steps (a step count, not a clock, so equal inputs give equal outputs). The handler does not see time spent inside one built-in function. A hostile database can put a `VIRTUAL` generated column such as `length(hex(zeroblob(100000000)))` in a table, and the preview query evaluates it; the 256 MiB memory cap turns that into an in-page "out of memory" within 30 ms (tried), not a hang or a trap.

## How SQLite is built

`SQLITE_OS_OTHER=1` removes SQLite's own operating-system layer. `src/vfs.c` implements `sqlite3_os_init` and registers a VFS called `none` that cannot open anything. It exists because the `memdb` VFS (what `sqlite3_deserialize` uses) borrows three services from the default VFS: randomness (a fixed xorshift sequence), sleep (does nothing) and the clock (1970-01-01, like the host's zero clock). Nothing in the module reads a file or calls the host.

| Option | Why |
| --- | --- |
| `SQLITE_OS_OTHER=1` | no operating-system layer; our VFS |
| `SQLITE_THREADSAFE=0` | no threads, no mutexes |
| `SQLITE_TEMP_STORE=3` | temporary tables and sorts stay in memory; there is no file system to put them in |
| `SQLITE_OMIT_LOAD_EXTENSION` | no `dlopen` |
| `SQLITE_DQS=0` | `"word"` is an identifier, never a string |
| `SQLITE_DEFAULT_MEMSTATUS=0` | no allocation statistics |
| `SQLITE_OMIT_SHARED_CACHE`, `_DEPRECATED`, `_DECLTYPE`, `_TRACE`, `_COMPLETE`, `_AUTHORIZATION` | parts of the API that are not used |

**Kept on purpose:** the whole SQL grammar and all pragmas. SQLite parses the *entire* schema (every `CREATE` in `sqlite_schema`) the first time it reads the file, so leaving out a language feature (window functions, CTEs, triggers, virtual tables, generated columns, JSON) would make every database that uses it unreadable, not just the objects that use it. UTF-16 databases, auto-vacuum and WAL (see above) are kept for the same reason.

Link: `-mexec-model=reactor`, 2 MiB stack, `--max-memory=268435456` (256 MiB, like the host's limit), `-Os`. The build is reproducible: a clean rebuild gives a byte-identical file, and no build path is in the binary.

## Limits we measured

Apple Silicon laptop, Node 24.21, one fresh instance per call (instantiate, `_initialize`, copy the file in, render), the 256 MiB cap in place, 31 calls per row in one process (the first call is the cold one). Times are milliseconds for the whole call. The databases are generated with the `sqlite3` command line; the largest is 32,026,624 bytes (the host's limit is 33,554,432).

| Database | Size | p50 | max | Output | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| 3 big tables (138k, 90k, 49k rows) + index + view | 32,026,624 | 3 | 12 | 12 KB | cold call in a fresh process: 13 ms |
| 500 tables | 2,105,344 | 2 | 13 | 23 KB | |
| 5,000 tables | 21,020,672 | 9 | 24 | 86 KB | 50 detailed, the rest listed by name |
| 1 table with a 30 MB BLOB + two small ones | 30,072,832 | 3 | 11 | 1.4 KB | the BLOB is shown as `BLOB, 30000000 bytes` |
| WAL-mode header on the 32 MB database | 32,026,624 | 6 | 16 | 12 KB | the extra copy costs 3 ms and 32 MiB of memory (63 MiB in all) |
| Schema of 18.7 MB (300 tables × 2,000 columns) | 18,681,856 | 759 | 778 | 373 KB | parsing the schema is the cost |
| Schema of 32.4 MB (520 tables × 2,000 columns) | 32,378,880 | 1,354 | 1,388 | 376 KB | **the worst case found**; 97 MiB of memory |
| Not SQLite (`.db` that is text) / empty file | 39 / 0 | 0 | 1 | 70 B | return `1` |
| `SQLite format 3\0` + 1 MiB of random bytes | 1,048,592 | 0 | 6 | 56 B | return `1`: "file is not a database" |
| Header only (16 bytes), header + zeros, header + 4 KiB of garbage | ≤ 8,192 | 0 | 6 | 56 B | return `1` |
| 32 MB database cut in half | 16,013,312 | 3 | 9 | 66 B | return `1`: "database disk image is malformed" |

Opening is fast because nothing is copied and nothing is scanned: a table preview reads the first pages of the table and stops. The same build with every table detailed (not what ships) takes 9 ms for 500 tables, 71 ms for 5,000 and 1.6 s for the 32.4 MB schema.

A smoke test flips 1 to 16 random bytes (half of them in the first 8 KiB) of a database and calls the plugin in a fresh instance: 24,000 times over eight small databases (including UTF-16, 64 KiB pages, auto-vacuum, a generated column with 990 nested parentheses) and 300 times over the 32 MB and the BLOB database. No trap, no output that is not UTF-8, no output over the limit, at most 14 ms per call. (It found one bug: SQLite's error messages quote names from the file, so they are not always UTF-8; they are now cleaned.) A real fuzz run is still to do.

## Build

You need `make`, `xxd`, `curl`, `unzip` and a POSIX shell. Everything else is downloaded, pinned and checksum-verified.

```sh
./fetch-toolchain.sh                 # wasi-sdk 34.0 -> ~/.local/opt, SQLite 3.54.1 amalgamation -> ~/.local/src
make                                 # -> dist/sqlite-overview.wasm
```

The Makefile does not track `OPT` or `EXTRA_CFLAGS`, and macOS's GNU Make 3.81 compares timestamps by the second, so an object rebuilt in the same second as the `.wasm` does not relink it: run `make clean` before building the file you measure or sign.

`fetch-toolchain.sh` records the SHA-256 of every archive (SQLite: `0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9` for `sqlite-amalgamation-3540100.zip`; sqlite.org publishes only SHA3-256, `92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30`, which matched the same file) and unpacks them outside this repository; nothing from the unpacked trees is run.

### Files

| File | Purpose |
| --- | --- |
| `src/plugin.c` | The ABI front end (`dcode_render_file`) and the overview |
| `src/vfs.c` | `sqlite3_os_init`: the VFS that cannot open files |
| `Makefile` | SQLite options, compile and link flags |
| `fetch-toolchain.sh` | Pinned, checksum-verified download of wasi-sdk and SQLite |
| `plugin.json` | The manifest (`renderFile` instead of `renderBlock`) |

### WebAssembly features used

Sign-extension, non-trapping float-to-int, bulk memory and reference types (the explicit table index in `call_indirect`): what wasi-sdk 34 emits by default. No SIMD, atomics, exceptions or GC; the disassembly has none of those instructions. See "WebAssembly features" in [SPEC.md](../../SPEC.md).
