/* Hand-written config.h for building a trimmed Graphviz for wasm32-wasip1
 * (wasi-sdk). It replaces the file `./configure` would generate: no dynamic
 * plugin loading, no cairo/pango/fontconfig/expat/zlib, no GUI toolkits.
 * Everything not listed here is deliberately undefined. */

#define PACKAGE_NAME "graphviz"
#define PACKAGE_TARNAME "graphviz"
#define PACKAGE_VERSION "16.1.0"
#define PACKAGE_STRING "graphviz 16.1.0"
#define PACKAGE_BUGREPORT "https://gitlab.com/graphviz/graphviz/-/issues"
#define PACKAGE_URL "https://graphviz.org/"

#define DEFAULT_DPI 96
#define ORTHO 1

#define STDC_HEADERS 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_UNISTD_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SETENV 1
#define HAVE_DRAND48 1
#define HAVE_SRAND48 1
#define HAVE_MEMRCHR 1
#define HAVE_STRCASESTR 1
