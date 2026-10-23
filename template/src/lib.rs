//! DCode plugin template (Plugin ABI 1).
//!
//! The example plugin claims the code-block language `textbox` and draws the
//! block's text inside a box. The file has three parts:
//!
//! 1. the manifest, embedded in the module;
//! 2. ABI glue that every plugin needs: leave it alone;
//! 3. `dcode_render_block` and `render`: replace the example with your own code.
//!
//! The rules are in SPEC.md at the root of the repository ("Plugin ABI 1").

use serde_json::Value;
use std::alloc::{alloc, dealloc, Layout};
use std::ptr::NonNull;

// ---- 1. Manifest ----------------------------------------------------------

// The host reads the manifest from a custom section named `dcode.plugin`.
// `#[used]` stops the compiler from dropping the otherwise unreferenced static;
// the array type is spelled out so its length follows the file's length.
// `strip = true` in Cargo.toml does not remove this section.
#[used]
#[link_section = "dcode.plugin"]
pub static MANIFEST: [u8; include_bytes!("../plugin.json").len()] = *include_bytes!("../plugin.json");

// ---- 2. ABI glue ----------------------------------------------------------

/// `dcode_buf` from SPEC.md: a pointer and a length, 8 bytes on wasm32.
/// Memory behind `ptr` is owned by the plugin until the host calls `dcode_free`.
#[repr(C)]
pub struct DcodeBuf {
    ptr: *mut u8,
    len: usize,
}

/// The ABI major version. The manifest's `abi` field must say the same.
#[no_mangle]
pub extern "C" fn dcode_plugin_abi_version() -> u32 {
    1
}

/// The host calls this to put the inputs into the plugin's memory.
/// A zero-length request still returns a non-null pointer; null means "out of memory".
#[no_mangle]
pub extern "C" fn dcode_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        // Allocating zero bytes is undefined behaviour in Rust; any non-null
        // pointer is a valid answer, and `dcode_free` ignores zero-length frees.
        return NonNull::<u8>::dangling().as_ptr();
    }
    match Layout::from_size_align(len, 1) {
        // The global allocator returns null when `memory.grow` fails (the host
        // caps memory at 256 MiB), which is exactly what the host expects.
        Ok(layout) => unsafe { alloc(layout) },
        Err(_) => std::ptr::null_mut(),
    }
}

/// Frees memory from `dcode_alloc`, and the buffer a successful or failed
/// `dcode_render_block` left in `out`. `len` is the length it was created with.
///
/// # Safety
/// `ptr`/`len` must come from `dcode_alloc` or from a `DcodeBuf` written by this module.
#[no_mangle]
pub unsafe extern "C" fn dcode_free(ptr: *mut u8, len: usize) {
    if len != 0 && !ptr.is_null() {
        // Same layout as in `dcode_alloc` and `write_out`: `len` bytes, align 1.
        dealloc(ptr, Layout::from_size_align_unchecked(len, 1));
    }
}

/// View an input buffer. A zero length gives an empty slice whatever `ptr` is,
/// because `slice::from_raw_parts` requires a non-null pointer.
unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

/// Copy `text` into a new buffer and describe it in `*out`.
/// Returns 0, or -2 when the copy cannot be allocated (and then leaves `out` alone).
unsafe fn write_out(out: *mut DcodeBuf, text: &str) -> i32 {
    // Reserve fallibly: a huge diagram should end in -2, not in a trap.
    let mut v: Vec<u8> = Vec::new();
    if v.try_reserve_exact(text.len()).is_err() {
        return -2;
    }
    v.extend_from_slice(text.as_bytes());
    // A boxed slice's allocation is exactly `len` bytes, so `dcode_free(ptr, len)`
    // releases it with the layout it was allocated with. A `Vec` with spare
    // capacity would not.
    let boxed = v.into_boxed_slice();
    let len = boxed.len();
    let ptr = Box::into_raw(boxed) as *mut u8;
    // The host gives no alignment guarantee for `out`, so write unaligned.
    out.write_unaligned(DcodeBuf { ptr, len });
    0
}

// ---- 3. Your plugin -------------------------------------------------------

/// The one extension point of Plugin ABI 1: turn a code block into SVG.
///
/// Returns:
/// *  0: `out` holds a complete SVG document.
/// *  1: the user's source is wrong; `out` holds a message for them (plain text).
/// * -1: an argument is invalid; `out` is not written.
/// * -2: out of memory; `out` is not written.
///
/// A trap (a panic is one, with `panic = "abort"`) is reported by the host as a
/// plugin failure. Do not panic on user input: return 1.
///
/// # Safety
/// Every pointer is valid for its length and `out` is writable. The host owns
/// the three inputs and frees them itself: do not free them.
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
    // `lang` says which of the manifest's languages this block was written in.
    // This plugin claims one language, so it does not look at it.
    if out.is_null() {
        return -1;
    }
    let Ok(src) = std::str::from_utf8(input(src_ptr, src_len)) else {
        return -1;
    };
    let Some(theme) = parse_options(input(opts_ptr, opts_len)) else {
        return -1;
    };
    match render(src, theme) {
        Ok(svg) => write_out(out, &svg),
        // Error text goes out the same way; only the return code differs.
        Err(message) => match write_out(out, &message) {
            0 => 1,
            code => code,
        },
    }
}

#[derive(Clone, Copy)]
enum Theme {
    Light,
    Dark,
}

/// Options are a JSON object such as `{"theme":"dark"}`. Anything that is not a
/// JSON object is an invalid argument (None, so -1). Unknown fields are ignored,
/// because later versions of the host may add fields. A missing or unknown
/// `theme` means light.
fn parse_options(opts: &[u8]) -> Option<Theme> {
    let value: Value = serde_json::from_slice(opts).ok()?;
    let object = value.as_object()?;
    Some(match object.get("theme").and_then(Value::as_str) {
        Some("dark") => Theme::Dark,
        _ => Theme::Light,
    })
}

// The output must stay under 8 MiB and the source can be 1 MiB, so an
// unbounded drawing could be refused by the host. Cap what the example draws.
const MAX_LINES: usize = 200;
const MAX_COLS: usize = 120;

// There are no font metrics inside the plugin, so text is laid out on a grid.
// 9 px per column is a little wider than 14 px monospace needs: text never overflows.
const FONT_SIZE: usize = 14;
const COL_W: usize = 9;
const ROW_H: usize = 20;
const PAD: usize = 16;

/// Draw `src` in a box. `Err` is a message for the person who wrote the block.
///
/// The result is a pure function of `src` and `theme`: no clock, no randomness.
/// The host caches results, and a plugin that varies its output only defeats that.
fn render(src: &str, theme: Theme) -> Result<String, String> {
    // The error example. For a real language, say where the problem is:
    // "line 3, column 9: expected ';'".
    if src.trim().is_empty() {
        return Err("The textbox block is empty. Put some text between the fences.".to_string());
    }

    // `lines()` accepts \n and \r\n. Blank lines stay: they take up a row.
    let mut rows: Vec<(String, usize)> = src.lines().take(MAX_LINES).map(text_row).collect();
    let hidden = src.lines().count().saturating_sub(MAX_LINES);
    if hidden > 0 {
        rows.push(text_row(&format!("... {hidden} more lines")));
    }

    let cols = rows.iter().map(|(_, cols)| *cols).max().unwrap_or(0);
    let width = 2 * PAD + cols * COL_W;
    let height = 2 * PAD + rows.len() * ROW_H;

    // Light text on dark boxes and the reverse, so the diagram reads on both
    // backgrounds. The SVG itself has no background: the host draws the page.
    let (fill, stroke, ink) = match theme {
        Theme::Light => ("#f4f4f5", "#52525b", "#18181b"),
        Theme::Dark => ("#27272a", "#a1a1aa", "#f4f4f5"),
    };

    // Plain presentation attributes, no <style> and no ids: the host may inline
    // several plugins' SVGs into one page, where a stylesheet rule or an `id`
    // would leak between them. If you need ids, prefix them with something
    // derived from the source (see "SVG output" in SPEC.md).
    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\">\n\
         <rect x=\"1\" y=\"1\" width=\"{}\" height=\"{}\" rx=\"6\" fill=\"{fill}\" stroke=\"{stroke}\" stroke-width=\"1.5\"/>\n",
        width - 2,
        height - 2,
    );
    for (i, (text, _)) in rows.iter().enumerate() {
        if text.is_empty() {
            continue;
        }
        // SVG does not wrap text, so every line is its own <text>.
        // `xml:space="preserve"` keeps leading spaces. The font is a generic
        // family: the plugin cannot ship fonts and must not name one.
        let y = PAD + (i + 1) * ROW_H - 5;
        svg.push_str(&format!(
            "<text x=\"{PAD}\" y=\"{y}\" font-family=\"monospace\" font-size=\"{FONT_SIZE}\" fill=\"{ink}\" xml:space=\"preserve\">{text}</text>\n"
        ));
    }
    svg.push_str("</svg>\n");
    Ok(svg)
}

/// One line of source -> (XML-safe text, width in grid columns).
fn text_row(line: &str) -> (String, usize) {
    let mut text = String::new();
    let mut cols = 0;
    for c in line.chars().take(MAX_COLS) {
        match c {
            '&' => text.push_str("&amp;"),
            '<' => text.push_str("&lt;"),
            '>' => text.push_str("&gt;"),
            '"' => text.push_str("&quot;"),
            '\'' => text.push_str("&apos;"),
            // SVG collapses tabs; four spaces keep the indentation visible.
            '\t' => {
                text.push_str("    ");
                cols += 3; // plus the one counted below
            }
            // The characters XML 1.0 allows (https://www.w3.org/TR/xml/#charsets).
            // Anything else, such as control characters or U+FFFE, makes the
            // whole SVG fail to parse, so it is dropped.
            '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}' => text.push(c),
            _ => continue,
        }
        // East Asian and emoji text is about twice as wide as ASCII.
        cols += if c.is_ascii() { 1 } else { 2 };
    }
    (text, cols)
}
