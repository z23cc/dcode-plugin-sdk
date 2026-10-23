#!/usr/bin/env node
// check-plugin.mjs: check a DCode plugin against SPEC.md, without a DCode host.
//
//   node tools/check-plugin.mjs plugin.wasm --sample example.dot [--sample more.dot]
//                               [--bad-sample broken.dot] [--sig plugin.wasm.minisig]
//                               [--file-sample data.db] [--bad-file-sample notadb.db]
//                               [--dev] [--lang dot] [--out preview-dir] [--fuzz 50] [--show-log]
//
// It is a tool for plugin authors, not a test suite. It needs Node 18 or newer
// and nothing else: no packages, no network, no other programs.
//
// What it does:
//   * reads the module and checks its shape: one 32-bit memory, the exports the
//     manifest calls for (`dcode_render_block` for `renderBlock`, `dcode_render_file`
//     for `renderFile`) and their types, no `_start`, the import allow-list, the
//     manifest section and the manifest rules (including the formats DCode previews
//     itself, which a plugin may not declare);
//   * verifies the minisign signature against the key in the manifest (skipped
//     with --dev);
//   * runs the plugin the way the host does, in a fresh instance for every call
//     with a 5 s time limit and the memory maximum rewritten to 256 MiB, behind
//     WASI stubs that give it no capability;
//   * checks the ABI: dcode_plugin_abi_version, dcode_alloc/dcode_free, return
//     codes, the `out` record (written unaligned, left alone on -1 and -2),
//     inputs left unchanged, options handling;
//   * checks every SVG it returns: well-formed XML, the content SPEC.md forbids,
//     ids and references, font families; and every HTML page a file previewer
//     returns: nothing the DCode viewer would strip (scripts, links, forms, frames,
//     external resources, event handlers);
//   * throws odd inputs at it (empty, huge, random; for a file previewer also
//     32 MiB files and damaged copies of your samples) and expects an answer, not a trap.
//
// `--sample` is a source file in the plugin's language that must render (give
// one or more). `--bad-sample` is a source file with a mistake in it that must
// return 1 with a message. `--file-sample` is a file the plugin must preview
// (`renderFile`); `--bad-file-sample` a file it must answer with 1 and a message
// (for example a `.db` that is not a database). Without samples only the checks
// that do not need a valid input run, and the tool says so.
//
// Exit status 0: no FAIL. WARN lines are advice.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const MEM_MAX_PAGES = 4096; // 256 MiB
const CALL_TIMEOUT_MS = 5000;
const SRC_LIMIT = 1048576;
const OUT_LIMIT = 8 * 1048576;
const FILE_LIMIT = 32 * 1048576; // the largest file the host hands to dcode_render_file
// The formats DCode previews itself; a plugin may not declare them (SPEC.md, renderFile).
// The source of truth is PLUGIN_BUILTIN_PREVIEW_EXTENSIONS in DCode's protocol package.
const BUILTIN_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf", ".docx", ".md", ".markdown", ".mmd", ".mermaid"]);
const LOG_LIMIT = 16384;
const WASI_FUNCS = new Set(
  `args_get args_sizes_get clock_res_get clock_time_get environ_get environ_sizes_get fd_advise fd_allocate fd_close
fd_datasync fd_fdstat_get fd_fdstat_set_flags fd_fdstat_set_rights fd_filestat_get fd_filestat_set_size
fd_filestat_set_times fd_pread fd_prestat_dir_name fd_prestat_get fd_pwrite fd_read fd_readdir fd_renumber fd_seek
fd_sync fd_tell fd_write path_create_directory path_filestat_get path_filestat_set_times path_link path_open
path_readlink path_remove_directory path_rename path_symlink path_unlink_file poll_oneoff proc_exit proc_raise
random_get sched_yield sock_accept sock_recv sock_send sock_shutdown`.split(/\s+/),
);
const GENERIC_FONTS = new Set(["sans-serif", "serif", "monospace", "system-ui"]);
// Presentation attributes that can refer to a resource (`marker*` is matched by prefix).
const RESOURCE_ATTRS = new Set(["fill", "stroke", "mask", "filter", "clip-path", "cursor", "background", "background-image", "list-style-image", "content", "src", "shape-inside", "shape-outside", "border-image-source", "mask-image", "clip", "behavior"]);

// ------------------------------------------------------------------ wasm bytes

function leb(buf, pos) {
  let result = 0, shift = 0, byte;
  do {
    byte = buf[pos++];
    if (byte === undefined || shift > 35) throw new Error("bad LEB128");
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [result, pos];
}
const lebEncode = (v) => {
  const out = [];
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};

/** Reads the sections the checks need. Throws on a malformed module. */
function parseModule(bytes) {
  if (bytes.length < 8 || bytes.subarray(0, 4).toString("latin1") !== "\0asm") throw new Error("not a WebAssembly module (bad magic)");
  if (bytes.readUInt32LE(4) !== 1) throw new Error("not a core module (the version field is not 1): components are not supported");
  const m = { types: [], imports: [], funcTypes: [], memories: [], exports: [], hasStart: false, custom: [], sections: [] };
  const name = (p) => { const [n, q] = leb(bytes, p); return [bytes.toString("utf8", q, q + n), q + n]; };
  let pos = 8;
  while (pos < bytes.length) {
    const id = bytes[pos];
    const [size, p0] = leb(bytes, pos + 1);
    const end = p0 + size;
    if (end > bytes.length) throw new Error("truncated section");
    m.sections.push({ id, start: pos, payload: p0, end });
    let p = p0;
    if (id === 0) {
      const [n, q] = name(p);
      m.custom.push({ name: n, data: bytes.subarray(q, end) });
    } else if (id === 1) {
      let [count, q] = leb(bytes, p);
      for (let i = 0; i < count; i++) {
        // 0x60 is a function type. Anything else (0x5f struct, 0x5e array, 0x4e rec, 0x50/0x4f sub) is
        // WebAssembly GC: the host refuses such modules, so there is no point in reading on.
        const form = bytes[q++];
        if (form !== 0x60) { m.gcForm = form; break; }
        let n; [n, q] = leb(bytes, q); const params = [...bytes.subarray(q, q + n)]; q += n;
        [n, q] = leb(bytes, q); const results = [...bytes.subarray(q, q + n)]; q += n;
        m.types.push({ params, results });
      }
    } else if (id === 2) {
      let [count, q] = leb(bytes, p);
      for (let i = 0; i < count; i++) {
        let mod, nm, idx;
        [mod, q] = name(q); [nm, q] = name(q);
        const kind = bytes[q++];
        if (kind === 0) { [idx, q] = leb(bytes, q); m.funcTypes.push(idx); }
        else if (kind === 1) { q++; const f = bytes[q++]; [, q] = leb(bytes, q); if (f & 1) [, q] = leb(bytes, q); }
        else if (kind === 2) { const f = bytes[q++]; [, q] = leb(bytes, q); if (f & 1) [, q] = leb(bytes, q); }
        else if (kind === 3) q += 2;
        else if (kind === 4) { q++; [, q] = leb(bytes, q); }
        m.imports.push({ module: mod, name: nm, kind: ["function", "table", "memory", "global", "tag"][kind] ?? `kind ${kind}` });
      }
    } else if (id === 3) {
      let [count, q] = leb(bytes, p);
      for (let i = 0; i < count; i++) { let idx; [idx, q] = leb(bytes, q); m.funcTypes.push(idx); }
    } else if (id === 5) {
      let [count, q] = leb(bytes, p);
      for (let i = 0; i < count; i++) {
        const flags = bytes[q++];
        let min, max = null;
        [min, q] = leb(bytes, q);
        if (flags & 1) [max, q] = leb(bytes, q);
        m.memories.push({ flags, min, max, shared: !!(flags & 2), memory64: !!(flags & 4) });
      }
    } else if (id === 7) {
      let [count, q] = leb(bytes, p);
      for (let i = 0; i < count; i++) {
        let nm, idx;
        [nm, q] = name(q);
        const kind = bytes[q++];
        [idx, q] = leb(bytes, q);
        m.exports.push({ name: nm, kind: ["function", "table", "memory", "global", "tag"][kind], index: idx });
      }
    } else if (id === 8) m.hasStart = true;
    pos = end;
  }
  return m;
}

/** What the host does before compiling: give the memory a maximum of 256 MiB. */
function capMemory(bytes, mod) {
  const sec = mod.sections.find((s) => s.id === 5);
  const mem = mod.memories[0];
  const max = Math.min(mem.max ?? Infinity, MEM_MAX_PAGES);
  const payload = [1, 0x01, ...lebEncode(mem.min), ...lebEncode(max)];
  return Buffer.concat([bytes.subarray(0, sec.start), Buffer.from([5, ...lebEncode(payload.length), ...payload]), bytes.subarray(sec.end)]);
}

// -------------------------------------------------------------------- minisign

function minisignKeyId(bytes8) {
  return Buffer.from(bytes8).reverse().toString("hex").toUpperCase(); // as minisign prints it
}
function readPublicKey(b64) {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("ascii") !== "Ed") throw new Error("not a minisign public key (expected 42 bytes starting with 'Ed')");
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}
function verifyMinisign(wasm, sigText, publicKeyB64) {
  const lines = sigText.split(/\r?\n/);
  if (!lines[0]?.startsWith("untrusted comment: ") || !lines[2]?.startsWith("trusted comment: ")) throw new Error("malformed .minisig");
  const raw = Buffer.from(lines[1], "base64");
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (raw.length !== 74 || global.length !== 64) throw new Error("malformed .minisig (bad lengths)");
  const algo = raw.subarray(0, 2).toString("ascii");
  if (algo !== "ED" && algo !== "Ed") throw new Error(`unknown signature algorithm ${JSON.stringify(algo)}`);
  const pub = readPublicKey(publicKeyB64);
  if (!raw.subarray(2, 10).equals(pub.keyId)) throw new Error(`the signature was made with key ${minisignKeyId(raw.subarray(2, 10))}, the manifest has key ${minisignKeyId(pub.keyId)}`);
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.key]), format: "der", type: "spki" });
  const msg = algo === "ED" ? crypto.createHash("blake2b512").update(wasm).digest() : wasm;
  const sig = raw.subarray(10);
  if (!crypto.verify(null, msg, key, sig)) throw new Error("the signature does not match the file (was it signed before the last build?)");
  const trusted = lines[2].slice("trusted comment: ".length);
  if (!crypto.verify(null, Buffer.concat([sig, Buffer.from(trusted, "utf8")]), key, global)) throw new Error("the trusted comment does not match its signature");
  return { keyId: minisignKeyId(pub.keyId), algo, publicKey: pub.key };
}

// -------------------------------------------------------------------- manifest

function checkManifest(text, report) {
  let m;
  try {
    m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(text));
  } catch (e) {
    report.fail("manifest", `the dcode.plugin section is not UTF-8 JSON: ${e.message}`);
    return null;
  }
  if (m === null || typeof m !== "object" || Array.isArray(m)) { report.fail("manifest", "the manifest must be a JSON object"); return null; }
  const nonEmpty = (k) => typeof m[k] === "string" && m[k].length > 0;
  const rule = (ok, what) => (ok ? report.pass("manifest", what) : report.fail("manifest", what));
  rule(nonEmpty("id") && m.id.length <= 64 && /^[a-z0-9]+([.-][a-z0-9]+)*$/.test(m.id), `id ${JSON.stringify(m.id)} matches ^[a-z0-9]+([.-][a-z0-9]+)*$ and is at most 64 characters`);
  if (nonEmpty("id") && !m.id.includes(".")) report.warn("manifest", "id has no '.': reverse-domain notation (io.github.you.name) is recommended");
  rule(nonEmpty("name"), "name is a non-empty string");
  rule(nonEmpty("version") && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(m.version), `version ${JSON.stringify(m.version)} is a semantic version`);
  rule(m.abi === 1, "abi is 1");
  try { readPublicKey(m.publicKey); report.pass("manifest", "publicKey is a minisign public key"); } catch (e) { report.fail("manifest", `publicKey: ${e.message}`); }
  const hasBlock = m.renderBlock !== undefined, hasFile = m.renderFile !== undefined;
  rule(hasBlock || hasFile, "declares renderBlock, renderFile or both (at least one is required)");
  if (hasBlock) {
    const langs = m.renderBlock?.languages;
    if (!Array.isArray(langs) || langs.length < 1 || langs.length > 16) report.fail("manifest", "renderBlock.languages must have 1 to 16 entries");
    else {
      for (const l of langs) {
        if (typeof l !== "string" || !/^[a-z0-9+-]+$/.test(l)) report.fail("manifest", `language ${JSON.stringify(l)}: only lowercase letters, digits, + and -`);
        else if (l === "mermaid" || l === "wireframe") report.pass("manifest", `language ${l} is allowed; an enabled plugin draws it instead of DCode`);
        else report.pass("manifest", `language ${l} is allowed`);
      }
      rule(new Set(langs).size === langs.length, "no language is listed twice");
    }
  }
  if (hasFile) {
    const exts = m.renderFile?.extensions;
    if (!Array.isArray(exts) || exts.length < 1 || exts.length > 16) report.fail("manifest", "renderFile.extensions must have 1 to 16 entries");
    else {
      for (const e of exts) {
        if (typeof e !== "string" || e.length > 16 || !/^\.[a-z0-9][a-z0-9+-]*$/.test(e)) report.fail("manifest", `extension ${JSON.stringify(e)}: a dot, then lowercase letters, digits, + and -; at most 16 characters`);
        else if (BUILTIN_EXTENSIONS.has(e)) report.fail("manifest", `extension ${e}: DCode previews this format itself, so a plugin may not declare it (the install is refused with extension-builtin). Formats DCode cannot open are open to plugins`);
        else report.pass("manifest", `extension ${e} is allowed`);
      }
      rule(new Set(exts).size === exts.length, "no extension is listed twice");
    }
  }
  for (const k of ["description", "homepage"]) if (k in m && typeof m[k] !== "string") report.fail("manifest", `${k} must be a string`);
  return m;
}

// ------------------------------------------------------------------- XML / SVG

/** A small XML 1.0 reader: enough to prove well-formedness of SVG and to walk it. */
function parseXml(text) {
  const fail = (msg, at) => { const line = text.slice(0, at).split("\n").length; throw new Error(`${msg} (line ${line})`); };
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i);
    if (c > 0xffff) i++;
    if (!(c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || c >= 0x10000)) fail(`character U+${c.toString(16).toUpperCase().padStart(4, "0")} is not allowed in XML 1.0`, i);
  }
  const checkEntities = (s, at) => {
    for (const m of s.matchAll(/&([^;\s&<]*);?/g)) {
      const body = m[1];
      if (!m[0].endsWith(";") || !(/^(amp|lt|gt|quot|apos)$/.test(body) || /^#\d+$/.test(body) || /^#x[0-9a-fA-F]+$/.test(body))) fail(`bad or undefined entity ${JSON.stringify(m[0])}`, at);
    }
    if (/&(?![^;\s&<]*;)/.test(s)) fail("a bare '&' (write &amp;)", at);
  };
  const NAME = /[A-Za-z_:][A-Za-z0-9_:.\-]*/y;
  const root = { name: "#document", attrs: {}, children: [] };
  const stack = [root];
  let pos = 0, doctype = false, rootCount = 0;
  while (pos < text.length) {
    const cur = stack[stack.length - 1];
    if (text[pos] !== "<") {
      const end = text.indexOf("<", pos);
      const chunk = text.slice(pos, end === -1 ? text.length : end);
      if (stack.length === 1 && /\S/.test(chunk)) fail("text outside the root element", pos);
      if (chunk.includes("]]>")) fail("']]>' in text", pos);
      checkEntities(chunk, pos);
      pos += chunk.length;
      continue;
    }
    if (text.startsWith("<!--", pos)) {
      const end = text.indexOf("-->", pos + 4);
      if (end === -1) fail("unterminated comment", pos);
      if (text.slice(pos + 4, end).includes("--")) fail("'--' inside a comment", pos);
      pos = end + 3;
    } else if (text.startsWith("<![CDATA[", pos)) {
      const end = text.indexOf("]]>", pos);
      if (end === -1 || stack.length === 1) fail("bad CDATA section", pos);
      pos = end + 3;
    } else if (text.startsWith("<?", pos)) {
      const end = text.indexOf("?>", pos);
      if (end === -1) fail("unterminated processing instruction", pos);
      if (pos !== 0 && !/^\s*$/.test(text.slice(0, pos))) fail("an XML declaration or processing instruction after the start of the document", pos);
      pos = end + 2;
    } else if (text.startsWith("<!DOCTYPE", pos)) {
      doctype = true;
      const end = text.indexOf(">", pos);
      if (end === -1) fail("unterminated DOCTYPE", pos);
      pos = end + 1;
    } else if (text.startsWith("</", pos)) {
      NAME.lastIndex = pos + 2;
      const m = NAME.exec(text);
      if (!m) fail("bad end tag", pos);
      let p = pos + 2 + m[0].length;
      while (/\s/.test(text[p] ?? "")) p++;
      if (text[p] !== ">") fail("bad end tag", pos);
      if (stack.length === 1 || cur.name !== m[0]) fail(`</${m[0]}> does not match ${stack.length === 1 ? "an open element" : `<${cur.name}>`}`, pos);
      stack.pop();
      pos = p + 1;
    } else {
      NAME.lastIndex = pos + 1;
      const m = NAME.exec(text);
      if (!m) fail("bad start tag", pos);
      const el = { name: m[0], attrs: {}, children: [] };
      let p = pos + 1 + m[0].length;
      for (;;) {
        const before = p;
        while (/\s/.test(text[p] ?? "")) p++;
        if (text[p] === ">" || text.startsWith("/>", p)) break;
        if (p === before) fail("missing space between attributes", p);
        NAME.lastIndex = p;
        const a = NAME.exec(text);
        if (!a) fail("bad attribute", p);
        p += a[0].length;
        while (/\s/.test(text[p] ?? "")) p++;
        if (text[p++] !== "=") fail(`attribute ${a[0]} has no value`, p);
        while (/\s/.test(text[p] ?? "")) p++;
        const q = text[p++];
        if (q !== '"' && q !== "'") fail(`attribute ${a[0]} is not quoted`, p);
        const end = text.indexOf(q, p);
        if (end === -1) fail("unterminated attribute value", p);
        const raw = text.slice(p, end);
        if (raw.includes("<")) fail(`'<' in the value of ${a[0]}`, p);
        checkEntities(raw, p);
        if (a[0] in el.attrs) fail(`attribute ${a[0]} twice on <${el.name}>`, p);
        // Decode references like a browser does before it reads the value: `&#117;rl(` is `url(`.
        el.attrs[a[0]] = raw.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g, (_, n, d, h) => (n ? ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[n] : String.fromCodePoint(d ? Number(d) : parseInt(h, 16))));
        p = end + 1;
      }
      cur.children.push(el);
      if (text[p] === "/") pos = p + 2;
      else { stack.push(el); pos = p + 1; }
      if (cur === root) rootCount++;
    }
  }
  if (stack.length !== 1) fail(`<${stack[stack.length - 1].name}> is never closed`, text.length);
  if (rootCount !== 1) fail(rootCount === 0 ? "no root element" : "more than one root element", 0);
  return { root: root.children[0], doctype };
}

/** The rules of SPEC.md "SVG output". Returns { fails, warns }. */
function checkSvg(svg) {
  const fails = [], warns = [];
  let doc;
  try { doc = parseXml(svg); } catch (e) { return { fails: [`not well-formed XML: ${e.message}`], warns }; }
  const { root } = doc;
  if (doc.doctype) warns.push("the document has a DOCTYPE; drop it");
  const local = (n) => n.replace(/^.*:/, "");
  if (local(root.name) !== "svg") fails.push(`the root element is <${root.name}>, not <svg>`);
  if (root.attrs.xmlns !== "http://www.w3.org/2000/svg") fails.push('the root element needs xmlns="http://www.w3.org/2000/svg"');
  if (!root.attrs.viewBox) warns.push("no viewBox: the host cannot scale the picture");
  if (!root.attrs.width || !root.attrs.height) warns.push("no width/height on the root element");
  const FORBIDDEN = new Set(["script", "foreignobject", "image", "a", "style", "animate", "animatemotion", "animatetransform", "set"]);
  const ids = new Set(), refs = [];
  const seen = new Set();
  const walk = (el) => {
    const tag = local(el.name).toLowerCase();
    if (FORBIDDEN.has(tag)) seen.add(`<${el.name}> element`);
    for (const [k, v] of Object.entries(el.attrs)) {
      const an = k.toLowerCase();
      if (an === "style") seen.add("style attribute (use presentation attributes: fill, stroke, stop-color, ...)");
      if (/^on/.test(an)) seen.add(`event handler attribute ${k}`);
      if (an === "href" || an === "xlink:href") { if (!v.trim().startsWith("#")) seen.add(`${k}="${v.slice(0, 40)}" (only #fragment references are allowed)`); else refs.push(v.trim().slice(1)); }
      if (an === "id") { if (ids.has(v)) seen.add(`duplicate id ${JSON.stringify(v)}`); ids.add(v); }
      if (an === "font-family") for (const f of v.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))) if (!GENERIC_FONTS.has(f)) seen.add(`font-family ${JSON.stringify(v)} (only sans-serif, serif, monospace, system-ui)`);
      for (const m of v.matchAll(/url\(\s*["']?\s*([^"')]*)/gi)) { if (!m[1].startsWith("#")) seen.add(`url(${m[1].slice(0, 40)}) (only url(#id) is allowed)`); else refs.push(m[1].slice(1)); }
      if (v.includes("\\")) seen.add(`a backslash in ${k}="${v.slice(0, 40)}" (CSS escapes such as u\\rl( hide a url(); the host removes the attribute)`);
      if (/(^|[^a-z-])(-webkit-)?image-set\(/i.test(v)) seen.add(`image-set( in ${k}="${v.slice(0, 40)}" (it loads an address; the host removes the attribute)`);
      // In the attributes that can name a resource, only url(#id) may: no other function that loads one.
      if ((RESOURCE_ATTRS.has(an) || an.startsWith("marker")) && /(^|[^a-z-])(image|cross-fade|element|paint|src)\(/i.test(v)) seen.add(`${k}="${v.slice(0, 40)}" (a resource reference must be exactly url(#id))`);
      if (/@import/i.test(v)) seen.add("@import");
      if (/javascript:/i.test(v)) seen.add("a javascript: URL");
      if (/(^|[\s,(])(NaN|-?Infinity)([\s,)]|$)/.test(v)) seen.add(`${k}="${v.slice(0, 40)}" (not a number)`);
    }
    for (const c of el.children) walk(c);
  };
  walk(root);
  for (const s of seen) fails.push(`contains ${s}`);
  for (const r of new Set(refs)) if (!ids.has(r)) fails.push(`reference to #${r}, which no element defines`);
  const w = parseFloat(root.attrs.width), h = parseFloat(root.attrs.height);
  const hasBackdrop = (el) => local(el.name) === "rect" && ((el.attrs.width === "100%" && el.attrs.height === "100%") || (Number.isFinite(w) && parseFloat(el.attrs.width) >= w - 1 && parseFloat(el.attrs.height) >= h - 1 && parseFloat(el.attrs.x ?? 0) <= 1)) && (el.attrs.fill ?? "black") !== "none";
  const findBackdrop = (el) => hasBackdrop(el) || el.children.some(findBackdrop);
  if (root.children.some(findBackdrop)) warns.push("a rectangle covers the whole picture: SPEC.md asks for no full-size background (the host draws the surface)");
  return { fails, warns };
}

// --------------------------------------------------------------------- HTML

const HTML_FORBIDDEN_ELEMENTS = new Set(["script", "link", "meta", "base", "form", "iframe", "frame", "frameset", "object", "embed", "portal", "applet"]);
const HTML_FORBIDDEN_ATTRS = new Set(["href", "xlink:href", "ping", "action", "formaction", "srcset", "background"]);
const HTML_DATA_ONLY_ATTRS = new Set(["src", "poster", "data", "lowsrc", "dynsrc"]);

/**
 * The rules of SPEC.md "HTML output", as far as a script can know them. The DCode viewer keeps only the
 * `<body>` of a page and the `<style>` elements of its `<head>`, removes the elements and attributes below
 * from the body, and shows the result in a sandboxed frame under a CSP, so a page that needs any of them
 * is shown broken. Returns { fails, warns }.
 */
function checkHtml(html) {
  const fails = [], warns = [];
  if (html.trim() === "") return { fails: ["the page is empty"], warns };
  const noComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const headMatch = /<head\b[\s\S]*?<\/head\s*>/i.exec(noComments);
  const head = headMatch ? headMatch[0] : "";
  const body = headMatch ? noComments.replace(head, "") : noComments;
  const decode = (v) => v.replace(/&(?:(amp|lt|gt|quot|apos|colon|tab|newline)|#(\d+)|#x([0-9a-fA-F]+));/g, (_, n, d, h) => (n ? ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t", newline: "\n" })[n] : String.fromCodePoint(d ? Number(d) : parseInt(h, 16))));
  const seen = new Set(), cssWarn = new Set();
  const css = (text, where) => {
    for (const m of text.matchAll(/url\(\s*["']?\s*([^"')]*)/gi)) if (!/^data:/i.test(m[1].trim())) cssWarn.add(`url(${m[1].slice(0, 40)}) in ${where}: nothing outside the page is loaded (CSP); only data: URLs work`);
    if (/@import/i.test(text)) cssWarn.add(`@import in ${where}: it is not loaded`);
    if (/image-set\(|expression\(|javascript:|-moz-binding|behavior\s*:/i.test(text)) cssWarn.add(`${where} uses image-set(, expression(, javascript: or a binding: none of it works`);
  };
  const tagRe = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (const m of body.matchAll(tagRe)) {
    if (m[1]) continue;
    const tag = m[2].toLowerCase();
    if (HTML_FORBIDDEN_ELEMENTS.has(tag)) seen.add(`<${tag}> element (the viewer removes it)`);
    for (const a of m[3].matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const an = a[1].toLowerCase(), av = decode(a[2] ?? a[3] ?? a[4] ?? "");
      if (/^on[a-z]/.test(an)) seen.add(`event handler attribute ${a[1]} (the viewer removes it; there is no script anyway)`);
      else if (HTML_FORBIDDEN_ATTRS.has(an)) seen.add(`${a[1]} attribute (the viewer removes it${an === "href" || an === "xlink:href" ? "; a link is shown as plain text" : ""})`);
      else if (HTML_DATA_ONLY_ATTRS.has(an) && !/^\s*data:/i.test(av)) seen.add(`${a[1]}="${av.slice(0, 40)}" (only data: URLs are kept)`);
      else if (an === "style") css(av, "a style attribute");
    }
  }
  for (const m of noComments.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) css(m[1], "a <style> element");
  for (const f of seen) fails.push(`contains ${f}`);
  for (const w of cssWarn) warns.push(w);
  // Elements in <head> other than <style> are dropped without harm; say so when it is something that looks like it matters.
  for (const m of head.matchAll(tagRe)) if (!m[1] && ["script", "link", "base", "iframe", "object", "embed"].includes(m[2].toLowerCase())) warns.push(`<${m[2].toLowerCase()}> in <head> is dropped by the viewer`);
  if (!/<\/?(body|html)\b/i.test(noComments) && !/<[a-z]/i.test(noComments)) warns.push("the page has no HTML elements");
  return { fails, warns };
}

// ----------------------------------------------------------------- the runner

/** Host-side stand-in for the WASI layer described in SPEC.md. */
function wasiStubs(getMemory, log) {
  let seed = 0x9e3779b9;
  let logged = 0;
  const view = () => new DataView(getMemory().buffer);
  const fns = {
    fd_write(fd, iovs, n, nw) {
      if (fd !== 1 && fd !== 2) return 8;
      let total = 0;
      for (let i = 0; i < n; i++) {
        const ptr = view().getUint32(iovs + i * 8, true), len = view().getUint32(iovs + i * 8 + 4, true);
        const keep = Math.max(0, Math.min(len, LOG_LIMIT - logged));
        if (keep) log.push(Buffer.from(getMemory().buffer, ptr, keep).toString("utf8"));
        logged += keep;
        total += len;
      }
      view().setUint32(nw, total, true);
      return 0;
    },
    random_get(ptr, len) {
      const b = new Uint8Array(getMemory().buffer, ptr, len);
      for (let i = 0; i < len; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; b[i] = seed >>> 24; }
      return 0;
    },
    clock_time_get(_id, _prec, out) { view().setBigUint64(out, 0n, true); return 0; },
    args_sizes_get(a, b) { view().setUint32(a, 0, true); view().setUint32(b, 0, true); return 0; },
    environ_sizes_get(a, b) { view().setUint32(a, 0, true); view().setUint32(b, 0, true); return 0; },
    args_get: () => 0,
    environ_get: () => 0,
    sched_yield: () => 0,
    proc_exit(code) { throw new Error(`proc_exit(${code}) is a plugin failure`); },
  };
  return new Proxy(fns, { get: (t, k) => t[k] ?? (() => (/^(fd|path)_/.test(String(k)) ? 8 : 52)) });
}

const enc = new TextEncoder();
const asBytes = (v) => (typeof v === "string" ? enc.encode(v) : Uint8Array.from(v));

/** Runs one case in a fresh instance. Everything it can verify about the call, it verifies here. */
function runCase(mod, c) {
  const problems = [];
  const log = [];
  let memory;
  const t0 = performance.now();
  const imports = WebAssembly.Module.imports(mod).length ? { wasi_snapshot_preview1: wasiStubs(() => memory, log) } : {};
  const inst = new WebAssembly.Instance(mod, imports);
  memory = inst.exports.memory;
  inst.exports._initialize?.();
  const { dcode_plugin_abi_version: version, dcode_alloc: alloc, dcode_free: free } = inst.exports;
  const isFile = c.kind === "file";
  const render = isFile ? inst.exports.dcode_render_file : inst.exports.dcode_render_block;
  const done = (extra) => ({ problems, log: log.join(""), ms: performance.now() - t0, memBytes: memory.buffer.byteLength, ...extra });

  if (c.kind === "alloc") {
    const abi = version();
    const p0 = alloc(0);
    if (!p0) problems.push("dcode_alloc(0) returned null: it must return a non-null pointer");
    free(p0, 0);
    free(0, 0);
    if (alloc(0xffffffff) !== 0) problems.push("dcode_alloc(0xffffffff) did not return null");
    if (alloc(MEM_MAX_PAGES * 65536) !== 0) problems.push("dcode_alloc(256 MiB) did not return null although the memory maximum is 256 MiB");
    const p = alloc(1000);
    if (!p) problems.push("dcode_alloc(1000) returned null");
    else { new Uint8Array(memory.buffer, p, 1000).fill(1); free(p, 1000); }
    return done({ abi });
  }

  // dcode_render_block(lang, src, opts, out) and dcode_render_file(name, data, opts, out) take the same shape of arguments.
  const inputs = isFile ? [asBytes(c.name ?? ""), asBytes(c.data ?? ""), asBytes(c.opts ?? "{}")] : [asBytes(c.lang ?? ""), asBytes(c.src ?? ""), asBytes(c.opts ?? "{}")];
  const ptrs = inputs.map((b) => {
    const p = alloc(b.length);
    if (!p) throw new Error("dcode_alloc returned null for an input");
    new Uint8Array(memory.buffer, p, b.length).set(b);
    return p;
  });
  const rec = alloc(9);
  const out = rec + 1; // an odd address: `out` has no alignment guarantee
  new Uint8Array(memory.buffer, out, 8).fill(0xa5);
  const rc = render(ptrs[0], inputs[0].length, ptrs[1], inputs[1].length, ptrs[2], inputs[2].length, c.nullOut ? 0 : out);
  let text = null;
  if (rc === 0 || rc === 1 || (isFile && rc === 2)) {
    const dv = new DataView(memory.buffer);
    const ptr = dv.getUint32(out, true), len = dv.getUint32(out + 4, true);
    if (ptr === 0) problems.push(`return ${rc} but out.ptr is null`);
    else if (ptr + len > memory.buffer.byteLength) problems.push("out points outside the plugin's memory");
    else {
      if (len > OUT_LIMIT) problems.push(`the output is ${len} bytes; the host refuses more than ${OUT_LIMIT}`);
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(memory.buffer, ptr, len)); } catch { problems.push("the output is not valid UTF-8"); }
      if (rc === 1 && len === 0) problems.push("return 1 with an empty message");
      try { free(ptr, len); } catch (e) { problems.push(`dcode_free(out.ptr, out.len) failed: ${e.message}`); }
    }
  } else if (rc === -1 || rc === -2) {
    const after = [...new Uint8Array(memory.buffer, out, 8)];
    if (!c.nullOut && after.some((b) => b !== 0xa5)) problems.push(`return ${rc} but the plugin wrote to out`);
  } else if (rc === 2) problems.push("dcode_render_block returned 2 (HTML): only dcode_render_file may return 2, and the host treats it as a plugin failure for a code block");
  else problems.push(`return value ${rc} is not one of ${isFile ? "0, 1, 2, -1, -2" : "0, 1, -1, -2"}`);
  inputs.forEach((b, i) => {
    if (!Buffer.from(memory.buffer, ptrs[i], b.length).equals(Buffer.from(b))) problems.push("the plugin changed an input buffer");
    free(ptrs[i], b.length);
  });
  free(rec, 9);
  return done({ rc, text });
}

if (!isMainThread && workerData?.job === "case") {
  try {
    const mod = new WebAssembly.Module(workerData.bytes);
    parentPort.postMessage({ ok: true, ...runCase(mod, workerData.case) });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e?.message ?? e).split("\n")[0] });
  }
  process.exit(0);
}

function runInWorker(bytes, c) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const w = new Worker(new URL(import.meta.url), { workerData: { job: "case", bytes, case: c } });
    const timer = setTimeout(() => { w.terminate(); resolve({ ok: false, timeout: true, ms: performance.now() - t0 }); }, CALL_TIMEOUT_MS);
    w.on("message", (m) => { clearTimeout(timer); resolve(m); });
    w.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message).split("\n")[0] }); });
  });
}

// ----------------------------------------------------------------------- main

function usage() {
  console.error(`usage: node check-plugin.mjs plugin.wasm [--sample file]... [--bad-sample file]...
       [--file-sample file]... [--bad-file-sample file]...
       [--sig plugin.wasm.minisig] [--dev] [--lang xx] [--out dir] [--fuzz N] [--show-log]

  --sample      a source file in the plugin's language that must render (repeatable; renderBlock)
  --bad-sample  a source file with a mistake that must return 1 and a message (repeatable; renderBlock)
  --file-sample      a file the plugin must preview, as SVG or HTML (repeatable; renderFile)
  --bad-file-sample  a file the plugin must answer with 1 and a message, such as a .db that is no database (repeatable; renderFile)
  --sig         the signature file (default: <plugin>.minisig next to the plugin)
  --dev         skip the signature check (a plugin for 'dcode plugin install --dev')
  --lang        the language to send (default: the first language in the manifest)
  --out         write every SVG or HTML page and an index.html preview, light and dark, into this directory
  --fuzz        how many odd inputs to try, for each extension point the plugin has (default 40)
  --show-log    print what the plugin wrote with fd_write`);
  process.exit(2);
}

if (isMainThread) {
  const argv = process.argv.slice(2);
  const opts = { samples: [], bad: [], fileSamples: [], badFileSamples: [], fuzz: 40 };
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sample") opts.samples.push(argv[++i]);
    else if (a === "--bad-sample") opts.bad.push(argv[++i]);
    else if (a === "--file-sample") opts.fileSamples.push(argv[++i]);
    else if (a === "--bad-file-sample") opts.badFileSamples.push(argv[++i]);
    else if (a === "--sig") opts.sig = argv[++i];
    else if (a === "--lang") opts.lang = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--fuzz") opts.fuzz = Number(argv[++i]);
    else if (a === "--dev") opts.dev = true;
    else if (a === "--show-log") opts.showLog = true;
    else if (a.startsWith("--") || file) usage();
    else file = a;
  }
  if (!file || [...opts.samples, ...opts.bad, ...opts.fileSamples, ...opts.badFileSamples].some((x) => !x) || !Number.isInteger(opts.fuzz)) usage();

  let fails = 0, warns = 0;
  const report = {
    pass: (area, msg) => console.log(`PASS  ${area}: ${msg}`),
    warn: (area, msg) => { warns++; console.log(`WARN  ${area}: ${msg}`); },
    fail: (area, msg) => { fails++; console.log(`FAIL  ${area}: ${msg}`); },
    check: (area, ok, msg) => (ok ? report.pass(area, msg) : report.fail(area, msg)),
  };
  const finish = () => {
    console.log(`\n${fails ? `${fails} FAILED` : "all checks passed"}${warns ? `, ${warns} warning${warns > 1 ? "s" : ""}` : ""}`);
    process.exit(fails ? 1 : 0);
  };

  const wasm = fs.readFileSync(file);
  console.log(`${path.basename(file)}: ${wasm.length} bytes\n`);
  report.check("file", wasm.length <= 32 * 1048576, "at most 32 MiB");

  // ---- module shape
  let mod;
  try { mod = parseModule(wasm); } catch (e) { report.fail("module", e.message); finish(); }
  let compiled;
  try { compiled = new WebAssembly.Module(wasm); report.pass("module", `compiles on Node ${process.version}`); } catch (e) { report.fail("module", `does not compile: ${e.message}`); finish(); }

  if (mod.gcForm !== undefined) report.fail("module", `the type section contains a GC type (form 0x${mod.gcForm.toString(16)}: struct, array, rec or sub): the host refuses WebAssembly GC modules, because GC objects live outside the linear memory and the 256 MiB limit would not apply to them`);
  else report.pass("module", "the type section has function types only (no GC types)");
  report.check("memory", mod.memories.length === 1 && !mod.imports.some((i) => i.kind === "memory"), `exactly one memory, defined by the module (found ${mod.memories.length} defined, ${mod.imports.filter((i) => i.kind === "memory").length} imported)`);
  const mem = mod.memories[0];
  if (mem) {
    report.check("memory", !mem.shared && !mem.memory64, "32-bit and not shared");
    report.check("memory", mem.min <= MEM_MAX_PAGES, `initial size ${mem.min} pages is within the 256 MiB limit (${MEM_MAX_PAGES} pages)`);
    report.pass("memory", mem.max === null ? "no declared maximum (the host sets 256 MiB)" : `declared maximum ${mem.max} pages (the host uses ${Math.min(mem.max, MEM_MAX_PAGES)})`);
  }
  // ---- manifest
  const sections = mod.custom.filter((s) => s.name === "dcode.plugin");
  report.check("manifest", sections.length === 1, `exactly one dcode.plugin section (found ${sections.length})`);
  const manifest = sections.length === 1 ? checkManifest(sections[0].data, report) : null;

  const exp = new Map(mod.exports.map((e) => [e.name, e]));
  // Which render functions are required follows from the manifest. Without a usable manifest, whatever is exported is checked.
  const hasBlock = manifest ? manifest.renderBlock !== undefined : exp.has("dcode_render_block");
  const hasFile = manifest ? manifest.renderFile !== undefined : exp.has("dcode_render_file");
  report.check("exports", exp.get("memory")?.kind === "memory", "exports memory");
  for (const [n, np, nr, needed] of [["dcode_plugin_abi_version", 0, 1, true], ["dcode_alloc", 1, 1, true], ["dcode_free", 2, 0, true], ["dcode_render_block", 7, 1, hasBlock], ["dcode_render_file", 7, 1, hasFile]]) {
    const e = exp.get(n);
    if (!e || e.kind !== "function") {
      if (needed) report.fail("exports", `${n} is missing${n === "dcode_render_block" ? " (the manifest declares renderBlock)" : n === "dcode_render_file" ? " (the manifest declares renderFile)" : ""}`);
      continue;
    }
    if (mod.gcForm !== undefined) continue; // the types were not read
    // The host reads dcode_render_file's parameter count (Function.length) whenever the export exists, so its type is checked even if the manifest does not declare renderFile.
    if (!needed && n !== "dcode_render_file") continue;
    const t = mod.types[mod.funcTypes[e.index]];
    const ok = t && t.params.length === np && t.params.every((x) => x === 0x7f) && t.results.length === nr && t.results.every((x) => x === 0x7f);
    report.check("exports", ok, `${n} has the type (${"i32, ".repeat(np).replace(/, $/, "")}) -> ${nr ? "i32" : "()"}`);
  }
  report.check("exports", !exp.has("_start"), "no _start: a plugin is a library (reactor), not a command");
  if (exp.has("_initialize")) report.pass("exports", "_initialize is exported; the host calls it first");
  if (mod.hasStart) report.warn("module", "has a start section; it runs at instantiation and counts toward the 5 s limit");

  const bad = mod.imports.filter((i) => i.module !== "wasi_snapshot_preview1" || i.kind !== "function" || !WASI_FUNCS.has(i.name));
  if (mod.imports.length === 0) report.pass("imports", "no imports");
  else report.check("imports", bad.length === 0, `${mod.imports.length} imports, all functions of wasi_snapshot_preview1`);
  for (const b of bad) {
    const why = b.module === "env" ? "nothing may come from env" : b.module !== "wasi_snapshot_preview1" ? `module ${b.module} is not allowed` : b.kind !== "function" ? `a ${b.kind} cannot be imported` : "not a function of preview 1";
    const hint = /wbindgen|wasm_bindgen/.test(b.module + b.name) ? " (a dependency pulled in wasm-bindgen: build for wasm32-wasip1 instead of wasm32-unknown-unknown)" : "";
    report.fail("imports", `${b.module}.${b.name}: ${why}${hint}`);
  }

  // ---- signature
  if (opts.dev) report.warn("signature", "skipped (--dev): install with 'dcode plugin install --dev'");
  else if (manifest && typeof manifest.publicKey === "string") {
    const sigPath = opts.sig ?? `${file}.minisig`;
    if (!fs.existsSync(sigPath)) report.fail("signature", `${sigPath} not found (sign with: minisign -S -m ${path.basename(file)}), or pass --dev`);
    else {
      try {
        const v = verifyMinisign(wasm, fs.readFileSync(sigPath, "utf8"), manifest.publicKey);
        report.pass("signature", `valid for the manifest key; ${v.algo === "ED" ? "pre-hashed" : "legacy"} signature`);
        console.log(`      key id      ${v.keyId}   (as minisign prints it; for display only: anyone can forge a key id)`);
        console.log(`      public key  ${manifest.publicKey}`);
        console.log(`      raw key     ${v.publicKey.toString("hex")}   (32 bytes: the plugin's identity; an update must be signed with exactly this key)`);
        const tampered = Buffer.from(wasm);
        tampered[tampered.length - 1] ^= 1;
        let rejected = false;
        try { verifyMinisign(tampered, fs.readFileSync(sigPath, "utf8"), manifest.publicKey); } catch { rejected = true; }
        report.check("signature", rejected, "a one-bit change to the file is rejected");
      } catch (e) { report.fail("signature", e.message); }
    }
  }

  if (fails) { console.log("\nThe module shape is wrong; the run checks are skipped."); finish(); }

  // ---- run it
  const lang = opts.lang ?? manifest?.renderBlock?.languages?.[0] ?? "x";
  const bytes = mem ? capMemory(wasm, mod) : wasm;
  const sample = (p) => fs.readFileSync(p);
  const opt = (theme) => JSON.stringify(theme === undefined ? {} : { theme });
  const runs = async (cases) => {
    const out = new Array(cases.length);
    let next = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(4, os.availableParallelism?.() ?? 2)) }, async () => {
      while (next < cases.length) { const i = next++; out[i] = await runInWorker(bytes, cases[i]); }
    });
    await Promise.all(lanes);
    return out;
  };
  const verdict = (area, name, r, wantRc) => {
    if (r.timeout) { report.fail(area, `${name}: no answer within ${CALL_TIMEOUT_MS} ms (the host would stop it)`); return false; }
    if (!r.ok) { report.fail(area, `${name}: the plugin trapped or failed: ${r.error}`); return false; }
    if (opts.showLog && r.log) console.log(`      log of ${name}: ${r.log.slice(0, 300).replace(/\n/g, "\n        ")}`);
    for (const p of r.problems) report.fail(area, `${name}: ${p}`);
    if (wantRc !== undefined && r.rc !== wantRc) { report.fail(area, `${name}: returned ${r.rc}, expected ${wantRc}${r.text ? ` (${r.text.slice(0, 120).replace(/\n/g, " | ")})` : ""}`); return false; }
    return r.problems.length === 0;
  };

  const [abi] = await runs([{ kind: "alloc" }]);
  if (verdict("abi", "dcode_alloc/dcode_free", abi)) report.pass("abi", "dcode_alloc(0) is non-null, free(ptr, 0) is harmless, oversized allocations return null");
  report.check("abi", abi.abi === 1 && manifest?.abi === 1, `dcode_plugin_abi_version() returns ${abi.abi}, the manifest says ${manifest?.abi}: both must be 1`);

  const names = opts.samples;
  const rendered = {};
  if (hasBlock) {
  if (names.length === 0) report.warn("samples", "no --sample given: the renderer itself is not exercised. Pass a source file in your language.");
  const svgCases = names.flatMap((n) => ["light", "dark"].map((theme) => ({ name: `${path.basename(n)} [${theme}]`, n, theme, c: { lang, src: sample(n), opts: opt(theme) } })));
  const svgRuns = await runs(svgCases.map((x) => x.c));
  svgRuns.forEach((r, i) => {
    const x = svgCases[i];
    if (!verdict("render", x.name, r, 0)) return;
    const s = checkSvg(r.text);
    for (const f of s.fails) report.fail("svg", `${x.name}: ${f}`);
    for (const w of s.warns) report.warn("svg", `${x.name}: ${w}`);
    if (!s.fails.length) report.pass("svg", `${x.name}: valid, nothing forbidden (${r.text.length} bytes, ${r.ms.toFixed(0)} ms, ${(r.memBytes / 1048576).toFixed(1)} MiB)`);
    rendered[`${x.n}\0${x.theme}`] = r.text;
  });
  for (const n of names) {
    const l = rendered[`${n}\0light`], d = rendered[`${n}\0dark`];
    if (l !== undefined && d !== undefined && l === d) report.warn("theme", `${path.basename(n)}: the light and dark pictures are identical; is theme handled?`);
  }
  // options: determinism, missing/unknown theme, unknown fields
  if (names[0] && rendered[`${names[0]}\0light`] !== undefined) {
    const src = sample(names[0]);
    const base = rendered[`${names[0]}\0light`];
    const variants = [["a second fresh instance", opt("light")], ["no theme", "{}"], ["an unknown theme", '{"theme":"sepia"}'], ["a theme of the wrong type", '{"theme":42}'], ["unknown fields", '{"theme":"light","future":[1,{"a":2}]}']];
    const vr = await runs(variants.map(([, o]) => ({ lang, src, opts: o })));
    vr.forEach((r, i) => {
      if (!verdict("options", variants[i][0], r, 0)) return;
      report.check("options", r.text === base, `${variants[i][0]}: same picture as theme "light"${i === 0 ? " (deterministic)" : ""}`);
    });
  }

  // argument validation
  const src0 = names[0] ? sample(names[0]) : "x";
  const argCases = [
    ["invalid UTF-8 source", { lang, src: [0xff, 0xfe], opts: "{}" }],
    ["invalid UTF-8 options", { lang, src: src0, opts: [0xff] }],
    ["options that are not JSON", { lang, src: src0, opts: "not json" }],
    ["options that are an array", { lang, src: src0, opts: "[]" }],
    ["options that are null", { lang, src: src0, opts: "null" }],
    ["empty options", { lang, src: src0, opts: "" }],
    ["a null out pointer", { lang, src: src0, opts: "{}", nullOut: true }],
  ];
  const ar = await runs(argCases.map((x) => x[1]));
  ar.forEach((r, i) => { if (verdict("args", argCases[i][0], r, -1)) report.pass("args", `${argCases[i][0]}: returns -1 and leaves out alone`); });

  // source errors
  for (const [n, r] of (await runs(opts.bad.map((n) => ({ lang, src: sample(n), opts: opt("light") })))).map((r, i) => [opts.bad[i], r])) {
    if (verdict("errors", path.basename(n), r, 1)) {
      report.pass("errors", `${path.basename(n)}: returns 1 with a message`);
      if (!/\d/.test(r.text)) report.warn("errors", `${path.basename(n)}: the message names no line or position: ${JSON.stringify(r.text.slice(0, 100))}`);
      else console.log(`      message: ${r.text.slice(0, 160).replace(/\n/g, " | ")}`);
    }
  }
  if (opts.bad.length === 0) report.warn("errors", "no --bad-sample given: the 'return 1 with a message' path is not exercised");

  // odd inputs: nothing may trap or hang
  const odd = [
    ["empty source", ""],
    ["blank source", " \r\n\t \n"],
    ["a 1 MiB source of one long line", "x".repeat(SRC_LIMIT)],
    ["a 1 MiB source of empty lines", "\n".repeat(SRC_LIMIT)],
    ["a 1 MiB source of short lines", "ab -> cd;\n".repeat(Math.floor(SRC_LIMIT / 10))],
    ["control characters and U+FFFE", "a\u0000\u0001\u0008\u000b￾￿b"],
    ["XML special characters", `<&"'> </text><script>alert(1)</script> ]]>`],
    ["emoji and right-to-left text", "😀 שלום مرحبا 中文 ‮"],
  ];
  const or = await runs(odd.map(([, src]) => ({ lang, src, opts: opt("dark") })));
  or.forEach((r, i) => {
    if (!verdict("odd", odd[i][0], r)) return;
    if (r.rc !== 0 && r.rc !== 1) { report.fail("odd", `${odd[i][0]}: returned ${r.rc}`); return; }
    if (r.rc === 0) { const s = checkSvg(r.text); for (const f of s.fails) report.fail("odd", `${odd[i][0]}: ${f}`); if (!s.fails.length) report.pass("odd", `${odd[i][0]}: SVG, ${r.ms.toFixed(0)} ms`); }
    else report.pass("odd", `${odd[i][0]}: returns 1 (${r.ms.toFixed(0)} ms)`);
  });
  if (opts.fuzz > 0) {
    let s = 12345;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const alphabet = "{}[]()<>;:,.=-+*/\\|\"'`~!@#$%^&_ \n\ta1b2é中😀";
    const pool = [...names.map((n) => sample(n).toString("utf8")), ...opts.bad.map((n) => sample(n).toString("utf8"))];
    const cases = Array.from({ length: opts.fuzz }, (_, i) => {
      let src = pool.length && i % 4 !== 3 ? pool[i % pool.length] : "";
      if (!src) for (let k = 0; k < 40 + Math.floor(rnd() * 200); k++) src += alphabet[Math.floor(rnd() * alphabet.length)];
      else for (let m = 0; m < 1 + Math.floor(rnd() * 4); m++) {
        const at = Math.floor(rnd() * src.length), op = rnd();
        src = op < 0.4 ? src.slice(0, at) + src.slice(at + 1 + Math.floor(rnd() * 6)) : src.slice(0, at) + alphabet[Math.floor(rnd() * alphabet.length)].repeat(1 + Math.floor(rnd() * 3)) + src.slice(at);
      }
      return { lang, src, opts: opt(rnd() < 0.5 ? "dark" : "light") };
    });
    const fr = await runs(cases);
    let bad = 0, ok0 = 0, ok1 = 0;
    fr.forEach((r, i) => {
      if (r.timeout || !r.ok || r.problems?.length || (r.rc !== 0 && r.rc !== 1)) { bad++; if (bad <= 3) report.fail("fuzz", `${r.timeout ? "timeout" : !r.ok ? r.error : r.problems?.[0] ?? `returned ${r.rc}`} for ${JSON.stringify(cases[i].src.slice(0, 100))}`); }
      else if (r.rc === 0) { ok0++; const s = checkSvg(r.text); if (s.fails.length) { bad++; if (bad <= 3) report.fail("fuzz", `${s.fails[0]} for ${JSON.stringify(cases[i].src.slice(0, 100))}`); } }
      else ok1++;
    });
    report.check("fuzz", bad === 0, `${opts.fuzz} odd inputs: ${ok0} rendered, ${ok1} returned 1, ${bad} misbehaved`);
  }

  } // hasBlock
  else if (names.length || opts.bad.length) report.warn("samples", "--sample and --bad-sample are for renderBlock; this plugin does not declare it, so they were not used");

  // ---- file previews (renderFile)
  const fileRendered = {};
  const fileNames = opts.fileSamples;
  if (hasFile) {
    const exts = manifest?.renderFile?.extensions;
    const ext0 = Array.isArray(exts) && typeof exts[0] === "string" ? exts[0] : ".bin";
    const fopt = (theme) => JSON.stringify({ theme });
    const base = (p) => path.basename(p);
    const okResult = (area, name, r) => {
      if (!verdict(area, name, r)) return null;
      if (r.rc !== 0 && r.rc !== 2) { report.fail(area, `${name}: returned ${r.rc}${r.text ? ` (${r.text.slice(0, 120).replace(/\n/g, " | ")})` : ""}, expected 0 (SVG) or 2 (HTML)`); return null; }
      return r.rc === 0 ? checkSvg(r.text) : checkHtml(r.text);
    };
    if (fileNames.length === 0) report.warn("file samples", "no --file-sample given: the previewer itself is not exercised. Pass a file your plugin must preview.");
    const fcases = fileNames.flatMap((n) => ["light", "dark"].map((theme) => ({ n, theme, name: `${base(n)} [${theme}]`, c: { kind: "file", name: base(n), data: fs.readFileSync(n), opts: fopt(theme) } })));
    const fres = await runs(fcases.map((x) => x.c));
    fres.forEach((r, i) => {
      const x = fcases[i];
      const chk = okResult("preview", x.name, r);
      if (!chk) return;
      for (const f of chk.fails) report.fail(r.rc === 0 ? "svg" : "html", `${x.name}: ${f}`);
      for (const w of chk.warns) report.warn(r.rc === 0 ? "svg" : "html", `${x.name}: ${w}`);
      if (!chk.fails.length) report.pass("preview", `${x.name}: ${r.rc === 0 ? "SVG" : "HTML"}, nothing the viewer would remove (${r.text.length} bytes, ${r.ms.toFixed(0)} ms, ${(r.memBytes / 1048576).toFixed(1)} MiB)`);
      fileRendered[`${x.n}\0${x.theme}`] = { rc: r.rc, text: r.text };
    });
    for (const n of fileNames) {
      const l = fileRendered[`${n}\0light`], d = fileRendered[`${n}\0dark`];
      if (l && d && l.text === d.text) report.warn("theme", `${base(n)}: the light and dark pages are identical; is theme handled?`);
    }
    // options: determinism, missing/unknown theme, unknown fields
    if (fileNames[0] && fileRendered[`${fileNames[0]}\0light`]) {
      const data = fs.readFileSync(fileNames[0]), nm = base(fileNames[0]), baseText = fileRendered[`${fileNames[0]}\0light`].text;
      const variants = [["a second fresh instance", fopt("light")], ["no theme", "{}"], ["an unknown theme", '{"theme":"sepia"}'], ["a theme of the wrong type", '{"theme":42}'], ["unknown fields", '{"theme":"light","future":[1,{"a":2}]}']];
      const vr = await runs(variants.map(([, o]) => ({ kind: "file", name: nm, data, opts: o })));
      vr.forEach((r, i) => {
        if (!verdict("options", variants[i][0], r)) return;
        report.check("options", r.text === baseText, `${variants[i][0]}: same page as theme "light"${i === 0 ? " (deterministic)" : ""}`);
      });
    }
    // argument validation: the data may be any bytes; the name and the options may not be garbage
    const data0 = fileNames[0] ? fs.readFileSync(fileNames[0]) : Buffer.from("x");
    const name0 = fileNames[0] ? base(fileNames[0]) : `x${ext0}`;
    const fargs = [
      ["a file name that is not UTF-8", { kind: "file", name: [0xff, 0xfe], data: data0, opts: "{}" }],
      ["invalid UTF-8 options", { kind: "file", name: name0, data: data0, opts: [0xff] }],
      ["options that are not JSON", { kind: "file", name: name0, data: data0, opts: "not json" }],
      ["options that are an array", { kind: "file", name: name0, data: data0, opts: "[]" }],
      ["options that are null", { kind: "file", name: name0, data: data0, opts: "null" }],
      ["empty options", { kind: "file", name: name0, data: data0, opts: "" }],
      ["a null out pointer", { kind: "file", name: name0, data: data0, opts: "{}", nullOut: true }],
    ];
    (await runs(fargs.map((x) => x[1]))).forEach((r, i) => { if (verdict("args", `file: ${fargs[i][0]}`, r, -1)) report.pass("args", `file: ${fargs[i][0]}: returns -1 and leaves out alone`); });

    // files that are not what the plugin reads
    for (const [n, r] of (await runs(opts.badFileSamples.map((n) => ({ kind: "file", name: base(n), data: fs.readFileSync(n), opts: fopt("light") })))).map((r, i) => [opts.badFileSamples[i], r])) {
      if (verdict("errors", `file ${base(n)}`, r, 1)) {
        report.pass("errors", `${base(n)}: returns 1 with a message`);
        console.log(`      message: ${r.text.slice(0, 160).replace(/\n/g, " | ")}`);
      }
    }
    if (opts.badFileSamples.length === 0) report.warn("errors", "no --bad-file-sample given: the 'return 1 with a message' path is not exercised. Pass a file with the right extension but the wrong content.");

    // odd files: nothing may trap or hang, and the largest file the host passes has to fit in 5 s and 256 MiB
    let seed = 987654321;
    const pseudo = (n) => { const b = Buffer.allocUnsafe(n); for (let i = 0; i < n; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; b[i] = seed >>> 24; } return b; };
    const markup = `<img src=x onerror=alert(1)>&"'<b>x`;
    const oddFiles = [
      ["an empty file", `x${ext0}`, Buffer.alloc(0)],
      ["a file of one byte", `x${ext0}`, Buffer.from([0])],
      ["a file of 1 MiB of zeros", `x${ext0}`, Buffer.alloc(1048576)],
      ["a file of 1 MiB of pseudo-random bytes", `x${ext0}`, pseudo(1048576)],
      ["a file of 32 MiB of zeros (the largest the host passes)", `x${ext0}`, Buffer.alloc(FILE_LIMIT)],
      ["a file of 32 MiB of pseudo-random bytes", `x${ext0}`, pseudo(FILE_LIMIT)],
      ["a file name with markup and quotes", markup + ext0, data0],
      ["a 255-byte file name", "n".repeat(255 - ext0.length) + ext0, data0],
      ["a file name in several scripts and an emoji", `日本語 עברית 😀${ext0}`, data0],
      ["a file name with no extension and an empty name", "", data0],
    ];
    const orr = await runs(oddFiles.map(([, nm, data]) => ({ kind: "file", name: nm, data, opts: fopt("dark") })));
    orr.forEach((r, i) => {
      const label = oddFiles[i][0];
      if (!verdict("odd", label, r)) return;
      if (r.rc !== 0 && r.rc !== 1 && r.rc !== 2) { report.fail("odd", `${label}: returned ${r.rc}`); return; }
      if (r.rc === 1) { report.pass("odd", `${label}: returns 1 (${r.ms.toFixed(0)} ms)`); return; }
      const chk = r.rc === 0 ? checkSvg(r.text) : checkHtml(r.text);
      for (const f of chk.fails) report.fail("odd", `${label}: ${f}`);
      if (i === 6 && /<img\b|<b>/i.test(r.text)) report.fail("odd", `${label}: the file name appears unescaped in the output`);
      if (!chk.fails.length) report.pass("odd", `${label}: ${r.rc === 0 ? "SVG" : "HTML"}, ${r.ms.toFixed(0)} ms, ${(r.memBytes / 1048576).toFixed(0)} MiB`);
    });

    if (opts.fuzz > 0) {
      let fs0 = 24680;
      const rnd = () => ((fs0 = (Math.imul(fs0, 1664525) + 1013904223) >>> 0) / 2 ** 32);
      const pool = fileNames.length ? fileNames.map((n) => fs.readFileSync(n)) : [Buffer.alloc(0)];
      const cases = Array.from({ length: opts.fuzz }, (_, i) => {
        let d = Buffer.from(pool[i % pool.length]);
        for (let k = 0; k < 1 + Math.floor(rnd() * 6); k++) {
          const op = rnd();
          if (!d.length) { d = pseudo(1 + Math.floor(rnd() * 512)); continue; }
          if (op < 0.5) d[Math.floor(rnd() * (rnd() < 0.5 ? Math.min(d.length, 4096) : d.length))] = Math.floor(rnd() * 256);       // flip a byte, half of them near the start
          else if (op < 0.65) d = d.subarray(0, Math.floor(rnd() * d.length));                                                         // truncate
          else if (op < 0.8) { const at = Math.floor(rnd() * d.length); d.fill(0, at, Math.min(d.length, at + 1 + Math.floor(rnd() * 8192))); } // zero a block
          else if (op < 0.9) { const at = Math.floor(rnd() * d.length), len = Math.min(d.length - at, 1 + Math.floor(rnd() * 4096)); pseudo(len).copy(d, at); } // garbage block
          else d = Buffer.concat([d, pseudo(1 + Math.floor(rnd() * 4096))]);                                                           // trailing garbage
        }
        return { kind: "file", name: `fuzz${ext0}`, data: d, opts: fopt(rnd() < 0.5 ? "dark" : "light") };
      });
      const fr2 = await runs(cases);
      let bad = 0, ok0 = 0, ok1 = 0, ok2 = 0;
      fr2.forEach((r, i) => {
        const why = r.timeout ? "timeout" : !r.ok ? r.error : r.problems?.length ? r.problems[0] : r.rc !== 0 && r.rc !== 1 && r.rc !== 2 ? `returned ${r.rc}` : null;
        if (why) { bad++; if (bad <= 3) report.fail("fuzz", `file: ${why} (a damaged copy of ${fileNames.length ? base(fileNames[i % fileNames.length]) : "an empty file"}, ${cases[i].data.length} bytes)`); return; }
        if (r.rc === 1) { ok1++; return; }
        const chk = r.rc === 0 ? checkSvg(r.text) : checkHtml(r.text);
        if (chk.fails.length) { bad++; if (bad <= 3) report.fail("fuzz", `file: ${chk.fails[0]}`); } else if (r.rc === 0) ok0++; else ok2++;
      });
      report.check("fuzz", bad === 0, `${opts.fuzz} damaged files: ${ok0} SVG, ${ok2} HTML, ${ok1} returned 1, ${bad} misbehaved`);
    }
  } else if (fileNames.length || opts.badFileSamples.length) report.warn("file samples", "--file-sample and --bad-file-sample are for renderFile; this plugin does not declare it, so they were not used");

  // preview
  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const cards = names.map((n) => {
      const base = path.basename(n);
      for (const t of ["light", "dark"]) if (rendered[`${n}\0${t}`]) fs.writeFileSync(path.join(opts.out, `${base}.${t}.svg`), rendered[`${n}\0${t}`]);
      return `<section><h2>${esc(base)}</h2><div class="pair"><div class="panel light">${rendered[`${n}\0light`] ?? "(no output)"}</div><div class="panel dark">${rendered[`${n}\0dark`] ?? "(no output)"}</div></div><details><summary>source</summary><pre>${esc(sample(n).toString("utf8"))}</pre></details></section>`;
    });
    // File previews: an SVG as an image, an HTML page in a frame with sandbox="" like the viewer's (no script, no navigation).
    const attr = (t) => esc(t).replace(/"/g, "&quot;");
    const fcards = fileNames.map((n) => {
      const b = path.basename(n);
      const panels = ["light", "dark"].map((t) => {
        const r = fileRendered[`${n}\0${t}`];
        if (!r) return `<div class="panel ${t}">(no output)</div>`;
        const f = `${b}.${t}.${r.rc === 0 ? "svg" : "html"}`;
        fs.writeFileSync(path.join(opts.out, f), r.text);
        return `<div class="panel ${t}">${r.rc === 0 ? `<img src="${attr(f)}" alt="">` : `<iframe sandbox="" referrerpolicy="no-referrer" src="${attr(f)}" title="${attr(f)}"></iframe>`}</div>`;
      });
      return `<section><h2>${esc(b)}</h2><div class="pair">${panels.join("")}</div></section>`;
    });
    fs.writeFileSync(path.join(opts.out, "index.html"), `<!doctype html><meta charset="utf-8"><title>${esc(path.basename(file))}: preview</title><style>body{font:15px system-ui;margin:24px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.panel{padding:10px;border:1px solid #888;overflow:auto}.panel.light{background:#fff}.panel.dark{background:#1e1e1e}svg,img{max-width:100%;height:auto}iframe{width:100%;height:480px;border:0;background:transparent}pre{overflow:auto}</style><h1>${esc(path.basename(file))}</h1>${[...cards, ...fcards].join("\n")}`);
    console.log(`\npreview written to ${path.join(opts.out, "index.html")}`);
  }
  finish();
}
