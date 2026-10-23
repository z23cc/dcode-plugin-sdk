//! A theme-aware SVG backend for layout-rs.
//!
//! layout-rs ships its own SVG writer, but it hard-codes black strokes, emits
//! no text colour, uses `context-stroke` markers and writes an empty
//! `<textPath>` for every unlabeled edge. This writer replaces it so the
//! output works on both light and dark backgrounds and stays plain SVG:
//! no scripts, no `foreignObject`, no external references, and a generic
//! font family only.

use layout::core::color::Color;
use layout::core::format::{ClipHandle, RenderBackend};
use layout::core::geometry::Point;
use layout::core::style::StyleAttr;
use std::fmt::Write;

#[derive(Clone, Copy, PartialEq)]
pub enum Theme {
    Light,
    Dark,
}

#[derive(Clone, Copy, PartialEq)]
struct Rgba(u8, u8, u8, u8);

impl Rgba {
    fn of(c: Color) -> Rgba {
        // `to_web_color` is always `#rrggbbaa`.
        let v = u32::from_str_radix(&c.to_web_color()[1..], 16).unwrap_or(0xff);
        Rgba((v >> 24) as u8, (v >> 16) as u8, (v >> 8) as u8, v as u8)
    }
    fn is_ink(self) -> bool {
        self == Rgba(0, 0, 0, 255)
    }
    fn is_surface(self) -> bool {
        self == Rgba(255, 255, 255, 255)
    }
    fn hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }
    fn is_dark(self) -> bool {
        let l = 0.299 * self.0 as f64 + 0.587 * self.1 as f64 + 0.114 * self.2 as f64;
        l < 140.0
    }
}

const INK_DARK: &str = "#d4d4d4";
const TEXT_ON_DARK_FILL: &str = "#f5f5f5";
const FONT: &str = "sans-serif";

/// Number formatting that can never produce `NaN`, `inf` or `-0`.
fn n(v: f64) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    let s = format!("{:.2}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-0" {
        "0".into()
    } else {
        s.into()
    }
}

/// XML-escape, dropping characters that are illegal in XML 1.0.
fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(' '),
            c if (c as u32) < 0x20 || c == '\u{fffe}' || c == '\u{ffff}' => {}
            c => out.push(c),
        }
    }
    out
}

pub struct SvgWriter {
    theme: Theme,
    /// Prefix for every `id`, so several diagrams can share one HTML document.
    prefix: String,
    body: String,
    clips: Vec<String>,
    marker_colors: Vec<String>,
    min: Point,
    max: Point,
}

impl SvgWriter {
    pub fn new(theme: Theme, prefix: String) -> SvgWriter {
        SvgWriter {
            theme,
            prefix,
            body: String::new(),
            clips: Vec::new(),
            marker_colors: Vec::new(),
            min: Point::new(f64::MAX, f64::MAX),
            max: Point::new(f64::MIN, f64::MIN),
        }
    }

    fn grow(&mut self, x: f64, y: f64) {
        if x.is_finite() && y.is_finite() {
            self.min = Point::new(self.min.x.min(x), self.min.y.min(y));
            self.max = Point::new(self.max.x.max(x), self.max.y.max(y));
        }
    }

    fn ink(&self, c: Color) -> String {
        let c = Rgba::of(c);
        if c.is_ink() && self.theme == Theme::Dark {
            INK_DARK.into()
        } else {
            c.hex()
        }
    }

    /// ` fill="…" fill-opacity="…"` for a node fill.
    fn fill(&self, c: Option<Color>) -> String {
        let Some(c) = c.map(Rgba::of) else {
            return " fill=\"none\"".into();
        };
        if c.3 == 0 {
            return " fill=\"none\"".into();
        }
        // The builder's default fill is white. On a dark page that would be a
        // glaring slab, so it becomes a faint wash instead.
        if c.is_surface() && self.theme == Theme::Dark {
            return " fill=\"#ffffff\" fill-opacity=\".1\"".into();
        }
        if c.3 == 255 {
            format!(" fill=\"{}\"", c.hex())
        } else {
            format!(" fill=\"{}\" fill-opacity=\"{}\"", c.hex(), n(c.3 as f64 / 255.0))
        }
    }

    fn text_color(&self, look: &StyleAttr) -> &'static str {
        let explicit = look.fill_color.map(Rgba::of).filter(|c| c.3 > 128 && !c.is_surface());
        match (explicit, self.theme) {
            (Some(c), _) if c.is_dark() => TEXT_ON_DARK_FILL,
            (Some(_), _) => "#000000",
            (None, Theme::Dark) => INK_DARK,
            (None, Theme::Light) => "#000000",
        }
    }

    fn marker(&mut self, color: String) -> usize {
        match self.marker_colors.iter().position(|c| *c == color) {
            Some(i) => i,
            None => {
                self.marker_colors.push(color);
                self.marker_colors.len() - 1
            }
        }
    }

    pub fn finish(self) -> String {
        let pad = 8.0;
        let (min, max) = if self.min.x > self.max.x {
            (Point::zero(), Point::new(1.0, 1.0))
        } else {
            (self.min, self.max)
        };
        let (x, y) = (min.x - pad, min.y - pad);
        let (w, h) = (max.x - min.x + 2.0 * pad, max.y - min.y + 2.0 * pad);
        let mut s = String::with_capacity(self.body.len() + 512);
        let _ = write!(
            s,
            "<svg xmlns=\"http://www.w3.org/2000/svg\" role=\"img\" width=\"{w}\" height=\"{h}\" viewBox=\"{x} {y} {w} {h}\">",
            w = n(w),
            h = n(h),
            x = n(x),
            y = n(y)
        );
        if !self.clips.is_empty() || !self.marker_colors.is_empty() {
            s.push_str("<defs>");
            for (i, c) in self.marker_colors.iter().enumerate() {
                let p = &self.prefix;
                let _ = write!(
                    s,
                    "<marker id=\"{p}e{i}\" markerWidth=\"10\" markerHeight=\"7\" refX=\"10\" refY=\"3.5\" orient=\"auto\"><polygon points=\"0 0,10 3.5,0 7\" fill=\"{c}\"/></marker>\
                     <marker id=\"{p}s{i}\" markerWidth=\"10\" markerHeight=\"7\" refX=\"0\" refY=\"3.5\" orient=\"auto\"><polygon points=\"10 0,10 7,0 3.5\" fill=\"{c}\"/></marker>"
                );
            }
            for c in &self.clips {
                s.push_str(c);
            }
            s.push_str("</defs>");
        }
        s.push_str(&self.body);
        s.push_str("</svg>");
        s
    }
}

impl RenderBackend for SvgWriter {
    fn draw_rect(
        &mut self,
        xy: Point,
        size: Point,
        look: &StyleAttr,
        _properties: Option<String>,
        clip: Option<ClipHandle>,
    ) {
        self.grow(xy.x, xy.y);
        self.grow(xy.x + size.x, xy.y + size.y);
        let clip = clip.map(|c| format!(" clip-path=\"url(#{}c{c})\"", self.prefix)).unwrap_or_default();
        let _ = write!(
            self.body,
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\"{} stroke=\"{}\" stroke-width=\"{}\"{}/>",
            n(xy.x),
            n(xy.y),
            n(size.x),
            n(size.y),
            look.rounded,
            self.fill(look.fill_color),
            self.ink(look.line_color),
            look.line_width,
            clip
        );
    }

    fn draw_line(&mut self, start: Point, stop: Point, look: &StyleAttr, _properties: Option<String>) {
        self.grow(start.x, start.y);
        self.grow(stop.x, stop.y);
        let _ = write!(
            self.body,
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"{}\"/>",
            n(start.x),
            n(start.y),
            n(stop.x),
            n(stop.y),
            self.ink(look.line_color),
            look.line_width
        );
    }

    fn draw_circle(&mut self, xy: Point, size: Point, look: &StyleAttr, _properties: Option<String>) {
        self.grow(xy.x - size.x / 2.0, xy.y - size.y / 2.0);
        self.grow(xy.x + size.x / 2.0, xy.y + size.y / 2.0);
        let _ = write!(
            self.body,
            "<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\"{} stroke=\"{}\" stroke-width=\"{}\"/>",
            n(xy.x),
            n(xy.y),
            n(size.x / 2.0),
            n(size.y / 2.0),
            self.fill(look.fill_color),
            self.ink(look.line_color),
            look.line_width
        );
    }

    fn draw_text(&mut self, xy: Point, text: &str, look: &StyleAttr) {
        let lines: Vec<&str> = text.lines().collect();
        let fs = look.font_size as f64;
        let color = self.text_color(look);
        // Centre the block of lines on `xy`, one em per line like layout-rs.
        let top = xy.y - (lines.len() as f64 - 1.0) * fs / 2.0;
        for (i, line) in lines.iter().enumerate() {
            let y = top + i as f64 * fs;
            let half = line.chars().count() as f64 * fs * 0.3;
            self.grow(xy.x - half, y - fs / 2.0);
            self.grow(xy.x + half, y + fs / 2.0);
            let _ = write!(
                self.body,
                "<text x=\"{}\" y=\"{}\" text-anchor=\"middle\" dominant-baseline=\"central\" font-family=\"{}\" font-size=\"{}\" fill=\"{}\">{}</text>",
                n(xy.x),
                n(y),
                FONT,
                look.font_size,
                color,
                esc(line)
            );
        }
    }

    fn draw_arrow(
        &mut self,
        path: &[(Point, Point)],
        dashed: bool,
        head: (bool, bool),
        look: &StyleAttr,
        _properties: Option<String>,
        _text: &str, // always empty: layout-rs draws edge labels as text nodes
    ) {
        if path.len() < 2 {
            return;
        }
        for (a, b) in path {
            self.grow(a.x, a.y);
            self.grow(b.x, b.y);
        }
        let p = |q: Point| format!("{} {}", n(q.x), n(q.y));
        let mut d = format!(
            "M{} C{},{},{}",
            p(path[0].0),
            p(path[0].1),
            p(path[1].0),
            p(path[1].1)
        );
        for q in &path[2..] {
            let _ = write!(d, " S{},{}", p(q.0), p(q.1));
        }
        let color = self.ink(look.line_color);
        let m = self.marker(color.clone());
        let _ = write!(
            self.body,
            "<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\"{}{}{}/>",
            d,
            color,
            look.line_width,
            if dashed { " stroke-dasharray=\"5,5\"" } else { "" },
            if head.0 { format!(" marker-start=\"url(#{}s{m})\"", self.prefix) } else { String::new() },
            if head.1 { format!(" marker-end=\"url(#{}e{m})\"", self.prefix) } else { String::new() },
        );
    }

    fn create_clip(&mut self, xy: Point, size: Point, rounded_px: usize) -> ClipHandle {
        let id = self.clips.len();
        self.clips.push(format!(
            "<clipPath id=\"{}c{id}\"><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{rounded_px}\"/></clipPath>",
            self.prefix,
            n(xy.x),
            n(xy.y),
            n(size.x),
            n(size.y)
        ));
        id
    }
}
