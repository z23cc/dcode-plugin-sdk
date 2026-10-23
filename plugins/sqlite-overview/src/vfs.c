/* The operating-system layer for SQLite built with SQLITE_OS_OTHER=1.
 *
 * The plugin never touches a file: the database arrives as bytes and is opened
 * with sqlite3_deserialize(), which uses SQLite's own "memdb" VFS. That VFS
 * still borrows three services from the default VFS (randomness, sleep, the
 * clock) and needs a default VFS to exist, so this registers one that offers
 * exactly those and refuses to open anything.
 *
 * Randomness and time are fixed, so equal inputs give equal outputs. */

#include <string.h>

#include "sqlite3.h"

static int none_open(sqlite3_vfs *vfs, const char *name, sqlite3_file *file, int flags, int *out_flags) {
  (void)vfs; (void)name; (void)file; (void)flags; (void)out_flags;
  return SQLITE_CANTOPEN;
}

static int none_delete(sqlite3_vfs *vfs, const char *name, int sync_dir) {
  (void)vfs; (void)name; (void)sync_dir;
  return SQLITE_IOERR_DELETE;
}

static int none_access(sqlite3_vfs *vfs, const char *name, int flags, int *res) {
  (void)vfs; (void)name; (void)flags;
  *res = 0;
  return SQLITE_OK;
}

static int none_full_pathname(sqlite3_vfs *vfs, const char *name, int n_out, char *out) {
  (void)vfs;
  size_t n = strlen(name);
  if (n_out <= 0 || n >= (size_t)n_out) return SQLITE_CANTOPEN;
  memcpy(out, name, n + 1);
  return SQLITE_OK;
}

/* A fixed xorshift32 sequence; the stream restarts with every instance. */
static int none_randomness(sqlite3_vfs *vfs, int n, char *out) {
  (void)vfs;
  unsigned x = 0x9e3779b9u;
  for (int i = 0; i < n; i++) {
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    out[i] = (char)(x >> 24);
  }
  return n;
}

static int none_sleep(sqlite3_vfs *vfs, int microseconds) {
  (void)vfs; (void)microseconds;
  return 0;
}

/* 1970-01-01 00:00:00 UTC, the zero clock of the host, as a Julian day. */
static int none_current_time_int64(sqlite3_vfs *vfs, sqlite3_int64 *now) {
  (void)vfs;
  *now = 210866760000000LL; /* 2440587.5 days in milliseconds */
  return SQLITE_OK;
}

static int none_current_time(sqlite3_vfs *vfs, double *now) {
  (void)vfs;
  *now = 2440587.5;
  return SQLITE_OK;
}

static int none_last_error(sqlite3_vfs *vfs, int n, char *out) {
  (void)vfs; (void)n; (void)out;
  return 0;
}

static sqlite3_vfs none_vfs = {
    2,                      /* iVersion */
    sizeof(sqlite3_file),   /* szOsFile */
    512,                    /* mxPathname */
    0,                      /* pNext */
    "none",                 /* zName */
    0,                      /* pAppData */
    none_open,
    none_delete,
    none_access,
    none_full_pathname,
    0, 0, 0, 0,             /* xDlOpen, xDlError, xDlSym, xDlClose: no extensions */
    none_randomness,
    none_sleep,
    none_current_time,
    none_last_error,
    none_current_time_int64,
    0, 0, 0,                /* xSetSystemCall, xGetSystemCall, xNextSystemCall */
};

int sqlite3_os_init(void) { return sqlite3_vfs_register(&none_vfs, 1); }

int sqlite3_os_end(void) { return SQLITE_OK; }
