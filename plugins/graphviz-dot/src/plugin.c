/* DCode Plugin ABI 1 front end for Graphviz `dot`. See SPEC.md.
 *
 * Every call runs in a fresh instance that is thrown away afterwards, so this
 * file does not free the graph or the Graphviz context: the host reclaims the
 * whole linear memory. Only the buffer handed back to the host is malloc'd
 * so that dcode_free() can release it. */

#include <ctype.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <cgraph/cgraph.h>
#include <common/color.h>
#include <common/colorprocs.h>
#include <gvc/gvc.h>

/* The manifest (`dcode.plugin` custom section) comes from plugin.json via the
 * Makefile; see manifest.s there. */

/* ---- ABI glue ------------------------------------------------------------ */

typedef struct {
  uint8_t *ptr;
  size_t len;
} dcode_buf;

uint32_t dcode_plugin_abi_version(void) { return 1; }

uint8_t *dcode_alloc(size_t len) { return malloc(len ? len : 1); }

void dcode_free(uint8_t *ptr, size_t len) {
  (void)len;
  free(ptr);
}

static void scrub_utf8(uint8_t *p, size_t n);

static int32_t give(dcode_buf *out, const char *s, size_t n) {
  uint8_t *p = dcode_alloc(n);
  if (p == NULL)
    return -2;
  memcpy(p, s, n);
  scrub_utf8(p, n);
  dcode_buf result = {p, n};
  memcpy(out, &result, sizeof result); /* `out` has no alignment guarantee */
  return 0;
}

/* ---- helpers ------------------------------------------------------------- */

/* Length of the well-formed UTF-8 sequence at s (at most n bytes), or 0. */
static size_t utf8_seq(const unsigned char *s, size_t n) {
  unsigned char c = s[0];
  size_t extra;
  uint32_t cp, min;
  if (c < 0x80) return 1;
  else if ((c & 0xE0) == 0xC0) { extra = 1; cp = c & 0x1F; min = 0x80; }
  else if ((c & 0xF0) == 0xE0) { extra = 2; cp = c & 0x0F; min = 0x800; }
  else if ((c & 0xF8) == 0xF0) { extra = 3; cp = c & 0x07; min = 0x10000; }
  else return 0;
  if (extra >= n) return 0;
  for (size_t k = 1; k <= extra; k++) {
    if ((s[k] & 0xC0) != 0x80) return 0;
    cp = (cp << 6) | (s[k] & 0x3F);
  }
  if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return 0;
  return extra + 1;
}

static int valid_utf8(const unsigned char *s, size_t n) {
  for (size_t i = 0; i < n;) {
    size_t k = utf8_seq(s + i, n - i);
    if (k == 0) return 0;
    i += k;
  }
  return 1;
}

/* Graphviz's messages quote the text near an error and can cut a multi-byte
 * character in half. Anything handed to the host must be UTF-8, so overwrite
 * each stray byte with '?' (same length, nothing moves). */
static void scrub_utf8(uint8_t *p, size_t n) {
  for (size_t i = 0; i < n;) {
    size_t k = utf8_seq(p + i, n - i);
    if (k == 0) p[i++] = '?';
    else i += k;
  }
}

/* Graphviz reports problems through this hook; keep the text so a failed
 * render can tell the user what and where. */
static char errbuf[4096];
static size_t errlen;
static int saw_error; /* Graphviz reported at least one "Error:" (warnings do not count) */

static int on_error(char *msg) {
  if (strstr(msg, "libexpat")) {
    /* HTML-like labels need an XML parser this build does not include. Without
     * this the node would silently lose its label. */
    static const char note[] =
        "HTML-like labels (label=<...>) are not supported by this plugin; use plain or record labels\n";
    memcpy(errbuf, note, sizeof note);
    errlen = sizeof note - 1;
    saw_error = 1;
    return 0;
  }
  if (strncmp(msg, "Error", 5) == 0) saw_error = 1;
  size_t n = strlen(msg);
  if (errlen + n >= sizeof errbuf)
    n = sizeof errbuf - 1 - errlen;
  memcpy(errbuf + errlen, msg, n);
  errlen += n;
  errbuf[errlen] = 0;
  return 0;
}

static int32_t fail(dcode_buf *out, const char *fallback) {
  const char *m = errlen ? errbuf : fallback;
  size_t n = errlen ? errlen : strlen(fallback);
  if (n >= 7 && strncmp(m, "Error: ", 7) == 0) { m += 7; n -= 7; } /* drop Graphviz's prefix */
  while (n && (m[n - 1] == '\n' || m[n - 1] == ' ')) n--;
  return give(out, m, n) == 0 ? 1 : -2;
}

/* ---- theme --------------------------------------------------------------- */

#define INK_DARK "#d4d4d4"

/* Give every object that does not set `name` itself the default `val`,
 * without overriding a default the author wrote in the source. */
static void default_attr(Agraph_t *g, int kind, const char *name, const char *val) {
  Agsym_t *sym = agattr(g, kind, (char *)name, NULL);
  if (sym == NULL || sym->defval == NULL || sym->defval[0] == '\0')
    agattr(g, kind, (char *)name, (char *)val);
}

/* 1 if `color` is dark enough that light text is needed on top of it. */
static int is_dark_color(const char *color) {
  char buf[64];
  size_t n = strcspn(color, ":;");
  if (n == 0 || n >= sizeof buf) return 0;
  memcpy(buf, color, n);
  buf[n] = 0;
  gvcolor_t c;
  if (colorxlate(buf, &c, RGBA_BYTE) != COLOR_OK) return 0;
  if (c.u.rgba[3] < 128) return 0; /* mostly transparent: the page shows through */
  return 0.299 * c.u.rgba[0] + 0.587 * c.u.rgba[1] + 0.114 * c.u.rgba[2] < 140.0;
}

static const char *get(void *obj, const char *name) {
  const char *v = agget(obj, (char *)name);
  return v ? v : "";
}

#define INK_LIGHT_SURFACE "#000000" /* ink on a light surface; hex so Graphviz writes fill="#000000" instead of omitting it */
#define TEXT_ON_DARK "#ffffff"

/* True if `v` is one of the colours the theme code itself may have written, or
 * nothing at all: such a value is "no author choice" and may be recomputed. */
static int is_theme_ink(const char *v) {
  return v[0] == '\0' || strcmp(v, INK_DARK) == 0 || strcmp(v, INK_LIGHT_SURFACE) == 0 ||
         strcmp(v, TEXT_ON_DARK) == 0 || strcmp(v, "black") == 0 || strcmp(v, "white") == 0;
}

static void set_attr(void *obj, Agraph_t *root, int kind, const char *name, const char *val) {
  Agsym_t *sym = agattr(root, kind, (char *)name, NULL);
  if (sym) agxset(obj, sym, (char *)val);
}

/* The explicit fill of a node or cluster, or "" if it has none. */
static const char *fill_of(void *obj, int cluster) {
  const char *style = get(obj, "style");
  const char *fill = get(obj, "fillcolor");
  if (cluster && fill[0] == '\0') {
    const char *bg = get(obj, "bgcolor");
    if (bg[0] && strcmp(bg, "transparent") != 0) fill = bg;
  }
  if (fill[0] == '\0' && strstr(style, "filled")) {
    fill = get(obj, "color");
    if (fill[0] == '\0' || strcmp(fill, INK_DARK) == 0) fill = "lightgrey";
  }
  if (!cluster && !strstr(style, "filled")) return "";
  return fill;
}

/* A filled node without a fillcolor is painted in its `color`, so that
 * attribute must keep meaning "fill" and cannot be repurposed as ink. */
static int color_is_fill(Agnode_t *n) {
  return strstr(get(n, "style"), "filled") && get(n, "fillcolor")[0] == '\0';
}

/* Nodes pick black or white text from their own fill unless the author chose a
 * font colour: Graphviz's default would be unreadable on a dark fill, and on a
 * dark page the default ink is light, which is unreadable on a light fill. */
static void fix_text_on_fill(Agnode_t *n, Agraph_t *root) {
  const char *fill = fill_of(n, 0);
  if (fill[0] == '\0' || !is_theme_ink(get(n, "fontcolor"))) return;
  set_attr(n, root, AGNODE, "fontcolor", is_dark_color(fill) ? TEXT_ON_DARK : INK_LIGHT_SURFACE);
}

/* Clusters nest, and each may paint its own background. Walk them outside in;
 * everything directly inside a cluster is drawn in the ink that suits the
 * nearest explicit fill around it. `light` says whether that surface is light. */
static void theme_clusters(Agraph_t *g, Agraph_t *root, int light) {
  for (Agraph_t *sg = agfstsubg(g); sg; sg = agnxtsubg(sg)) {
    int here = light;
    if (strncmp(agnameof(sg), "cluster", 7) == 0) {
      const char *fill = fill_of(sg, 1);
      if (fill[0]) here = !is_dark_color(fill);
      const char *ink = here ? INK_LIGHT_SURFACE : INK_DARK;
      if (is_theme_ink(get(sg, "fontcolor"))) set_attr(sg, root, AGRAPH, "fontcolor", ink);
      for (Agnode_t *n = agfstnode(sg); n; n = agnxtnode(sg, n)) {
        if (is_theme_ink(get(n, "color")) && !color_is_fill(n)) set_attr(n, root, AGNODE, "color", ink);
        if (is_theme_ink(get(n, "fontcolor"))) set_attr(n, root, AGNODE, "fontcolor", ink);
        for (Agedge_t *e = agfstout(sg, n); e; e = agnxtout(sg, e)) {
          if (is_theme_ink(get(e, "color"))) set_attr(e, root, AGEDGE, "color", ink);
          if (is_theme_ink(get(e, "fontcolor"))) set_attr(e, root, AGEDGE, "fontcolor", ink);
        }
      }
    }
    theme_clusters(sg, root, here);
  }
}

static void apply_theme(Agraph_t *g, int dark) {
  /* The surface the diagram sits on: the theme's page, unless the author paints
   * the whole graph with an explicit background. */
  const char *bg = get(g, "bgcolor");
  int explicit_bg = bg[0] && strcmp(bg, "transparent") != 0;
  int light = explicit_bg ? !is_dark_color(bg) : !dark;
  const char *ink = light ? INK_LIGHT_SURFACE : INK_DARK;

  default_attr(g, AGRAPH, "bgcolor", "transparent");
  default_attr(g, AGRAPH, "fontname", "Helvetica");
  default_attr(g, AGNODE, "fontname", "Helvetica");
  default_attr(g, AGEDGE, "fontname", "Helvetica");
  default_attr(g, AGRAPH, "fontcolor", ink);
  default_attr(g, AGNODE, "fontcolor", ink);
  default_attr(g, AGEDGE, "fontcolor", ink);
  if (!light) {
    /* On a light surface Graphviz's own default (black) is right, and leaving
     * `color` unset keeps `style=filled` meaning "light grey fill". */
    default_attr(g, AGRAPH, "color", ink);
    default_attr(g, AGNODE, "color", ink);
    default_attr(g, AGEDGE, "color", ink);
  }
  theme_clusters(g, g, light);
  for (Agnode_t *n = agfstnode(g); n; n = agnxtnode(g, n)) fix_text_on_fill(n, g);
}

static void blank_graphs(Agraph_t *g, Agsym_t *sym) {
  agxset(g, sym, "");
  for (Agraph_t *sg = agfstsubg(g); sg; sg = agnxtsubg(sg)) blank_graphs(sg, sym);
}

/* Attributes whose text would end up in the SVG where it must not be:
 *  - links, images and style sheets (external references; clusters too);
 *  - `id` and `class`, which Graphviz copies into attribute values unchanged. The
 *    SPEC allows no backslash or image-set( in an attribute value, and a user
 *    chosen id would also clash with the prefixed ones. Graphviz then numbers
 *    the elements itself (node1, edge2, ...) and keeps its own class names.
 * A `layout=` attribute would pick an engine this module does not contain, so
 * it is pinned to dot, the only engine here. */
static void blank_external_attrs(Agraph_t *g) {
  Agsym_t *engine = agattr(g, AGRAPH, "layout", NULL);
  if (engine) agxset(g, engine, "dot");
  static const char *names[] = {"URL", "href", "labelURL", "labelhref", "headURL", "headhref",
                                "tailURL", "tailhref", "edgeURL", "edgehref", "image",
                                "stylesheet", "shapefile", "target", "tooltip", "labeltarget", "labeltooltip",
                                "headtarget", "headtooltip", "tailtarget", "tailtooltip", "edgetarget",
                                "edgetooltip", "id", "class", NULL};
  for (int kind = 0; kind < 3; kind++) {
    for (const char **p = names; *p; p++) {
      Agsym_t *sym = agattr(g, kind, (char *)*p, NULL);
      if (sym == NULL) continue;
      agattr(g, kind, (char *)*p, "");
      if (kind == AGRAPH) {
        blank_graphs(g, sym);
        continue;
      }
      for (Agnode_t *n = agfstnode(g); n; n = agnxtnode(g, n)) {
        if (kind == AGNODE) agxset(n, sym, "");
        else for (Agedge_t *e = agfstout(g, n); e; e = agnxtout(g, e)) agxset(e, sym, "");
      }
    }
  }
}

/* Graphviz writes a font name into `font-family="..."` without escaping it, so a
 * name that contains a quote or an angle bracket would inject markup. Keep the
 * characters real font names use and turn the rest into '_'. */
static void scrub_font_value(void *obj, Agsym_t *sym) {
  const char *v = agxget(obj, sym);
  char buf[256];
  size_t i = 0;
  for (; v[i] && i < sizeof buf - 1; i++) {
    unsigned char c = (unsigned char)v[i];
    int ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == ' ' || c == ',' ||
             c == '.' || c == '_' || c == ':' || c == '-';
    buf[i] = ok ? (char)c : '_';
  }
  buf[i] = '\0';
  agxset(obj, sym, buf);
}

static void scrub_font_graphs(Agraph_t *g, Agsym_t *sym) {
  scrub_font_value(g, sym);
  for (Agraph_t *sg = agfstsubg(g); sg; sg = agnxtsubg(sg)) scrub_font_graphs(sg, sym);
}

static void scrub_font_names(Agraph_t *g) {
  static const char *names[] = {"fontname", "labelfontname", "fontnames", NULL};
  for (int kind = 0; kind < 3; kind++) {
    for (const char **p = names; *p; p++) {
      Agsym_t *sym = agattr(g, kind, (char *)*p, NULL);
      if (sym == NULL) continue;
      if (kind == AGRAPH) {
        scrub_font_graphs(g, sym);
        continue;
      }
      for (Agnode_t *n = agfstnode(g); n; n = agnxtnode(g, n)) {
        if (kind == AGNODE) scrub_font_value(n, sym);
        else for (Agedge_t *e = agfstout(g, n); e; e = agnxtout(g, e)) scrub_font_value(e, sym);
      }
    }
  }
}

/* A few numeric attributes make Graphviz allocate or loop in proportion to
 * their value (`minlen=99999999` creates that many virtual nodes) or push
 * arithmetic out of range (`ratio=inf`, `penwidth="1e9,1e9"` read past a
 * buffer). No real diagram needs them: clamp them to a generous maximum. */
static void clamp_obj(void *obj, Agsym_t *sym, double max) {
  double x = atof(agxget(obj, sym));
  if (isfinite(x) && fabs(x) <= max) return;
  char buf[32];
  snprintf(buf, sizeof buf, "%g", x < 0 ? -max : max);
  agxset(obj, sym, buf);
}

static void clamp_graphs(Agraph_t *g, Agsym_t *sym, double max) {
  clamp_obj(g, sym, max);
  for (Agraph_t *sg = agfstsubg(g); sg; sg = agnxtsubg(sg)) clamp_graphs(sg, sym, max);
}

static void clamp_numeric_attrs(Agraph_t *g) {
  static const struct { int kind; const char *name; double max; } limits[] = {
      {AGNODE, "width", 100},      {AGNODE, "height", 100},    {AGNODE, "fontsize", 500},
      {AGNODE, "penwidth", 20},    {AGNODE, "peripheries", 50}, {AGNODE, "sides", 200},
      {AGNODE, "skew", 100},       {AGNODE, "distortion", 100}, {AGNODE, "margin", 10},
      {AGEDGE, "minlen", 100},     {AGEDGE, "arrowsize", 50},   {AGEDGE, "penwidth", 20},
      {AGEDGE, "fontsize", 500},   {AGEDGE, "labelangle", 360}, {AGEDGE, "labeldistance", 100},
      {AGRAPH, "ratio", 100},      {AGRAPH, "nodesep", 100},    {AGRAPH, "ranksep", 100},
      {AGRAPH, "fontsize", 500},   {AGRAPH, "penwidth", 20},    {AGRAPH, "margin", 10},
      {AGRAPH, "pad", 10},
  };
  for (size_t i = 0; i < sizeof limits / sizeof limits[0]; i++) {
    Agsym_t *sym = agattr(g, limits[i].kind, (char *)limits[i].name, NULL);
    if (sym == NULL) continue;
    if (limits[i].kind == AGRAPH) {
      clamp_graphs(g, sym, limits[i].max);
      continue;
    }
    for (Agnode_t *n = agfstnode(g); n; n = agnxtnode(g, n)) {
      if (limits[i].kind == AGNODE) clamp_obj(n, sym, limits[i].max);
      else for (Agedge_t *e = agfstout(g, n); e; e = agnxtout(g, e)) clamp_obj(e, sym, limits[i].max);
    }
  }
}

/* ---- SVG clean-up --------------------------------------------------------- */

static int starts(const char *s, const char *prefix) { return strncmp(s, prefix, strlen(prefix)) == 0; }

static const char *lower_find(const char *hay, size_t n, const char *needle) {
  size_t m = strlen(needle);
  for (size_t i = 0; i + m <= n; i++) {
    size_t k = 0;
    while (k < m && tolower((unsigned char)hay[i + k]) == needle[k]) k++;
    if (k == m) return hay + i;
  }
  return NULL;
}

static const char *generic_family(const char *v, size_t n) {
  if (lower_find(v, n, "mono") || lower_find(v, n, "courier")) return "monospace";
  if (lower_find(v, n, "sans") || lower_find(v, n, "helvetica") || lower_find(v, n, "arial")) return "sans-serif";
  if (lower_find(v, n, "serif") || lower_find(v, n, "times")) return "serif";
  return "sans-serif";
}

/* Returns a malloc'd, cleaned copy of Graphviz's SVG:
 *  - starts at <svg>: no XML declaration, DOCTYPE, stylesheet or comments;
 *  - drops characters XML 1.0 forbids;
 *  - font-family becomes a generic family;
 *  - every id (and url(#id)) gets `prefix`, so several diagrams can share a page. */
static char *clean_svg(const char *in, size_t n, const char *prefix, size_t *out_len) {
  const char *svg = lower_find(in, n, "<svg");
  if (svg == NULL) return NULL;
  n -= (size_t)(svg - in);
  in = svg;
  int has_xlink = lower_find(in, n, "xlink:") != NULL;
  size_t plen = strlen(prefix);
  char *out = malloc(n + n / 4 + 64 * plen + 64);
  if (out == NULL) return NULL;
  size_t o = 0;
  for (size_t i = 0; i < n;) {
    const char *p = in + i;
    size_t left = n - i;
    if (left >= 4 && starts(p, "<!--")) {
      const char *end = lower_find(p, left, "-->");
      i = end ? (size_t)(end - in) + 3 : n;
      continue;
    }
    if (!has_xlink && left >= 6 && starts(p, " xmlns:xlink=\"")) {
      const char *end = memchr(p + 14, '"', left - 14);
      if (end) { i = (size_t)(end - in) + 1; continue; }
    }
    /* The host removes `style` attributes (SPEC: SVG output). Graphviz writes
     * gradient stops as style="stop-color:red;stop-opacity:1.;", which would
     * turn black, so spell the declarations as presentation attributes. */
    if (left >= 8 && starts(p, " style=\"")) {
      const char *end = memchr(p + 8, '"', left - 8);
      if (end) {
        for (const char *q = p + 8; q < end;) {
          const char *semi = memchr(q, ';', (size_t)(end - q));
          if (semi == NULL) semi = end;
          const char *colon = memchr(q, ':', (size_t)(semi - q));
          size_t nlen = colon ? (size_t)(colon - q) : 0, k = 0;
          while (k < nlen && ((q[k] >= 'a' && q[k] <= 'z') || q[k] == '-')) k++;
          if (colon && nlen > 0 && k == nlen) {
            const char *v = colon + 1;
            size_t vlen = (size_t)(semi - v);
            if (vlen && v[vlen - 1] == '.') vlen--; /* "1." -> "1" */
            out[o++] = ' ';
            memcpy(out + o, q, nlen); o += nlen;
            memcpy(out + o, "=\"", 2); o += 2;
            memcpy(out + o, v, vlen); o += vlen;
            out[o++] = '"';
          }
          q = semi + 1;
        }
        i = (size_t)(end - in) + 1;
        continue;
      }
    }
    if (left >= 4 && starts(p, "id=\"") && i > 0 && in[i - 1] == ' ') {
      memcpy(out + o, "id=\"", 4); o += 4;
      memcpy(out + o, prefix, plen); o += plen;
      i += 4;
      continue;
    }
    if (left >= 5 && starts(p, "url(#")) {
      memcpy(out + o, "url(#", 5); o += 5;
      memcpy(out + o, prefix, plen); o += plen;
      i += 5;
      continue;
    }
    if (left >= 13 && starts(p, "font-family=\"")) {
      const char *end = memchr(p + 13, '"', left - 13);
      if (end) {
        const char *g = generic_family(p + 13, (size_t)(end - (p + 13)));
        o += (size_t)sprintf(out + o, "font-family=\"%s\"", g);
        i = (size_t)(end - in) + 1;
        continue;
      }
    }
    unsigned char c = (unsigned char)*p;
    if (c < 0x20 && c != '\t' && c != '\n' && c != '\r') { i++; continue; }
    out[o++] = (char)c;
    i++;
  }
  out[o] = 0;
  *out_len = o;
  return out;
}

static void id_prefix(char *dst, const unsigned char *src, size_t n, int dark) {
  uint32_t h = 0x811c9dc5u; /* FNV-1a over source and theme */
  for (size_t i = 0; i < n; i++) h = (h ^ src[i]) * 0x01000193u;
  h = (h ^ (uint32_t)dark) * 0x01000193u;
  sprintf(dst, "d%08x-", (unsigned)h);
}

/* ---- options ------------------------------------------------------------- */

/* The only option v1 defines is {"theme":"light"|"dark"}. Anything that is not
 * a JSON object is invalid (-1). Unknown fields are ignored. Instead of a JSON
 * parser this scans for the first top-level key "theme": hosts only ever send
 * a flat object of short scalars, and a miss means "light". */
static int parse_opts(const char *s, size_t n, int *dark) {
  size_t i = 0;
  while (i < n && isspace((unsigned char)s[i])) i++;
  if (i == n || s[i] != '{') return -1;
  size_t depth = 0;
  int in_str = 0;
  *dark = 0;
  for (; i < n; i++) {
    char c = s[i];
    if (in_str) {
      if (c == '\\') i++;
      else if (c == '"') in_str = 0;
      continue;
    }
    if (c == '"') {
      /* A key only at depth 1, followed by ':'. */
      if (depth == 1 && i + 8 <= n && memcmp(s + i, "\"theme\"", 7) == 0) {
        size_t j = i + 7;
        while (j < n && isspace((unsigned char)s[j])) j++;
        if (j < n && s[j] == ':') {
          j++;
          while (j < n && isspace((unsigned char)s[j])) j++;
          if (j + 6 <= n && memcmp(s + j, "\"dark\"", 6) == 0) *dark = 1;
          return 0;
        }
      }
      in_str = 1;
    } else if (c == '{' || c == '[') depth++;
    else if (c == '}' || c == ']') { if (--depth == 0) return 0; }
  }
  return -1; /* unterminated object */
}

/* ---- entry point ---------------------------------------------------------- */

int32_t dcode_render_block(const uint8_t *lang_ptr, size_t lang_len,
                           const uint8_t *src_ptr, size_t src_len,
                           const uint8_t *opts_ptr, size_t opts_len,
                           dcode_buf *out) {
  (void)lang_ptr; (void)lang_len;
  if (out == NULL) return -1;
  const unsigned char *src = src_len ? src_ptr : (const unsigned char *)"";
  if (src_len && src == NULL) return -1;
  if (!valid_utf8(src, src_len)) return -1;
  /* NUL is valid UTF-8 but ends a C string, and Graphviz reads C strings: a
   * source error for the user, not an invalid argument. */
  const unsigned char *nul = src_len ? memchr(src, 0, src_len) : NULL;
  if (nul != NULL) {
    size_t line = 1;
    for (const unsigned char *q = src; q < nul; q++) line += (*q == '\n');
    char msg[96];
    int n = snprintf(msg, sizeof msg, "line %zu: the source contains a NUL character (U+0000)", line);
    return give(out, msg, (size_t)n) == 0 ? 1 : -2;
  }
  int dark;
  if (parse_opts(opts_len ? (const char *)opts_ptr : "", opts_len, &dark) != 0) return -1;

  errlen = 0;
  errbuf[0] = 0;
  saw_error = 0;
  agseterrf(on_error);

  char *text = malloc(src_len + 1);
  if (text == NULL) return -2;
  memcpy(text, src, src_len);
  text[src_len] = 0;

  Agraph_t *g = agmemread(text);
  if (g == NULL) return fail(out, "no graph found: expected `digraph { ... }` or `graph { ... }`");

  GVC_t *gvc = gvContextPlugins(lt_preloaded_symbols, 0);
  apply_theme(g, dark);
  blank_external_attrs(g);
  clamp_numeric_attrs(g);
  scrub_font_names(g);
  if (gvLayout(gvc, g, "dot") != 0 || saw_error) return fail(out, "layout failed");
  char *data = NULL;
  size_t len = 0;
  if (gvRenderData(gvc, g, "svg", &data, &len) != 0 || data == NULL || saw_error)
    return fail(out, "rendering failed");

  if (errlen) fputs(errbuf, stderr); /* warnings: not shown to the user; the host keeps this log for --dev plugins only */

  char prefix[16];
  id_prefix(prefix, src, src_len, dark);
  size_t clean_len = 0;
  char *svg = clean_svg(data, len, prefix, &clean_len);
  if (svg == NULL) return fail(out, "renderer produced no SVG");
  return give(out, svg, clean_len);
}
