use std::cell::RefCell;
use std::ffi::{c_char, CString};
use std::sync::atomic::{AtomicU64, Ordering};

mod command;
mod frame;
mod semantic;
mod slots;

pub use command::Command;
pub use frame::{convert_bgra_into, convert_bgra_rect_into, DirtyRect};
pub use semantic::{build_assist_editable_click_js, build_cursor_event_json, build_edit_key_js, build_hit_test_js, build_insert_text_js, c_string_from_ptr, cstring_lossy, strip_hit_test_console_prefix};
pub use slots::ShmSlots;

// ---------------------------------------------------------------------------
// C ABI constants (must match kitty_cef_core.h)
// ---------------------------------------------------------------------------

pub const KITTY_CORE_CMD_STOP: u32 = 0;
pub const KITTY_CORE_CMD_NAVIGATE: u32 = 1;
pub const KITTY_CORE_CMD_RESIZE: u32 = 2;
pub const KITTY_CORE_CMD_CLICK: u32 = 3;
pub const KITTY_CORE_CMD_MOUSE_DOWN: u32 = 4;
pub const KITTY_CORE_CMD_MOUSE_UP: u32 = 5;
pub const KITTY_CORE_CMD_MOUSE_MOVE: u32 = 6;
pub const KITTY_CORE_CMD_WHEEL: u32 = 7;
pub const KITTY_CORE_CMD_KEY: u32 = 8;
pub const KITTY_CORE_CMD_TEXT: u32 = 9;

pub const KITTY_CORE_BUTTON_LEFT: u32 = 0;
pub const KITTY_CORE_BUTTON_MIDDLE: u32 = 1;
pub const KITTY_CORE_BUTTON_RIGHT: u32 = 2;
pub const KITTY_CORE_BUTTON_NONE: u32 = 3;
pub const KITTY_CORE_BUTTON_BACK: u32 = 4;
pub const KITTY_CORE_BUTTON_FORWARD: u32 = 5;

pub const KITTY_CORE_MOD_SHIFT: u32 = 0x01;
pub const KITTY_CORE_MOD_CTRL: u32 = 0x02;
pub const KITTY_CORE_MOD_ALT: u32 = 0x04;
pub const KITTY_CORE_MOD_META: u32 = 0x08;

// ---------------------------------------------------------------------------
// C ABI structs
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Debug)]
pub struct KittyCoreFrameMeta {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    pub byte_len: usize,
    pub path_ptr: *const c_char,
    pub dirty_valid: u32,
    pub dirty_x: u32,
    pub dirty_y: u32,
    pub dirty_width: u32,
    pub dirty_height: u32,
}

#[repr(C)]
#[derive(Debug, Default)]
pub struct KittyCoreCommandMeta {
    pub kind: u32,
    pub url_ptr: *const c_char,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub button: u32,
    pub click_count: u32,
    pub delta_x: i32,
    pub delta_y: i32,
    pub modifiers: u32,
    pub key_ptr: *const c_char,
    pub text_ptr: *const c_char,
}

// ---------------------------------------------------------------------------
// Opaque core handle
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct KittyCore {
    debug: bool,
    rgb: bool,
    slots: ShmSlots,
    last_error: String,
    converted_frame: Vec<u8>,
    last_bgra_frame: Vec<u8>,
    sent_full_frame: bool,
    last_width: u32,
    last_height: u32,
}

static CORE_SEQ: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static LAST_PATH: RefCell<CString> = RefCell::new(CString::new("").unwrap());
    static LAST_ERROR: RefCell<CString> = RefCell::new(CString::new("").unwrap());
    static LAST_JSON: RefCell<CString> = RefCell::new(CString::new("").unwrap());
    static LAST_JS: RefCell<CString> = RefCell::new(CString::new("").unwrap());
    static CMD_URL: RefCell<CString> = RefCell::new(CString::new("").unwrap());
    static CMD_KEY: RefCell<CString> = RefCell::new(CString::new("").unwrap());
    static CMD_TEXT: RefCell<CString> = RefCell::new(CString::new("").unwrap());
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn kitty_core_new(debug: bool) -> *mut KittyCore {
    let slots = ShmSlots::new();
    core_log(
        LogLevel::Info,
        "core",
        &format!("created transport={}", slots.mode()),
    );

    let core = Box::new(KittyCore {
        debug,
        rgb: false,
        slots,
        last_error: String::new(),
        converted_frame: Vec::new(),
        last_bgra_frame: Vec::new(),
        sent_full_frame: false,
        last_width: 0,
        last_height: 0,
    });
    Box::into_raw(core)
}

#[no_mangle]
pub extern "C" fn kitty_core_free(ptr: *mut KittyCore) {
    if !ptr.is_null() {
        unsafe { drop(Box::from_raw(ptr)) };
    }
}

#[no_mangle]
pub extern "C" fn kitty_core_last_error(core: *const KittyCore) -> *const c_char {
    if core.is_null() {
        return b"(null)\0".as_ptr() as *const c_char;
    }
    let core = unsafe { &*core };
    LAST_ERROR.with(|cell| {
        *cell.borrow_mut() = cstring_lossy(&core.last_error);
        cell.borrow().as_ptr()
    })
}

// ---------------------------------------------------------------------------
// Frame pipeline
// ---------------------------------------------------------------------------

/// Make the next accepted paint a self-contained full frame. Used to seed the
/// renderer's hidden staging frame after the initial visible frame is ACKed.
#[no_mangle]
pub extern "C" fn kitty_core_force_full_frame(ptr: *mut KittyCore) {
    if ptr.is_null() {
        return;
    }
    let core = unsafe { &mut *ptr };
    core.sent_full_frame = false;
}

#[no_mangle]
pub extern "C" fn kitty_core_write_bgra_frame(
    ptr: *mut KittyCore,
    bgra_ptr: *const u8,
    bgra_len: usize,
    width: u32,
    height: u32,
    rgb: bool,
    dirty_valid: u32,
    dirty_x: u32,
    dirty_y: u32,
    dirty_width: u32,
    dirty_height: u32,
    out: *mut KittyCoreFrameMeta,
) -> i32 {
    if ptr.is_null() || bgra_ptr.is_null() || out.is_null() {
        return -1;
    }
    let core = unsafe { &mut *ptr };

    let expected_len = width as usize * height as usize * 4;
    if bgra_len < expected_len {
        let msg = format!(
            "short_bgra_buffer expected={} actual={}",
            expected_len, bgra_len
        );
        core_log(LogLevel::Warn, "frame", &msg);
        core.last_error = msg;
        return -2;
    }

    let bgra = unsafe { std::slice::from_raw_parts(bgra_ptr, expected_len) };
    let source_changed = !core.sent_full_frame
        || core.last_width != width
        || core.last_height != height
        || core.rgb != rgb
        || core.last_bgra_frame.len() != expected_len;
    core.rgb = rgb;

    // Do not rely solely on CEF's dirty_rects. In OSR, especially with video or
    // compositor-driven pages, CEF can mark the entire viewport dirty even when
    // only a smaller visual region actually changed. We keep the previous BGRA
    // frame and compute the changed bounding rectangle client-side, then send
    // only that rectangle as a Kitty animation frame (regardless of transport).
    let mut dirty_source = "full";
    let mut skip_unchanged = false;
    let dirty = if !source_changed {
        let cef_dirty = clamp_dirty_rect(
            dirty_valid,
            dirty_x,
            dirty_y,
            dirty_width,
            dirty_height,
            width,
            height,
        )
        .unwrap_or_else(|| full_rect(width, height));

        if pixel_diff_enabled() {
            // CEF dirty rects can omit the old location of an element after a
            // layout shift. Diff the complete delivered frame so both the old
            // and new regions are included in the emitted bounding delta.
            match diff_bgra_rect(&core.last_bgra_frame, bgra, width, full_rect(width, height)) {
                Some(rect) if should_use_dirty_rect(rect, width, height) => {
                    dirty_source = "diff";
                    Some(rect)
                }
                Some(_) => None,
                None => {
                    skip_unchanged = true;
                    None
                }
            }
        } else if should_use_dirty_rect(cef_dirty, width, height) {
            dirty_source = "cef";
            Some(cef_dirty)
        } else {
            None
        }
    } else {
        None
    };

    if skip_unchanged {
        if frame_debug_enabled(core.debug) {
            core_log(
                LogLevel::Info,
                "frame",
                &format!("skip unchanged {}x{} search={}x{}@{},{}", width, height, dirty_width, dirty_height, dirty_x, dirty_y),
            );
        }
        core.last_error.clear();
        return 1;
    }

    match dirty {
        Some(rect) => convert_bgra_rect_into(bgra, width, rect, core.rgb, &mut core.converted_frame),
        None => convert_bgra_into(bgra, width, height, core.rgb, &mut core.converted_frame),
    }

    let seq = CORE_SEQ.fetch_add(1, Ordering::Relaxed);
    let byte_len = core.converted_frame.len();

    // POSIX shm is the only transport. Each frame is written to a single-use
    // shm object whose name Kitty reads via t=s, so pixels bypass the PTY.
    let written = match core.slots.write(&core.converted_frame) {
        Some(name) => name,
        None => {
            let msg = "shm_write_failed".to_string();
            core_log(LogLevel::Warn, "frame", &msg);
            core.last_error = msg;
            return -3;
        }
    };

    core.last_bgra_frame.clear();
    core.last_bgra_frame.extend_from_slice(bgra);

    if core.debug && seq <= 2 {
        core_log(
            LogLevel::Info,
            "frame",
            &format!("seq={} {}x{} bytes={}", seq, width, height, byte_len),
        );
    }
    if frame_debug_enabled(core.debug) {
        let dirty_desc = dirty
            .map(|rect| format!("{} {}x{}@{},{}", dirty_source, rect.width, rect.height, rect.x, rect.y))
            .unwrap_or_else(|| "full".to_string());
        core_log(
            LogLevel::Info,
            "frame",
            &format!("seq={} {}x{} bytes={} dirty={}", seq, width, height, byte_len, dirty_desc),
        );
    }

    let out_ref = unsafe { &mut *out };
    out_ref.seq = seq;
    out_ref.width = width;
    out_ref.height = height;
    out_ref.byte_len = byte_len;
    if let Some(rect) = dirty {
        out_ref.dirty_valid = 1;
        out_ref.dirty_x = rect.x;
        out_ref.dirty_y = rect.y;
        out_ref.dirty_width = rect.width;
        out_ref.dirty_height = rect.height;
    } else {
        out_ref.dirty_valid = 0;
        out_ref.dirty_x = 0;
        out_ref.dirty_y = 0;
        out_ref.dirty_width = 0;
        out_ref.dirty_height = 0;
        core.sent_full_frame = true;
        core.last_width = width;
        core.last_height = height;
    }

    LAST_PATH.with(|lp| {
        *lp.borrow_mut() = cstring_lossy(&written);
        out_ref.path_ptr = lp.borrow().as_ptr();
    });

    core.last_error.clear();
    0
}

fn clamp_dirty_rect(
    dirty_valid: u32,
    dirty_x: u32,
    dirty_y: u32,
    dirty_width: u32,
    dirty_height: u32,
    frame_width: u32,
    frame_height: u32,
) -> Option<DirtyRect> {
    if dirty_valid == 0
        || dirty_width == 0
        || dirty_height == 0
        || frame_width == 0
        || frame_height == 0
    {
        return None;
    }
    if dirty_x >= frame_width || dirty_y >= frame_height {
        return None;
    }

    let width = dirty_width.min(frame_width - dirty_x);
    let height = dirty_height.min(frame_height - dirty_y);
    if width == 0 || height == 0 {
        return None;
    }

    Some(DirtyRect {
        x: dirty_x,
        y: dirty_y,
        width,
        height,
    })
}

fn full_rect(frame_width: u32, frame_height: u32) -> DirtyRect {
    DirtyRect {
        x: 0,
        y: 0,
        width: frame_width,
        height: frame_height,
    }
}

fn should_use_dirty_rect(rect: DirtyRect, frame_width: u32, frame_height: u32) -> bool {
    if rect.width == 0 || rect.height == 0 || frame_width == 0 || frame_height == 0 {
        return false;
    }
    let dirty_area = rect.width as u64 * rect.height as u64;
    let full_area = frame_width as u64 * frame_height as u64;
    let threshold_percent = dirty_threshold_percent();
    dirty_area * 100 <= full_area * threshold_percent as u64
}

fn diff_bgra_rect(prev: &[u8], curr: &[u8], frame_width: u32, search: DirtyRect) -> Option<DirtyRect> {
    if prev.len() != curr.len() || frame_width == 0 || search.width == 0 || search.height == 0 {
        return Some(search);
    }

    let frame_width = frame_width as usize;
    let sx = search.x as usize;
    let sy = search.y as usize;
    let sw = search.width as usize;
    let sh = search.height as usize;
    let mut left = sx + sw;
    let mut right = sx;
    let mut top = sy + sh;
    let mut bottom = sy;

    for y in sy..(sy + sh) {
        let row_start = (y * frame_width + sx) * 4;
        let row_end = row_start + sw * 4;
        if row_end > prev.len() || row_end > curr.len() {
            return Some(search);
        }
        if prev[row_start..row_end] == curr[row_start..row_end] {
            continue;
        }

        if y < top {
            top = y;
        }
        bottom = y + 1;

        // The bounding rectangle only needs the first and last changed pixel
        // in each changed row. Scanning every pixel between those boundaries
        // doubles the hottest work for video-sized dirty regions.
        let prev_row = &prev[row_start..row_end];
        let curr_row = &curr[row_start..row_end];
        let row_left = first_different_pixel(prev_row, curr_row);
        let row_right = last_different_pixel(prev_row, curr_row);
        left = left.min(sx + row_left);
        right = right.max(sx + row_right + 1);
    }

    if right <= left || bottom <= top {
        return None;
    }

    Some(DirtyRect {
        x: left as u32,
        y: top as u32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

#[inline]
fn first_different_pixel(prev: &[u8], curr: &[u8]) -> usize {
    debug_assert_eq!(prev.len(), curr.len());
    debug_assert_eq!(prev.len() % 4, 0);
    for (index, (a, b)) in prev.chunks_exact(4).zip(curr.chunks_exact(4)).enumerate() {
        if a != b {
            return index;
        }
    }
    prev.len() / 4
}

#[inline]
fn last_different_pixel(prev: &[u8], curr: &[u8]) -> usize {
    debug_assert_eq!(prev.len(), curr.len());
    debug_assert_eq!(prev.len() % 4, 0);
    let pixels = prev.len() / 4;
    for reverse_index in 0..pixels {
        let index = pixels - reverse_index - 1;
        let offset = index * 4;
        if prev[offset..offset + 4] != curr[offset..offset + 4] {
            return index;
        }
    }
    0
}

fn pixel_diff_enabled() -> bool {
    env_bool("KITTY_WEBVIEW_PIXEL_DIFF", true)
}

fn frame_debug_enabled(_debug: bool) -> bool {
    env_bool("KITTY_WEBVIEW_FRAME_DEBUG", false)
}

fn dirty_threshold_percent() -> u32 {
    let value = std::env::var("KITTY_WEBVIEW_DIRTY_THRESHOLD_PERCENT").ok();
    parse_dirty_threshold_percent(value.as_deref())
}

fn parse_dirty_threshold_percent(value: Option<&str>) -> u32 {
    value
        .and_then(|v| v.parse::<u32>().ok())
        .map(|v| v.min(100))
        // Partial animation-frame updates can briefly corrupt rectangular
        // regions on Kitty. Full frames are the correctness-first default.
        .unwrap_or(0)
}

fn env_bool(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(v) => {
            let v = v.to_ascii_lowercase();
            !(v == "0" || v == "false" || v == "no" || v == "off")
        }
        Err(_) => default,
    }
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn kitty_core_parse_command_json(
    core: *mut KittyCore,
    json_ptr: *const u8,
    json_len: usize,
    out: *mut KittyCoreCommandMeta,
) -> i32 {
    if core.is_null() || json_ptr.is_null() || out.is_null() {
        return -1;
    }
    let core = unsafe { &mut *core };
    let out_ref = unsafe { &mut *out };

    // Zero out the struct.
    *out_ref = KittyCoreCommandMeta::default();

    let json_bytes = unsafe { std::slice::from_raw_parts(json_ptr, json_len) };
    let json_str = match std::str::from_utf8(json_bytes) {
        Ok(s) => s,
        Err(e) => {
            let msg = format!("invalid_utf8 {}", e);
            core.last_error = msg;
            return -2;
        }
    };

    let cmd = match Command::parse(json_str) {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("parse_error {}", e);
            core.last_error = msg;
            return -3;
        }
    };

    match cmd {
        Command::Stop => {
            out_ref.kind = KITTY_CORE_CMD_STOP;
        }
        Command::Navigate { url } => {
            out_ref.kind = KITTY_CORE_CMD_NAVIGATE;
            CMD_URL.with(|cell| {
                *cell.borrow_mut() = cstring_lossy(&url);
                out_ref.url_ptr = cell.borrow().as_ptr();
            });
        }
        Command::Resize { width, height } => {
            out_ref.kind = KITTY_CORE_CMD_RESIZE;
            out_ref.width = width;
            out_ref.height = height;
        }
        Command::Click {
            x,
            y,
            button,
            click_count,
            modifiers,
        } => {
            out_ref.kind = KITTY_CORE_CMD_CLICK;
            fill_mouse(out_ref, x, y, button, click_count, 0, 0, &modifiers);
        }
        Command::MouseDown {
            x,
            y,
            button,
            click_count,
            modifiers,
        } => {
            out_ref.kind = KITTY_CORE_CMD_MOUSE_DOWN;
            fill_mouse(out_ref, x, y, button, click_count, 0, 0, &modifiers);
        }
        Command::MouseUp {
            x,
            y,
            button,
            click_count,
            modifiers,
        } => {
            out_ref.kind = KITTY_CORE_CMD_MOUSE_UP;
            fill_mouse(out_ref, x, y, button, click_count, 0, 0, &modifiers);
        }
        Command::MouseMove {
            x,
            y,
            button,
            modifiers,
        } => {
            out_ref.kind = KITTY_CORE_CMD_MOUSE_MOVE;
            fill_mouse(
                out_ref,
                x,
                y,
                button.unwrap_or(command::MouseButton::None),
                0,
                0,
                0,
                &modifiers,
            );
        }
        Command::Wheel {
            x,
            y,
            delta_x,
            delta_y,
            modifiers,
        } => {
            out_ref.kind = KITTY_CORE_CMD_WHEEL;
            fill_mouse(out_ref, x, y, command::MouseButton::None, 0, delta_x, delta_y, &modifiers);
        }
        Command::Key { key, modifiers } => {
            out_ref.kind = KITTY_CORE_CMD_KEY;
            out_ref.modifiers = mods_to_flags(&modifiers);
            CMD_KEY.with(|cell| {
                *cell.borrow_mut() = cstring_lossy(&key);
                out_ref.key_ptr = cell.borrow().as_ptr();
            });
        }
        Command::Text { text } | Command::InsertText { text } => {
            out_ref.kind = KITTY_CORE_CMD_TEXT;
            CMD_TEXT.with(|cell| {
                *cell.borrow_mut() = cstring_lossy(&text);
                out_ref.text_ptr = cell.borrow().as_ptr();
            });
        }
    }

    if core.debug && should_log_input_kind(out_ref.kind) {
        core_log(
            LogLevel::Debug,
            "input",
            &format!("kind={} x={} y={} btn={} mods={} cc={}",
                out_ref.kind, out_ref.x, out_ref.y, out_ref.button,
                out_ref.modifiers, out_ref.click_count),
        );
    }

    core.last_error.clear();
    0
}

fn env_enabled(name: &str) -> bool {
    std::env::var(name)
        .map(|v| {
            v == "1" ||
            v == "true" ||
            v == "TRUE" ||
            v == "yes" ||
            v == "YES"
        })
        .unwrap_or(false)
}

fn should_log_input_kind(kind: u32) -> bool {
    // Mouse move and wheel are high-frequency. They are useful while debugging
    // parser issues, but in normal --debug they flood the log and obscure perf
    // signals. Keep click/key/text logs visible.
    if kind == KITTY_CORE_CMD_MOUSE_MOVE || kind == KITTY_CORE_CMD_WHEEL || kind == 8 {
        return env_enabled("KITTY_WEB_UI_INPUT_DEBUG");
    }
    true
}

fn fill_mouse(
    out: &mut KittyCoreCommandMeta,
    x: i32,
    y: i32,
    button: command::MouseButton,
    click_count: u8,
    delta_x: i32,
    delta_y: i32,
    modifiers: &command::Modifiers,
) {
    out.x = x;
    out.y = y;
    out.button = match button {
        command::MouseButton::Left => KITTY_CORE_BUTTON_LEFT,
        command::MouseButton::Middle => KITTY_CORE_BUTTON_MIDDLE,
        command::MouseButton::Right => KITTY_CORE_BUTTON_RIGHT,
        command::MouseButton::None => KITTY_CORE_BUTTON_NONE,
        command::MouseButton::Back => KITTY_CORE_BUTTON_BACK,
        command::MouseButton::Forward => KITTY_CORE_BUTTON_FORWARD,
    };
    out.click_count = click_count as u32;
    out.delta_x = delta_x;
    out.delta_y = delta_y;
    out.modifiers = mods_to_flags(modifiers);
}

fn mods_to_flags(mods: &command::Modifiers) -> u32 {
    let mut f: u32 = 0;
    if mods.shift { f |= KITTY_CORE_MOD_SHIFT; }
    if mods.ctrl { f |= KITTY_CORE_MOD_CTRL; }
    if mods.alt { f |= KITTY_CORE_MOD_ALT; }
    if mods.meta { f |= KITTY_CORE_MOD_META; }
    f
}


// ---------------------------------------------------------------------------
// Semantic / DOM policy helpers
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn kitty_core_build_cursor_event_json(
    core: *mut KittyCore,
    cursor_ptr: *const c_char,
) -> *const c_char {
    let debug = unsafe { core.as_ref().map(|c| c.debug).unwrap_or(false) };
    let cursor = c_string_from_ptr(cursor_ptr);
    let json = build_cursor_event_json(&cursor);
    semantic::log_semantic_debug(debug, "semantic", &format!("cursor={}", cursor));
    LAST_JSON.with(|cell| {
        *cell.borrow_mut() = cstring_lossy(&json);
        cell.borrow().as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn kitty_core_build_insert_text_js(
    core: *mut KittyCore,
    text_ptr: *const c_char,
) -> *const c_char {
    let debug = unsafe { core.as_ref().map(|c| c.debug).unwrap_or(false) };
    let text = c_string_from_ptr(text_ptr);
    let js = build_insert_text_js(&text);
    semantic::log_semantic_debug(debug, "semantic", &format!("insertText bytes={}", text.len()));
    LAST_JS.with(|cell| {
        *cell.borrow_mut() = cstring_lossy(&js);
        cell.borrow().as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn kitty_core_build_edit_key_js(
    core: *mut KittyCore,
    key_ptr: *const c_char,
) -> *const c_char {
    let debug = unsafe { core.as_ref().map(|c| c.debug).unwrap_or(false) };
    let key = c_string_from_ptr(key_ptr);
    let js = build_edit_key_js(&key);
    semantic::log_semantic_debug(debug, "semantic", &format!("editKey key={}", key));
    LAST_JS.with(|cell| {
        *cell.borrow_mut() = cstring_lossy(&js);
        cell.borrow().as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn kitty_core_build_assist_click_js(
    core: *mut KittyCore,
    x: i32,
    y: i32,
) -> *const c_char {
    let debug = unsafe { core.as_ref().map(|c| c.debug).unwrap_or(false) };
    let js = build_assist_editable_click_js(x, y);
    semantic::log_semantic_debug(debug, "semantic", &format!("assistClick x={} y={}", x, y));
    LAST_JS.with(|cell| {
        *cell.borrow_mut() = cstring_lossy(&js);
        cell.borrow().as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn kitty_core_build_hit_test_js(
    core: *mut KittyCore,
    x: i32,
    y: i32,
) -> *const c_char {
    let debug = unsafe { core.as_ref().map(|c| c.debug).unwrap_or(false) };
    let js = build_hit_test_js(x, y);
    semantic::log_semantic_debug(debug, "semantic", &format!("hitTest x={} y={}", x, y));
    LAST_JS.with(|cell| {
        *cell.borrow_mut() = cstring_lossy(&js);
        cell.borrow().as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn kitty_core_strip_hit_test_console_prefix(
    core: *mut KittyCore,
    message_ptr: *const c_char,
) -> *const c_char {
    let debug = unsafe { core.as_ref().map(|c| c.debug).unwrap_or(false) };
    let message = c_string_from_ptr(message_ptr);
    let Some(json) = strip_hit_test_console_prefix(&message) else {
        return std::ptr::null();
    };
    semantic::log_semantic_debug(debug, "semantic", "hitTest console event");
    LAST_JSON.with(|cell| {
        *cell.borrow_mut() = cstring_lossy(json);
        cell.borrow().as_ptr()
    })
}

// ---------------------------------------------------------------------------
// Logging (JSON Lines to stderr)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

pub fn core_log(level: LogLevel, target: &str, msg: &str) {
    let lvl = match level {
        LogLevel::Error => "error",
        LogLevel::Warn => "warn",
        LogLevel::Info => "info",
        LogLevel::Debug => "debug",
    };
    eprintln!(
        r#"{{"level":"{}","target":"{}","msg":"{}"}}"#,
        lvl,
        target,
        json_escape(msg),
    );
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod frame_diff_tests {
    use super::*;

    #[test]
    fn diff_bgra_rect_finds_exact_bounds_without_scanning_interior_semantics() {
        let width = 6;
        let height = 3;
        let previous = vec![0u8; width * height * 4];
        let mut current = previous.clone();
        for (x, y) in [(4usize, 0usize), (1, 1), (3, 2)] {
            current[(y * width + x) * 4] = 255;
        }

        let rect = diff_bgra_rect(
            &previous,
            &current,
            width as u32,
            DirtyRect { x: 0, y: 0, width: width as u32, height: height as u32 },
        );

        assert_eq!(rect, Some(DirtyRect { x: 1, y: 0, width: 4, height: 3 }));
    }

    #[test]
    fn full_frame_diff_includes_old_and_new_locations_after_layout_shift() {
        let width = 6usize;
        let height = 1usize;
        let mut previous = vec![0u8; width * height * 4];
        let mut current = previous.clone();
        previous[1 * 4] = 255;
        current[4 * 4] = 255;

        let rect = diff_bgra_rect(
            &previous,
            &current,
            width as u32,
            full_rect(width as u32, height as u32),
        );

        assert_eq!(rect, Some(DirtyRect { x: 1, y: 0, width: 4, height: 1 }));
    }

    #[test]
    fn zero_dirty_threshold_really_disables_partial_frames() {
        assert_eq!(parse_dirty_threshold_percent(None), 0);
        assert_eq!(parse_dirty_threshold_percent(Some("0")), 0);
        assert_eq!(parse_dirty_threshold_percent(Some("95")), 95);
        assert_eq!(parse_dirty_threshold_percent(Some("999")), 100);
    }

    #[test]
    fn diff_bgra_rect_returns_none_for_identical_frames() {
        let frame = vec![7u8; 4 * 4 * 4];
        assert_eq!(
            diff_bgra_rect(&frame, &frame, 4, DirtyRect { x: 0, y: 0, width: 4, height: 4 }),
            None,
        );
    }
}
