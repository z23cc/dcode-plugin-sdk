# SQLite overview plugin

Previews a SQLite database file in DCode: the tables, views, indexes and triggers, the `CREATE` statements, and the first rows of every table, as a static HTML page. It is the reference **file previewer** (`renderFile`, the second extension point of Plugin ABI 1; see [SPEC.md](../../SPEC.md#dcode_render_file-and-return-values)). Real SQLite ([3.54.1](https://sqlite.org/download.html), the amalgamation) compiled to WebAssembly with [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) as a WASI reactor, with a thin C front end that implements the ABI.

- id: `io.github.z23cc.sqlite-overview`, extensions: `.sqlite`, `.sqlite3`, `.db`
- one `.wasm` file, 716 KiB (301 KiB gzipped); **no imports at all** (not even from `wasi_snapshot_preview1`); exports `memory`, `_initialize`, `dcode_plugin_abi_version`, `dcode_alloc`, `dcode_free`, `dcode_render_file`
- **License:** SQLite is in the public domain. The sources written for this plugin (`src/`, `Makefile`, `fetch-toolchain.sh`, `plugin.json`) are MIT, like the rest of this repository. wasi-libc and the compiler runtime come from wasi-sdk 34.0. See [NOTICE.md](NOTICE.md).

## Install

```sh
dcode plugin install sqlite-overview.wasm          # signed release: needs sqlite-overview.wasm.minisig next to it
dcode plugin install --dev sqlite-overview.wasm    # a build you made yourself, unsigned
```

Then open a `.sqlite`, `.sqlite3` or `.db` file in a workspace tab. A `.db` file that is not a SQLite database is shown as before (the "binary file" placeholder), with the plugin's explanation.

## What it shows

1. A heading with the file name and a count of tables, views, indexes and triggers.
2. **Tables** (not SQLite's own `sqlite_*` tables): for the first 50, the `CREATE` statement (at most 4,000 characters), the columns (from `pragma_table_xinfo`, so generated columns are included; at most 100) and the **first 20 rows**. Cells are cut at 200 characters, a BLOB is shown as `BLOB, N bytes` (it is only measured, never read: `length()` on a column does not load it), `NULL` is shown in italics. The other tables are listed by name.
3. **How many rows:** the plugin never counts. It reads 21 rows: with 20 or fewer it says "N rows", otherwise "At least 21 rows; the first 20 are shown", or, when the database has `sqlite_stat1` (written by `ANALYZE`), "About N rows (an estimate from sqlite_stat1)".
4. **Views** (the first 50 with their `CREATE` statement, the rest by name), **indexes** and **triggers** (one line each: name, table, the statement cut at 200 characters).
5. Virtual tables (FTS5, R-tree, ...) are listed with their `CREATE` statement and no rows: those modules are not compiled in.
6. The page follows the theme (`light` or `dark`) with inline styles. All text is HTML-escaped; bytes that are not UTF-8 and control characters in the file become U+FFFD. The output stops adding rows at 6 MiB and says "Truncated".

### What it says when it cannot

| The file | The plugin returns `1` with |
| --- | --- |
| does not start with `SQLite format 3` (also an empty file) | "Not a SQLite database: ..." |
| starts like SQLite but cannot be read ("file is not a database") | "... it may be encrypted (for example with SQLCipher) or damaged. SQLite says: ..." |
| is damaged ("database disk image is malformed") | "This SQLite database is damaged. SQLite says: ..." |

Damage found while reading one table is shown in the page under that table, and the rest of the overview is still shown.

## Known limits

- **Only the main file is read.** A database in WAL mode keeps recent changes in a separate `-wal` file that a previewer never sees. If the header says WAL, the page says so; if the main file has no tables, it says that the data may still be in the `-wal` file. (A database that was never checkpointed, copied while its writer is still running, looks like that.)
- **At most 32 MiB.** A larger file is not read at all; DCode says it is too large.
- Only the first 20 rows of a table and the first 100 columns. No sorting, no searching, no editing.
- Virtual tables show no rows. A UTF-16 database is read (SQLite converts it); text that is not valid in its encoding is shown with U+FFFD.
- It opens the database **read-only, from memory**, with `SQLITE_DBCONFIG_TRUSTED_SCHEMA` off and `DEFENSIVE` on, so a view or trigger in a hostile file cannot call functions that are not marked safe.

## How it works

The database arrives as bytes, so the plugin never opens a file: `sqlite3_open(":memory:")`, then `sqlite3_deserialize(..., SQLITE_DESERIALIZE_READONLY)` uses the host's copy in place (nothing is copied, nothing is scanned: a preview reads the first pages of each table and stops).

`SQLITE_OS_OTHER=1` removes SQLite's own operating-system layer. `src/vfs.c` implements `sqlite3_os_init` and registers a VFS called `none` that cannot open anything. It exists because the `memdb` VFS (what `sqlite3_deserialize` uses) borrows three services from the default VFS: randomness (a fixed xorshift sequence), sleep (does nothing) and the clock (1970-01-01, like the host's zero clock). Equal inputs give equal outputs.

**WAL.** A header that says "WAL" (bytes 18 and 19 are 2) makes SQLite want shared memory, which `memdb` does not have: it answers "unable to open database file". The plugin opens a copy of the bytes with those two bytes changed to 1 (rollback journal); the pages are the same. The copy costs as much memory as the file (63 MiB in all for a 32 MB database) and about 3 ms.

**Schema.** The first read parses the *entire* schema (every `CREATE` in `sqlite_schema`), so a database with a huge schema is slow before any data is read. That is the one cost that grows with the file and that the plugin does not cap: see the 32 MB row in the table below. It does not omit parts of the SQL language to save size, because a database that uses window functions, CTEs, triggers or generated columns would then be unreadable as a whole, not just in the objects that use them.

| Option | Why |
| --- | --- |
| `SQLITE_OS_OTHER=1` | no operating-system layer; our VFS |
| `SQLITE_THREADSAFE=0` | no threads, no mutexes |
| `SQLITE_TEMP_STORE=3` | temporary tables and sorts stay in memory; there is no file system to put them in |
| `SQLITE_OMIT_LOAD_EXTENSION` | no `dlopen` |
| `SQLITE_DQS=0` | `"word"` is an identifier, never a string |
| `SQLITE_DEFAULT_MEMSTATUS=0` | no allocation statistics |
| `SQLITE_OMIT_SHARED_CACHE`, `_DEPRECATED`, `_DECLTYPE`, `_TRACE`, `_COMPLETE`, `_AUTHORIZATION` | parts of the API that are not used |

Link: `-mexec-model=reactor`, 2 MiB stack, `--max-memory=268435456` (256 MiB, like the host's limit), `-Os` (`-O2` is 1.09 MB and the same speed on these workloads). A progress handler stops a query after about 100 million VM steps (a step count, not a clock). It does not see time spent inside one built-in function: a hostile database can put a `VIRTUAL` generated column such as `length(hex(zeroblob(100000000)))` in a table, and the preview query evaluates it; the 256 MiB memory cap turns that into an in-page "out of memory" within 30 ms (tried), not a hang or a trap.

## Limits we measured

Apple Silicon laptop, Node 24.21, one fresh instance per call (instantiate, `_initialize`, copy the file in, render), the 256 MiB cap in place, 31 calls per row in one process (the first call is the cold one). Times are milliseconds for the whole call. The databases are generated with the `sqlite3` command line and Python; the largest are 32 MB (the host's limit is 33,554,432 bytes).

| Database | Size (bytes) | p50 | max | Output | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| 3 big tables (138k, 90k, 49k rows) + index + view | 32,026,624 | 3 | 12 | 12 KB | cold call in a fresh process: 13 ms |
| the same after `ANALYZE` | 32,030,720 | 3 | 13 | 13 KB | row estimates from `sqlite_stat1` |
| 14 tables, view, indexes, triggers, FTS5, R-tree | 409,600 | 1 | 14 | 16 KB | |
| 500 tables | 2,105,344 | 2 | 14 | 23 KB | 50 detailed, the rest listed by name |
| 5,000 tables | 21,020,672 | 9 | 26 | 42 KB | |
| one table with a 30 MB BLOB + two small ones | 30,072,832 | 3 | 12 | 1.6 KB | the BLOB is shown as `BLOB, 30000000 bytes` |
| WAL header on the 32 MB database | 32,026,624 | 5 | 15 | 13 KB | 63 MiB of memory |
| schema of 18.7 MB (300 tables × 2,000 columns) | 18,681,856 | 723 | 780 | 373 KB | |
| **schema of 32.4 MB (520 tables × 2,000 columns)** | 32,378,880 | **1,343** | **1,381** | 377 KB | **the worst case found**: parsing the schema is the cost; 97 MiB of memory |
| 40 tables × 150 columns of 300 quotes (escapes 6×), 46 MB | 45,961,216 | 19 | 34 | 6.3 MB | the output cap works; this file is over the 32 MiB the host accepts |
| expensive `VIRTUAL` generated columns | 12,288 | 22 | 28 | 1.6 KB | "out of memory" in the page, 241 MiB of memory |
| not SQLite (text) / empty file | 39 / 0 | 0 | 1 | 70 B | return `1` |
| `SQLite format 3\0` + 1 MiB of random bytes | 1,048,592 | 0 | 6 | 169 B | return `1`: "may be encrypted ... or damaged" |
| 32 MB database cut in half | 16,013,312 | 3 | 8 | 79 B | return `1`: "database is damaged" |
| main file of a WAL database that was never checkpointed | 4,096 | 0 | 10 | 1.1 KB | "0 tables" and the WAL note |

Typical databases take under 30 ms. The worst case is a schema near the 32 MiB limit, about 1.4 s here; a machine three times slower would still finish within the host's 5 s, with less room.

### Fuzzing

A mutation fuzzer calls the plugin in a fresh instance for each input and has a watchdog of 5 s per case. It changes 1 to 4 things per input: random bytes anywhere, bytes in the 100-byte header or in page 1, a whole page zeroed, filled with garbage, swapped or duplicated, the file truncated (anywhere, or at a page boundary) or extended with garbage, B-tree page header fields (type, first free block, cell count, cell content area, right-most pointer) and database header fields (page size, file format, reserved bytes, page counts, schema cookie, text encoding, auto-vacuum) set to extreme values, sometimes with the magic restored. Inputs: 334,400 runs over 18 databases (a rich schema with views, triggers, partial and expression indexes, FTS5, R-tree, generated columns, JSON; tricky text; 500 tables; 64 KiB pages; UTF-16 databases; auto-vacuum; a generated column nested 990 deep; WAL main files; the 32 MB database with and without `ANALYZE`; the 30 MB BLOB; the 18.7 MB schema). Result, on the signed release build: every run returned `1` or `2` with UTF-8 output within 8 MiB; no trap, no hang, no out-of-bounds output pointer, no input changed. The slowest were the 300 runs on the 18.7 MB schema (up to 1.7 s, 19 of them over 1 s, with 18 workers running at once); every other run took 114 ms or less. An earlier, smaller round found one bug, now fixed: SQLite's error messages quote names from the file, so the message was not always valid UTF-8; messages are now cut to 1,000 bytes and cleaned.

`tools/check-plugin.mjs` ([README](../../README.md#check)) runs a shorter version of the same ideas on any previewer.

## Build

You need `make`, `xxd`, `curl`, `unzip` and a POSIX shell. Everything else is downloaded, pinned and checksum-verified.

```sh
./fetch-toolchain.sh                 # wasi-sdk 34.0 -> ~/.local/opt, SQLite 3.54.1 amalgamation -> ~/.local/src
make clean && make                   # -> dist/sqlite-overview.wasm
minisign -S -m dist/sqlite-overview.wasm   # -> dist/sqlite-overview.wasm.minisig
```

The build is reproducible: building with the toolchain from `fetch-toolchain.sh` in two different directories, from two copies of the sources in different places, gives the same bytes, and no build path is in the binary. **Run `make clean` before the build you sign**: the Makefile does not track `OPT` or `EXTRA_CFLAGS`, and macOS's GNU Make 3.81 compares timestamps by the second, so an object rebuilt in the same second as the `.wasm` does not relink it.

`fetch-toolchain.sh` records the SHA-256 of every archive (SQLite: `0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9` for `sqlite-amalgamation-3540100.zip`; sqlite.org publishes only SHA3-256, `92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30`, which matched the same file) and unpacks them outside this repository; nothing from the unpacked trees is run.

To try it on a database of your own making:

```sh
sqlite3 sample.db "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t(name) VALUES ('a'), ('b');"
printf 'not a database' > notadb.db
node ../../tools/check-plugin.mjs dist/sqlite-overview.wasm --dev --file-sample sample.db --bad-file-sample notadb.db --out preview
```

### Files

| File | Purpose |
| --- | --- |
| `src/plugin.c` | The ABI front end (`dcode_render_file`) and the overview |
| `src/vfs.c` | `sqlite3_os_init`: the VFS that cannot open files |
| `Makefile` | SQLite options, compile and link flags |
| `fetch-toolchain.sh` | Pinned, checksum-verified download of wasi-sdk and SQLite |
| `plugin.json` | The manifest (`renderFile` instead of `renderBlock`) |
| `NOTICE.md` | Licenses of what is inside the binary |

### WebAssembly features used

Sign-extension, non-trapping float-to-int, bulk memory and reference types (the explicit table index in `call_indirect`): what wasi-sdk 34 emits by default. No SIMD, atomics, exceptions or GC; the disassembly has none of those instructions. See "WebAssembly features" in [SPEC.md](../../SPEC.md).
