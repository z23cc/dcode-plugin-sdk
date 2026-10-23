# Builds dist/graphviz-dot.wasm: a trimmed Graphviz (dot layout + SVG output)
# compiled with wasi-sdk as a WASI reactor module.
#
#   make GRAPHVIZ_SRC=~/.local/src/graphviz-16.1.0 WASI_SDK=~/.local/opt/wasi-sdk-34.0
#
# See fetch-toolchain.sh for how to obtain both, pinned and checksum-verified.
# Only a C compiler, make and the two trees below are needed.

GRAPHVIZ_SRC ?= $(HOME)/.local/src/graphviz-16.1.0
WASI_SDK     ?= $(HOME)/.local/opt/wasi-sdk-34.0
BUILD        ?= build
OPT          ?= -O2
LDSTRIP      ?= -Wl,--strip-all

CC := $(WASI_SDK)/bin/clang
HERE := $(CURDIR)
LIB := $(GRAPHVIZ_SRC)/lib

# Keep this machine's paths out of the binary (assert messages, __FILE__).
CFLAGS := --target=wasm32-wasip1 --sysroot=$(WASI_SDK)/share/wasi-sysroot \
  $(OPT) -DNDEBUG -DHAVE_CONFIG_H -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -w \
  -ffile-prefix-map=$(GRAPHVIZ_SRC)=graphviz -ffile-prefix-map=$(HERE)=. \
  -I$(HERE) -I$(LIB) -I$(LIB)/cdt -I$(LIB)/cgraph -I$(LIB)/common -I$(LIB)/gvc \
  -I$(LIB)/pathplan -I$(LIB)/pack -I$(LIB)/label -I$(LIB)/xdot -I$(LIB)/util \
  -I$(LIB)/dotgen -I$(LIB)/ortho -I$(LIB)/sparse -I$(LIB)/rbtree -I$(GRAPHVIZ_SRC)

# Graphviz sources, relative to GRAPHVIZ_SRC.
GV_CDT := dtclose dtdisc dtextract dtflatten dthash dtmethod dtopen dtrenew dtrestore dtsize dtstat dtstrhash dttree dtview dtwalk
GV_CGRAPH := acyclic agerror apply attr edge graph grammar id imap io node node_induce obj rec refstr scan subg utils write
GV_COMMON := arrows args colxlate ellipse emit geom globals htmllex htmlparse htmltable input labels ns output pointset postproc psusershape routespl shapes splines taper textspan textspan_lut timing utils
GV_GVC := gvc gvconfig gvcontext gvdevice gvevent gvjobs gvlayout gvloadimage gvplugin gvrender gvtextlayout gvusershape
GV_DOTGEN := acyclic aspect class1 class2 cluster compound conc decomp dotinit dotsplines fastgr flat mincross position rank sameport
GV_PACK := ccomps pack
GV_LABEL := index node rectangle split.q xlabels
GV_UTIL := arena base64 gv_fopen gv_find_me list random xml
GV_PATHPLAN := cvt inpoly route shortest shortestpth solvers triang util visibility
GV_ORTHO := fPQ maze ortho partition rawgraph sgraph trapezoid
GV_SPARSE := SparseMatrix
GV_RBTREE := red_black_tree

GV_SOURCES := \
  $(addprefix lib/cdt/,$(addsuffix .c,$(GV_CDT))) \
  $(addprefix lib/cgraph/,$(addsuffix .c,$(GV_CGRAPH))) \
  $(addprefix lib/common/,$(addsuffix .c,$(GV_COMMON))) \
  $(addprefix lib/gvc/,$(addsuffix .c,$(GV_GVC))) \
  $(addprefix lib/dotgen/,$(addsuffix .c,$(GV_DOTGEN))) \
  $(addprefix lib/pack/,$(addsuffix .c,$(GV_PACK))) \
  $(addprefix lib/label/,$(addsuffix .c,$(GV_LABEL))) \
  lib/xdot/xdot.c \
  $(addprefix lib/util/,$(addsuffix .c,$(GV_UTIL))) \
  $(addprefix lib/pathplan/,$(addsuffix .c,$(GV_PATHPLAN))) \
  $(addprefix lib/ortho/,$(addsuffix .c,$(GV_ORTHO))) \
  $(addprefix lib/sparse/,$(addsuffix .c,$(GV_SPARSE))) \
  $(addprefix lib/rbtree/,$(addsuffix .c,$(GV_RBTREE))) \
  plugin/dot_layout/gvplugin_dot_layout.c plugin/dot_layout/gvlayout_dot_layout.c \
  plugin/core/gvrender_core_svg.c

GV_OBJECTS := $(patsubst %.c,$(BUILD)/gv/%.o,$(GV_SOURCES))
OWN_OBJECTS := $(BUILD)/own/plugin.o $(BUILD)/own/builtins.o $(BUILD)/own/manifest.o

EXPORTS := dcode_plugin_abi_version dcode_alloc dcode_free dcode_render_block

dist/graphviz-dot.wasm: $(GV_OBJECTS) $(OWN_OBJECTS)
	@mkdir -p dist
	@echo LD $@
	@$(CC) $(CFLAGS) -mexec-model=reactor -Wl,--no-entry -Wl,--gc-sections $(LDSTRIP) \
	  -Wl,-z,stack-size=4194304 \
	  $(addprefix -Wl$(comma)--export=,$(EXPORTS)) \
	  $(OWN_OBJECTS) $(GV_OBJECTS) -lm -lwasi-emulated-signal -lwasi-emulated-process-clocks -o $@
	@echo "built $@ ($$(wc -c < $@) bytes, $$(gzip -9 -c $@ | wc -c) gzipped)"

comma := ,

$(BUILD)/gv/%.o: $(GRAPHVIZ_SRC)/%.c
	@mkdir -p $(dir $@)
	@echo CC $<
	@$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/own/%.o: src/%.c
	@mkdir -p $(dir $@)
	@echo CC $<
	@$(CC) $(CFLAGS) -c $< -o $@

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
