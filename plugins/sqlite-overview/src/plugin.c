/* DCode Plugin ABI 1 front end for SQLite: an overview of a database file.
 * See SPEC.md for the ABI and `renderFile` (dcode_render_file).
 *
 * Every call runs in a fresh instance that is thrown away afterwards, so this
 * file does not close the database or free what it allocated while working:
 * the host reclaims the whole linear memory. Only the buffer handed back to the
 * host is malloc'd, so that dcode_free() can release it. */

#include <ctype.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "sqlite3.h"

#ifndef DETAIL_TABLES
#define DETAIL_TABLES 50 /* tables beyond this many are listed by name only */
#endif
#define PREVIEW_ROWS 20
#define MAX_COLS 100        /* columns shown per table (SQLite allows 2000) */
#define CELL_CHARS 200
#define SQL_CHARS 4000
#define NAME_CHARS 200
#define OUT_SOFT_CAP (6u << 20) /* stop adding rows here; the host refuses more than 8 MiB */
#define OP_BUDGET_CALLS 25000   /* progress-handler calls of 4096 VM steps each: about 100 M steps */

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

static int32_t give(dcode_buf *out, const void *s, size_t n, int32_t rc) {
  uint8_t *p = dcode_alloc(n);
  if (p == NULL)
    return -2;
  memcpy(p, s, n);
  dcode_buf result = {p, n};
  memcpy(out, &result, sizeof result); /* `out` has no alignment guarantee */
  return rc;
}

/* ---- text ---------------------------------------------------------------- */

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

/* Appends s[0..n) as HTML text. Bytes that are not UTF-8 (SQLite text is not
 * required to be) and control characters other than tab and newline become
 * U+FFFD. */
static void esc(sqlite3_str *o, const char *s, size_t n) {
  const unsigned char *u = (const unsigned char *)s;
  size_t i = 0, from = 0;
  while (i < n) {
    unsigned char c = u[i];
    const char *rep = NULL;
    size_t k = 1;
    if (c < 0x80) {
      if (c == '&') rep = "&amp;";
      else if (c == '<') rep = "&lt;";
      else if (c == '>') rep = "&gt;";
      else if (c == '"') rep = "&quot;";
      else if (c == '\'') rep = "&#39;";
      else if ((c < 0x20 && c != '\n' && c != '\t') || c == 0x7f) rep = "\xEF\xBF\xBD";
    } else {
      k = utf8_seq(u + i, n - i);
      if (k == 0) { rep = "\xEF\xBF\xBD"; k = 1; }
    }
    if (rep != NULL) {
      sqlite3_str_append(o, s + from, (int)(i - from));
      sqlite3_str_appendall(o, rep);
      from = i + k;
    }
    i += k;
  }
  sqlite3_str_append(o, s + from, (int)(n - from));
}

/* At most `max` characters of s, escaped, with an ellipsis when it cut. */
static void text(sqlite3_str *o, const char *s, size_t n, size_t max) {
  size_t i = 0, chars = 0;
  while (i < n && chars < max) {
    size_t k = utf8_seq((const unsigned char *)s + i, n - i);
    i += k ? k : 1;
    chars++;
  }
  esc(o, s, i);
  if (i < n) sqlite3_str_appendall(o, "&hellip;");
}

/* A message for the person who opened the file: return value 1. SQLite's
 * messages quote names from the (possibly damaged) file, so they are cut to a
 * sane length and every byte that is not UTF-8 or is a control character
 * becomes '?', in place, so that nothing moves. */
static int32_t say(dcode_buf *out, const char *msg) {
  size_t n = strlen(msg);
  if (n > 1000) n = 1000;
  uint8_t *p = dcode_alloc(n);
  if (p == NULL) return -2;
  memcpy(p, msg, n);
  for (size_t i = 0; i < n;) {
    size_t k = utf8_seq(p + i, n - i);
    if (k == 0 || (k == 1 && (p[i] < 0x20 || p[i] == 0x7f))) { p[i++] = '?'; }
    else i += k;
  }
  dcode_buf result = {p, n};
  memcpy(out, &result, sizeof result);
  return 1;
}

#define put(o, lit) sqlite3_str_appendall((o), lit)

static int full(sqlite3_str *o) { return sqlite3_str_length(o) > (int)OUT_SOFT_CAP; }

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

/* ---- the overview -------------------------------------------------------- */

typedef struct {
  sqlite3 *db;
  sqlite3_str *o;
  sqlite3_stmt *cols; /* column names of a table */
  int truncated;      /* the output reached OUT_SOFT_CAP */
} Ctx;

static int op_budget(void *calls) { return ++*(unsigned *)calls > OP_BUDGET_CALLS; }

static void db_error(Ctx *c) {
  put(c->o, "<p class=e>");
  esc(c->o, sqlite3_errmsg(c->db), strlen(sqlite3_errmsg(c->db)));
  put(c->o, "</p>");
}

/* One cell. The query yields two columns per table column: typeof(c), then
 * the value (a BLOB is only measured, and a long text is cut by SQLite). */
static void cell(sqlite3_str *o, sqlite3_stmt *s, int i) {
  const unsigned char *t = sqlite3_column_text(s, 2 * i);
  if (t == NULL) return;
  switch (t[0]) {
  case 'n': put(o, "<td class=m>NULL</td>"); break;
  case 'b': sqlite3_str_appendf(o, "<td class=m>BLOB, %lld bytes</td>", sqlite3_column_int64(s, 2 * i + 1)); break;
  case 't': {
    const char *v = (const char *)sqlite3_column_text(s, 2 * i + 1);
    int n = sqlite3_column_bytes(s, 2 * i + 1);
    put(o, "<td>");
    if (v != NULL) text(o, v, (size_t)n, CELL_CHARS);
    put(o, "</td>");
    break;
  }
  default: { /* integer, real */
    const char *v = (const char *)sqlite3_column_text(s, 2 * i + 1);
    put(o, "<td class=n>");
    if (v != NULL) esc(o, v, (size_t)sqlite3_column_bytes(s, 2 * i + 1));
    put(o, "</td>");
  }
  }
}

static void table_section(Ctx *c, const char *name, int name_len, const char *sql, int sql_len) {
  sqlite3_str *o = c->o;
  put(o, "<section><h2>");
  text(o, name, (size_t)name_len, NAME_CHARS);
  put(o, "</h2>");
  if (sql != NULL) {
    put(o, "<pre>");
    text(o, sql, (size_t)sql_len, SQL_CHARS);
    put(o, "</pre>");
    if (sqlite3_strnicmp(sql, "CREATE VIRTUAL TABLE", 20) == 0) {
      put(o, "<p class=m>Virtual table: its rows are not shown.</p></section>");
      return;
    }
  }

  /* The columns, and the query that reads them. */
  sqlite3_str *q = sqlite3_str_new(c->db), *h = sqlite3_str_new(c->db);
  int ncol = 0, more_cols = 0, rc;
  put(q, "SELECT ");
  sqlite3_reset(c->cols);
  sqlite3_bind_text(c->cols, 1, name, name_len, SQLITE_STATIC);
  while ((rc = sqlite3_step(c->cols)) == SQLITE_ROW) {
    if (ncol == MAX_COLS) { more_cols = 1; break; }
    const char *cn = (const char *)sqlite3_column_text(c->cols, 0);
    int cn_len = sqlite3_column_bytes(c->cols, 0);
    sqlite3_str_appendf(q,
        "%stypeof(\"%w\"),CASE typeof(\"%w\") WHEN 'blob' THEN length(\"%w\") WHEN 'text' THEN substr(\"%w\",1,%d) ELSE \"%w\" END",
        ncol ? "," : "", cn, cn, cn, cn, CELL_CHARS + 1, cn);
    put(h, "<th>");
    text(h, cn, (size_t)cn_len, NAME_CHARS);
    put(h, "</th>");
    ncol++;
  }
  sqlite3_reset(c->cols);
  if (ncol == 0) {
    if (rc != SQLITE_DONE && rc != SQLITE_ROW) db_error(c);
    else put(o, "<p class=m>No columns.</p>");
    put(o, "</section>");
    return;
  }
  sqlite3_str_appendf(q, " FROM main.\"%w\" LIMIT %d", name, PREVIEW_ROWS + 1);
  char *qs = sqlite3_str_finish(q);
  char *hs = sqlite3_str_finish(h);
  sqlite3_stmt *st = NULL;
  rc = qs ? sqlite3_prepare_v2(c->db, qs, -1, &st, NULL) : SQLITE_NOMEM;
  sqlite3_free(qs);
  if (rc != SQLITE_OK) {
    db_error(c);
    sqlite3_free(hs);
    put(o, "</section>");
    return;
  }

  put(o, "<table><tr>");
  put(o, hs ? hs : "");
  sqlite3_free(hs);
  put(o, "</tr>");
  int nrows = 0, more = 0;
  while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
    if (nrows == PREVIEW_ROWS) { more = 1; break; }
    if (full(o)) { c->truncated = 1; break; }
    put(o, "<tr>");
    for (int i = 0; i < ncol; i++) cell(o, st, i);
    put(o, "</tr>");
    nrows++;
  }
  put(o, "</table>");
  if (rc != SQLITE_ROW && rc != SQLITE_DONE) db_error(c);
  else if (more) sqlite3_str_appendf(o, "<p class=m>The first %d rows; the table has more.</p>", PREVIEW_ROWS);
  else if (nrows == 0) put(o, "<p class=m>Empty table.</p>");
  else sqlite3_str_appendf(o, "<p class=m>%d row%s.</p>", nrows, nrows == 1 ? "" : "s");
  if (more_cols) sqlite3_str_appendf(o, "<p class=m>Only the first %d columns are shown.</p>", MAX_COLS);
  sqlite3_finalize(st);
  put(o, "</section>");
}

static const char MAGIC[16] = "SQLite format 3"; /* the 16th byte is the NUL */

int32_t dcode_render_file(const uint8_t *name_ptr, size_t name_len,
                          const uint8_t *data, size_t data_len,
                          const uint8_t *opts_ptr, size_t opts_len,
                          dcode_buf *out) {
  if (out == NULL) return -1;
  if ((name_len && name_ptr == NULL) || (data_len && data == NULL) || (opts_len && opts_ptr == NULL)) return -1;
  if (!valid_utf8(name_ptr ? name_ptr : (const uint8_t *)"", name_len)) return -1;
  int dark;
  if (parse_opts(opts_len ? (const char *)opts_ptr : "", opts_len, &dark) != 0) return -1;

  if (data_len < sizeof MAGIC || memcmp(data, MAGIC, sizeof MAGIC) != 0)
    return say(out, "Not a SQLite database: the file does not start with \"SQLite format 3\".");

  sqlite3 *db;
  int rc = sqlite3_open_v2(":memory:", &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, NULL);
  if (rc == SQLITE_NOMEM) return -2;
  if (rc != SQLITE_OK) return say(out, "SQLite could not start.");
  sqlite3_db_config(db, SQLITE_DBCONFIG_DEFENSIVE, 1, NULL);
  sqlite3_db_config(db, SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0, NULL);
  unsigned calls = 0;
  sqlite3_progress_handler(db, 4096, op_budget, &calls);

  /* The buffer is the host's and stays untouched; SQLITE_DESERIALIZE_READONLY
   * means SQLite never writes to it either. A database in WAL mode (file format
   * versions 2 in the header) cannot be opened from memory: the WAL needs shared
   * memory, which the memdb VFS does not have, and SQLite answers "unable to open
   * database file". We only have the main file anyway, so open a copy that says
   * "rollback journal" (1): the pages are the same. */
  unsigned flags = SQLITE_DESERIALIZE_READONLY;
  unsigned char *buf = (unsigned char *)data;
  int wal = data_len >= 20 && (data[18] == 2 || data[19] == 2);
  if (wal) {
    buf = sqlite3_malloc64((sqlite3_uint64)data_len);
    if (buf == NULL) return -2;
    memcpy(buf, data, data_len);
    buf[18] = buf[19] = 1;
    flags |= SQLITE_DESERIALIZE_FREEONCLOSE;
  }
  rc = sqlite3_deserialize(db, "main", buf, (sqlite3_int64)data_len, (sqlite3_int64)data_len, flags);
  if (rc != SQLITE_OK) {
    if (rc == SQLITE_NOMEM) return -2;
    sqlite3_str *m = sqlite3_str_new(NULL);
    sqlite3_str_appendf(m, "SQLite could not open this file: %s.", sqlite3_errmsg(db));
    int32_t r = say(out, sqlite3_str_value(m));
    return r;
  }

  /* The first read of the file: a wrong page size, a damaged header or an
   * encrypted file shows up here as "file is not a database" and the like. */
  sqlite3_stmt *st;
  const char *tables_where = "type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'";
  sqlite3_str *qs = sqlite3_str_new(NULL);
  sqlite3_str_appendf(qs, "SELECT count(*) FROM main.sqlite_schema WHERE %s", tables_where);
  rc = sqlite3_prepare_v2(db, sqlite3_str_value(qs), -1, &st, NULL);
  if (rc == SQLITE_OK) rc = sqlite3_step(st);
  if (rc != SQLITE_ROW) {
    if (rc == SQLITE_NOMEM) return -2;
    sqlite3_str *m = sqlite3_str_new(NULL);
    sqlite3_str_appendf(m, "SQLite could not read this file: %s.", sqlite3_errmsg(db));
    return say(out, sqlite3_str_value(m));
  }
  int ntables = sqlite3_column_int(st, 0);
  sqlite3_finalize(st);

  sqlite3_str *o = sqlite3_str_new(NULL);
  Ctx c = {db, o, NULL, 0};
  sqlite3_str_appendf(o,
      "<!doctype html><html><head><meta charset=\"utf-8\"><title>SQLite overview</title><style>"
      "body{font:13px/1.45 system-ui,sans-serif;color:%s;margin:12px}"
      "h1{font-size:16px;margin:0 0 4px}h2{font-size:14px;margin:0 0 6px}section{margin:18px 0}"
      "pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0 8px;padding:6px 8px;background:%s;border:1px solid %s;border-radius:4px;font:12px ui-monospace,monospace}"
      "table{border-collapse:collapse}th,td{border:1px solid %s;padding:2px 6px;text-align:left;vertical-align:top;font:12px ui-monospace,monospace;max-width:420px;overflow-wrap:anywhere}"
      "th{background:%s}.m{opacity:.65}td.m{font-style:italic}.n{text-align:right}.e{color:%s}"
      "</style></head><body>",
      dark ? "#e6edf3" : "#1f2328", dark ? "#161b22" : "#f6f8fa", dark ? "#30363d" : "#d0d7de",
      dark ? "#30363d" : "#d0d7de", dark ? "#161b22" : "#f6f8fa", dark ? "#ff7b72" : "#cf222e");
  put(o, "<h1>");
  text(o, name_ptr ? (const char *)name_ptr : "", name_len, NAME_CHARS);
  sqlite3_str_appendf(o, "</h1><p class=m>SQLite database, %lld bytes, %d table%s.", (long long)data_len, ntables, ntables == 1 ? "" : "s");
  put(o, "</p>");
  if (wal)
    put(o, "<p class=m>This database is in WAL mode. Only the main file was read: changes that are still in the -wal file are not shown.</p>");

  sqlite3_str *tq = sqlite3_str_new(NULL);
  sqlite3_str_appendf(tq, "SELECT name, sql FROM main.sqlite_schema WHERE %s", tables_where);
  rc = sqlite3_prepare_v2(db, sqlite3_str_value(tq), -1, &st, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_prepare_v2(db, "SELECT name FROM pragma_table_xinfo(?1, 'main') WHERE hidden IN (0, 2, 3)", -1, &c.cols, NULL);
  if (rc != SQLITE_OK) {
    if (rc == SQLITE_NOMEM) return -2;
    db_error(&c);
  } else {
    int shown = 0;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
      if (full(o)) { c.truncated = 1; break; }
      const char *name = (const char *)sqlite3_column_text(st, 0);
      int name_len = sqlite3_column_bytes(st, 0);
      const char *sql = (const char *)sqlite3_column_text(st, 1);
      int sql_len = sqlite3_column_bytes(st, 1);
      if (name == NULL) continue;
      if (shown < DETAIL_TABLES) {
        table_section(&c, name, name_len, sql, sql_len);
      } else {
        if (shown == DETAIL_TABLES) put(o, "<section><h2>More tables</h2><p class=m>Only the names are listed.</p><ul>");
        put(o, "<li>");
        text(o, name, (size_t)name_len, NAME_CHARS);
        put(o, "</li>");
      }
      shown++;
    }
    if (shown > DETAIL_TABLES) put(o, "</ul></section>");
    if (rc != SQLITE_DONE && rc != SQLITE_ROW) db_error(&c);
  }
  if (c.truncated) put(o, "<p class=e>Truncated: the overview reached its size limit.</p>");
  put(o, "</body></html>");

  if (sqlite3_str_errcode(o) != 0) return -2;
  return give(out, sqlite3_str_value(o), (size_t)sqlite3_str_length(o), 2);
}
