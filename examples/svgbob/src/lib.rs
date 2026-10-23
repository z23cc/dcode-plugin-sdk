//! Svgbob block renderer for DCode Plugin ABI 1.

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
pub static MANIFEST: [u8; include_bytes!("../plugin.json").len()] =
    *include_bytes!("../plugin.json");

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
    let ptr = dcode_alloc(text.len());
    if ptr.is_null() {
        return -2;
    }
    std::ptr::copy_nonoverlapping(text.as_ptr(), ptr, text.len());
    out.write_unaligned(DcodeBuf {
        ptr,
        len: text.len(),
    });
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
    lang_ptr: *const u8,
    lang_len: usize,
    src_ptr: *const u8,
    src_len: usize,
    opts_ptr: *const u8,
    opts_len: usize,
    out: *mut DcodeBuf,
) -> i32 {
    if out.is_null()
        || (src_ptr.is_null() && src_len != 0)
        || (opts_ptr.is_null() && opts_len != 0)
        || input(lang_ptr, lang_len) != b"bob"
    {
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

// shortcut: bound the upstream layout's work; raise only after adversarial timing checks.
const MAX_BYTES: usize = 8192;
const MAX_INK: usize = 2048;
const MAX_LINES: usize = 128;
const MAX_COLS: usize = 256;

fn render(src: &str, theme: Theme) -> Result<String, String> {
    if src.len() > MAX_BYTES {
        return Err("The bob block is too large (maximum 8192 UTF-8 bytes). Split it into smaller diagrams.".into());
    }
    if let Some(pos) = src.find("# Legend:") {
        let line = src[..pos].bytes().filter(|b| *b == b'\n').count() + 1;
        return Err(format!(
            "Line {line}: CSS legends (# Legend:) are not supported; use plain ASCII diagrams."
        ));
    }
    // Remove XML-invalid controls before they reach upstream's text serializer.
    let cleaned: String = src
        .chars()
        .map(|c| match c {
            '\t'
            | '\n'
            | '\r'
            | '\u{20}'..='\u{d7ff}'
            | '\u{e000}'..='\u{fffd}'
            | '\u{10000}'..='\u{10ffff}' => c,
            _ => ' ',
        })
        .collect();
    let mut normalized = String::new();
    let mut ink = 0;
    for (i, line) in cleaned.lines().enumerate() {
        if i >= MAX_LINES {
            return Err(format!(
                "Line {}: the bob block exceeds the 128-line limit.",
                i + 1
            ));
        }
        let line = line.replace('\t', "    ");
        if line.chars().count() > MAX_COLS {
            return Err(format!(
                "Line {}: the bob block exceeds 256 characters per line (tabs count as four).",
                i + 1
            ));
        }
        ink += line.chars().filter(|c| !c.is_whitespace()).count();
        if ink > MAX_INK {
            return Err(format!(
                "Line {}: the bob block exceeds 2048 non-whitespace characters; split the diagram.",
                i + 1
            ));
        }
        normalized.push_str(&line);
        normalized.push('\n');
    }
    if normalized.trim().is_empty() {
        return Err("The bob block is empty. Put an ASCII diagram between the fences.".into());
    }
    let ink = match theme {
        Theme::Light => "#18181b",
        Theme::Dark => "#f4f4f5",
    };
    let paper = match theme {
        Theme::Light => "#ffffff",
        Theme::Dark => "#18181b",
    };
    let settings = svgbob::Settings {
        include_styles: false,
        include_backdrop: false,
        font_family: "monospace".into(),
        ..Default::default()
    };
    let cb = svgbob::CellBuffer::from(normalized.as_str());
    let (mut node, w, h): (svgbob::Node<()>, f32, f32) = cb.get_node_with_size(&settings);
    // Fixed FNV-1a: equal source/theme has equal IDs, independent of process state.
    let hash = src
        .bytes()
        .chain(ink.bytes())
        .fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ b as u64).wrapping_mul(0x100000001b3)
        });
    let prefix = format!("bob-{hash:016x}-");
    paint(&mut node, ink, paper, &prefix, false);
    if let Some(el) = node.element_mut() {
        el.set_attributes([svgbob::sauron::attr("viewBox", format!("0 0 {w} {h}"))]);
    }
    let svg = node.render_to_string();
    if svg.len() > 8 * 1024 * 1024 {
        return Err(
            "The diagram produced more than 8 MiB of SVG; split it into smaller diagrams.".into(),
        );
    }
    Ok(svg)
}

/// Translate upstream's known CSS classes into SVG presentation attributes.
/// The source cannot inject attributes: its labels are escaped by svgbob 0.7.6.
fn paint(
    node: &mut svgbob::Node<()>,
    ink: &'static str,
    paper: &'static str,
    prefix: &str,
    in_marker: bool,
) {
    use svgbob::sauron::attr;
    if let Some(el) = node.element_mut() {
        let in_marker = in_marker || el.tag == "marker";
        let classes: Vec<String> = el
            .attributes()
            .iter()
            .filter(|a| a.name == "class")
            .flat_map(|a| &a.value)
            .filter_map(|v| v.as_str())
            .map(str::to_owned)
            .collect();
        let has = |class: &str| {
            classes
                .iter()
                .any(|v| v.split_whitespace().any(|c| c == class))
        };
        let id = el.first_value(&"id").map(ToString::to_string);
        el.remove_attribute(&"class");
        if let Some(id) = id {
            el.set_attributes([attr("id", format!("{prefix}{id}"))]);
        }
        if matches!(el.tag, "line" | "path" | "circle" | "rect" | "polygon") {
            let fill = if has("bg_filled") || has("nofill") {
                paper
            } else if has("filled") || in_marker {
                ink
            } else {
                "none"
            };
            el.set_attributes([
                attr("stroke", ink),
                attr("stroke-width", if has("bg_filled") { "1" } else { "2" }),
                attr("stroke-linecap", "round"),
                attr("stroke-linejoin", "miter"),
                attr("fill", fill),
            ]);
            if has("broken") {
                el.set_attributes([attr("stroke-dasharray", "8")]);
            }
        }
        if el.tag == "text" {
            el.set_attributes([
                attr("fill", ink),
                attr("stroke", "none"),
                attr("font-family", "monospace"),
                attr("font-size", "14"),
                attr("xml:space", "preserve"),
            ]);
        }
        for marker in [
            "arrow",
            "diamond",
            "circle",
            "open_circle",
            "big_open_circle",
        ] {
            for (side, attribute) in [("start", "marker-start"), ("end", "marker-end")] {
                if has(&format!("{side}_marked_{marker}")) {
                    el.set_attributes([attr(attribute, format!("url(#{prefix}{marker})"))]);
                }
            }
        }
        for child in el.children_mut() {
            paint(child, ink, paper, prefix, in_marker);
        }
    }
}
