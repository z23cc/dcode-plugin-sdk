# Builds dist/sqlite-overview.wasm: SQLite (amalgamation) plus a small ABI front
# end, compiled with wasi-sdk as a WASI reactor module.
#
#   make SQLITE_SRC=~/.local/src/sqlite-amalgamation-3540100 WASI_SDK=~/.local/opt/wasi-sdk-34.0
#
# See fetch-toolchain.sh for how to obtain both, pinned and checksum-verified.
# Only a C compiler, make, xxd and the two trees below are needed.

SQLITE_SRC ?= $(HOME)/.local/src/sqlite-amalgamation-3540100
WASI_SDK   ?= $(HOME)/.local/opt/wasi-sdk-34.0
BUILD      ?= build
OPT        ?= -Os
LDSTRIP    ?= -Wl,--strip-all

CC := $(WASI_SDK)/bin/clang
HERE := $(CURDIR)

# Keep this machine's paths out of the binary.
CFLAGS := --target=wasm32-wasip1 --sysroot=$(WASI_SDK)/share/wasi-sysroot \
  $(OPT) -DNDEBUG -ffile-prefix-map=$(SQLITE_SRC)=sqlite -ffile-prefix-map=$(HERE)=. \
  -I$(SQLITE_SRC)

# How SQLite is configured. Everything not listed keeps SQLite's default.
#   SQLITE_OS_OTHER, THREADSAFE=0   no operating-system layer (src/vfs.c), no threads or mutexes
#   TEMP_STORE=3                    temporary tables and sorts stay in memory: there is no file system
#   OMIT_LOAD_EXTENSION             no dlopen
#   DQS=0                           a "double-quoted" word is an identifier, never a string
#   DEFAULT_MEMSTATUS=0             no allocation statistics (they need a mutex)
#   OMIT_SHARED_CACHE, DEPRECATED, DECLTYPE, TRACE, COMPLETE, AUTHORIZATION   unused parts
# Kept on purpose: pragmas (PRAGMA table_info), triggers, views, virtual tables (they are
# in the schema of real databases), WAL (see README), UTF-16 databases, auto-vacuum.
SQLITE_FLAGS := -DSQLITE_OS_OTHER=1 -DSQLITE_THREADSAFE=0 -DSQLITE_TEMP_STORE=3 \
  -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_DQS=0 -DSQLITE_DEFAULT_MEMSTATUS=0 \
  -DSQLITE_OMIT_SHARED_CACHE -DSQLITE_OMIT_DEPRECATED -DSQLITE_OMIT_DECLTYPE \
  -DSQLITE_OMIT_TRACE -DSQLITE_OMIT_COMPLETE -DSQLITE_OMIT_AUTHORIZATION

OWN_OBJECTS := $(BUILD)/own/plugin.o $(BUILD)/own/vfs.o $(BUILD)/own/manifest.o
SQLITE_OBJECT := $(BUILD)/sqlite/sqlite3.o

EXPORTS := dcode_plugin_abi_version dcode_alloc dcode_free dcode_render_file
comma := ,

dist/sqlite-overview.wasm: $(SQLITE_OBJECT) $(OWN_OBJECTS)
	@mkdir -p dist
	@echo LD $@
	@$(CC) $(CFLAGS) -mexec-model=reactor -Wl,--no-entry -Wl,--gc-sections $(LDSTRIP) \
	  -Wl,-z,stack-size=2097152 -Wl,--max-memory=268435456 \
	  $(addprefix -Wl$(comma)--export=,$(EXPORTS)) \
	  $(OWN_OBJECTS) $(SQLITE_OBJECT) -o $@
	@echo "built $@ ($$(wc -c < $@) bytes, $$(gzip -9 -c $@ | wc -c) gzipped)"

$(BUILD)/sqlite/sqlite3.o: $(SQLITE_SRC)/sqlite3.c
	@mkdir -p $(dir $@)
	@echo CC $<
	@$(CC) $(CFLAGS) $(SQLITE_FLAGS) -c $< -o $@

$(BUILD)/own/%.o: src/%.c
	@mkdir -p $(dir $@)
	@echo CC $<
	@$(CC) $(CFLAGS) $(EXTRA_CFLAGS) -c $< -o $@

# plugin.json as a `dcode.plugin` custom section. LLVM turns a section named
# `.custom_section.<name>` in an assembly file into a wasm custom section; the
# same attribute on a C variable only makes a data segment.
$(BUILD)/own/manifest.s: plugin.json
	@mkdir -p $(dir $@)
	{ printf '.section .custom_section.dcode.plugin,"",@\n'; \
	  xxd -i < plugin.json | sed 's/^ */\t.byte /; s/,$$//'; } > $@

$(BUILD)/own/manifest.o: $(BUILD)/own/manifest.s
	@$(CC) --target=wasm32-wasip1 -c $< -o $@

clean:
	rm -rf $(BUILD) dist

.PHONY: clean
