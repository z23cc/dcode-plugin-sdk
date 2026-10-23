//! Graphviz DOT renderer for DCode (Plugin ABI 1), built on the pure-Rust
//! `layout-rs` crate. See `../../SPEC.md` for the ABI.

mod svg;

use layout::gv::{DotParser, GraphBuilder};
use std::alloc::{alloc, dealloc, Layout};
use std::ptr::NonNull;
use svg::{SvgWriter, Theme};

// ---- manifest -------------------------------------------------------------

#[used]
#[link_section = "dcode.plugin"]
pub static MANIFEST: [u8; include_bytes!("../plugin.json").len()] = *include_bytes!("../plugin.json");

// ---- ABI glue -------------------------------------------------------------

#[repr(C)]
pub struct DcodeBuf {
    ptr: *mut u8,
    len: usize,
}

#[no_mangle]
pub extern "C" fn dcode_plugin_abi_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn dcode_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return NonNull::<u8>::dangling().as_ptr();
    }
    match Layout::from_size_align(len, 1) {
        Ok(layout) => unsafe { alloc(layout) },
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `ptr`/`len` must come from `dcode_alloc` or a `DcodeBuf` written by this module.
#[no_mangle]
pub unsafe extern "C" fn dcode_free(ptr: *mut u8, len: usize) {
    if len != 0 && !ptr.is_null() {
        dealloc(ptr, Layout::from_size_align_unchecked(len, 1));
    }
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

/// Hand `text` to the host. Returns 0, or -2 when the copy cannot be allocated.
unsafe fn write_out(out: *mut DcodeBuf, text: String) -> i32 {
    let mut v: Vec<u8> = Vec::new();
    if v.try_reserve_exact(text.len()).is_err() {
        return -2;
    }
    v.extend_from_slice(text.as_bytes());
    let b = v.into_boxed_slice(); // capacity == len, so dcode_free(ptr, len) matches
    let len = b.len();
    // `out` has no alignment guarantee.
    out.write_unaligned(DcodeBuf {
        ptr: Box::into_raw(b) as *mut u8,
        len,
    });
    0
}

/// # Safety
/// Pointers must be valid for their lengths; `out` must be writable.
#[no_mangle]
pub unsafe extern "C" fn dcode_render_block(
    _lang_ptr: *const u8,
    _lang_len: usize,
    src_ptr: *const u8,
    src_len: usize,
    opts_ptr: *const u8,
    opts_len: usize,
    out: *mut DcodeBuf,
) -> i32 {
    if out.is_null() {
        return -1;
    }
    let Ok(src) = std::str::from_utf8(bytes(src_ptr, src_len)) else {
        return -1;
    };
    let Some(theme) = parse_theme(bytes(opts_ptr, opts_len)) else {
        return -1;
    };
    match render(src, theme) {
        Ok(svg) => write_out(out, svg),
        Err(message) => match write_out(out, message) {
            0 => 1,
            code => code,
        },
    }
}

/// `{"theme":"dark"}` -> Dark. A missing or unknown theme is light; anything
/// that is not a JSON object (including empty input) is invalid. Unknown
/// fields are ignored.
fn parse_theme(opts: &[u8]) -> Option<Theme> {
    let v: serde_json::Value = serde_json::from_slice(opts).ok()?;
    let obj = v.as_object()?;
    Some(match obj.get("theme").and_then(|t| t.as_str()) {
        Some("dark") => Theme::Dark,
        _ => Theme::Light,
    })
}

// ---- rendering ------------------------------------------------------------

fn render(src: &str, theme: Theme) -> Result<String, String> {
    let mut parser = DotParser::new(src);
    let graph = match parser.process() {
        Ok(g) => g,
        Err(msg) => return Err(describe_error(src, &parser, &msg)),
    };
    let mut builder = GraphBuilder::new();
    builder.visit_graph(&graph);
    let mut visual = builder.get();
    let mut svg = SvgWriter::new(theme, id_prefix(src, theme));
    if visual.num_nodes() > 0 {
        visual.do_it(false, false, false, &mut svg);
    }
    Ok(svg.finish())
}

/// Same source and theme give the same ids; different diagrams get different
/// ones, so several SVGs can be inlined into one page without clashing.
fn id_prefix(src: &str, theme: Theme) -> String {
    let mut h: u32 = 0x811c9dc5; // FNV-1a
    for b in src.bytes().chain([theme as u8]) {
        h = (h ^ b as u32).wrapping_mul(0x01000193);
    }
    format!("d{h:08x}-")
}

/// Turn layout-rs's bare message into "line N, column M: message" plus the
/// offending line and a caret.
fn describe_error(src: &str, parser: &DotParser, msg: &str) -> String {
    // ponytail: layout-rs keeps the lexer position private and only offers a
    // `print_error` that writes to stdout. The derived Debug output carries
    // `pos`, so read it from there. Costs O(source) on the error path only;
    // replace with a real accessor if layout-rs grows one.
    let debug = format!("{parser:?}");
    let pos = debug
        .find("], pos: ")
        .and_then(|i| {
            let rest = &debug[i + "], pos: ".len()..];
            rest[..rest.find(',')?].parse::<usize>().ok()
        });
    let Some(pos) = pos else {
        return msg.to_string();
    };
    // `pos` is one past the offending char.
    let idx = pos.saturating_sub(1).min(src.chars().count());
    let before: String = src.chars().take(idx).collect();
    let line_no = before.matches('\n').count() + 1;
    let col = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
    let line_text: String = src.lines().nth(line_no - 1).unwrap_or("").chars().take(120).collect();
    let gutter = format!("{line_no} | ");
    format!(
        "line {line_no}, column {col}: {msg}\n{gutter}{line_text}\n{}^",
        " ".repeat(gutter.len() + col.saturating_sub(1).min(120))
    )
}
