/// Semantic / DOM policy helpers.
///
/// Builds JSON strings and JS snippets that C++ injects into the browser.
/// Keeps all string-template logic in Rust for testability.

use std::ffi::{c_char, CStr, CString};

use crate::json_escape;

/// Build a cursor-change metadata JSON for TCP transmission.
pub fn build_cursor_event_json(cursor: &str) -> String {
    format!(
        r#"{{"type":"cursor","cursor":"{}"}}"#,
        json_escape(cursor)
    )
}

/// Build JavaScript that inserts text into the focused editable element
/// via DOM manipulation (InputEvent + caret management).
pub fn build_insert_text_js(text: &str) -> String {
    format!(
        r#"(() => {{
  const text = {};
  function active(root) {{
    let el = root.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }}
  function fire(el, type, data) {{
    try {{
      return el.dispatchEvent(new InputEvent(type, {{
        data,
        inputType: 'insertText',
        bubbles: true,
        cancelable: type === 'beforeinput',
        composed: true
      }}));
    }} catch (_) {{
      return el.dispatchEvent(new Event(type, {{ bubbles: true, cancelable: type === 'beforeinput' }}));
    }}
  }}
  const el = active(document);
  if (!el) return false;
  const tag = String(el.tagName || '').toLowerCase();
  const inputType = String(el.type || '').toLowerCase();
  const editableInput = tag === 'textarea' || (tag === 'input' && !['button','checkbox','radio','range','color','file','submit','reset','image','hidden'].includes(inputType));
  if (editableInput) {{
    if (!fire(el, 'beforeinput', text)) return true;
    const before = String(el.value ?? '');
    let start = before.length;
    let end = before.length;
    try {{
      if (typeof el.selectionStart === 'number') start = el.selectionStart;
      if (typeof el.selectionEnd === 'number') end = el.selectionEnd;
    }} catch (_) {{}}
    const next = before.slice(0, start) + text + before.slice(end);
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, next); else el.value = next;
    const caret = start + text.length;
    try {{ el.setSelectionRange(caret, caret); }} catch (_) {{}}
    fire(el, 'input', text);
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
    return true;
  }}
  if (el.isContentEditable) {{
    if (!fire(el, 'beforeinput', text)) return true;
    if (!document.execCommand || !document.execCommand('insertText', false, text)) {{
      const sel = getSelection();
      if (sel && sel.rangeCount) {{
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.setEndAfter(node);
        sel.removeAllRanges();
        sel.addRange(range);
      }}
    }}
    fire(el, 'input', text);
    return true;
  }}
  return false;
}})()"#,
        json_quote(text)
    )
}

/// Build JavaScript that applies editing keys to the focused editable element.
/// This is intentionally used for Backspace/Delete only. Other keys should stay
/// physical CEF key events so browser shortcuts keep working.
pub fn build_edit_key_js(key: &str) -> String {
    format!(
        r#"(() => {{
  const key = {key};
  function active(root) {{
    let el = root.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }}
  function fire(el, type, inputType, data) {{
    try {{
      return el.dispatchEvent(new InputEvent(type, {{
        data,
        inputType,
        bubbles: true,
        cancelable: type === 'beforeinput',
        composed: true
      }}));
    }} catch (_) {{
      return el.dispatchEvent(new Event(type, {{ bubbles: true, cancelable: type === 'beforeinput' }}));
    }}
  }}
  const el = active(document);
  if (!el) return false;
  const tag = String(el.tagName || '').toLowerCase();
  const type = String(el.type || '').toLowerCase();
  const editableInput = tag === 'textarea' || (tag === 'input' && !['button','checkbox','radio','range','color','file','submit','reset','image','hidden'].includes(type));
  if (editableInput) {{
    let value = String(el.value ?? '');
    let start = value.length;
    let end = value.length;
    try {{
      if (typeof el.selectionStart === 'number') start = el.selectionStart;
      if (typeof el.selectionEnd === 'number') end = el.selectionEnd;
    }} catch (_) {{}}
    let inputType = '';
    if (key === 'Backspace') {{
      inputType = 'deleteContentBackward';
      if (start === end && start > 0) start--;
    }} else if (key === 'Delete') {{
      inputType = 'deleteContentForward';
      if (start === end && end < value.length) end++;
    }} else {{
      return false;
    }}
    if (start === end) return true;
    if (!fire(el, 'beforeinput', inputType, null)) return true;
    const next = value.slice(0, start) + value.slice(end);
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, next); else el.value = next;
    try {{ el.setSelectionRange(start, start); }} catch (_) {{}}
    fire(el, 'input', inputType, null);
    return true;
  }}
  if (el.isContentEditable) {{
    const command = key === 'Backspace' ? 'delete' : key === 'Delete' ? 'forwardDelete' : '';
    if (!command) return false;
    const inputType = key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward';
    if (!fire(el, 'beforeinput', inputType, null)) return true;
    try {{ document.execCommand(command, false); }} catch (_) {{}}
    fire(el, 'input', inputType, null);
    return true;
  }}
  return false;
}})()"#,
        key = json_quote(key),
    )
}

/// Build JavaScript that detects if a click target is an editable element,
/// focuses it, and positions the caret.
pub fn build_assist_editable_click_js(x: i32, y: i32) -> String {
    format!(
        r#"(() => {{
  const x = {x};
  const y = {y};
  function deepElementFromPoint(root, x, y) {{
    let el = root.elementFromPoint(x, y);
    while (el && el.shadowRoot) {{
      const next = el.shadowRoot.elementFromPoint(x, y);
      if (!next || next === el) break;
      el = next;
    }}
    return el;
  }}
  const el = deepElementFromPoint(document, x, y);
  if (!el) return false;
  const tag = String(el.tagName || '').toLowerCase();
  const type = String(el.type || '').toLowerCase();
  const editable = el.isContentEditable || tag === 'textarea' || (tag === 'input' && !['button','checkbox','radio','range','color','file','submit','reset','image','hidden'].includes(type));
  if (!editable) return false;
  try {{ el.focus({{ preventScroll: true }}); }} catch (_) {{ try {{ el.focus(); }} catch (_) {{}} }}
  if (el.isContentEditable) {{
    const pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : null;
    const range = pos ? document.createRange() : (document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null);
    if (pos && range) {{ range.setStart(pos.offsetNode, pos.offset); range.collapse(true); }}
    if (range) {{
      const sel = getSelection();
      if (sel) {{ sel.removeAllRanges(); sel.addRange(range); }}
    }}
  }}
  return true;
}})()"#,
        x = x,
        y = y,
    )
}

/// Prefix used by the hit-test JS to report results via console.log.
pub const HIT_TEST_PREFIX: &str = "__kitty_hit_test__:";

/// Build JavaScript that performs a hit-test at (x, y) and reports the result
/// via console.log with a known prefix.
pub fn build_hit_test_js(x: i32, y: i32) -> String {
    format!(
        r#"(() => {{
  const x = {x};
  const y = {y};
  function deepElementFromPoint(root, x, y) {{
    let el = root.elementFromPoint(x, y);
    while (el && el.shadowRoot) {{
      const next = el.shadowRoot.elementFromPoint(x, y);
      if (!next || next === el) break;
      el = next;
    }}
    return el;
  }}
  const el = deepElementFromPoint(document, x, y);
  if (!el) return;
  const tag = String(el.tagName || '').toLowerCase();
  const type = String(el.type || '').toLowerCase();
  const editable = el.isContentEditable || tag === 'textarea' || (tag === 'input' && !['button','checkbox','radio','range','color','file','submit','reset','image','hidden'].includes(type));
  const href = el.closest('a')?.href || '';
  const r = el.getBoundingClientRect();
  console.log('{prefix}' + JSON.stringify({{
    tag, type, editable, href,
    x: Math.round(r.x), y: Math.round(r.y),
    w: Math.round(r.width), h: Math.round(r.height)
  }}));
}})()"#,
        x = x,
        y = y,
        prefix = HIT_TEST_PREFIX,
    )
}

/// If `message` starts with HIT_TEST_PREFIX, strip it and return the remaining JSON.
/// Returns None if the message is not a hit-test event.
pub fn strip_hit_test_console_prefix(message: &str) -> Option<&str> {
    message.strip_prefix(HIT_TEST_PREFIX)
}

/// Convert a C string pointer to a Rust String. Returns empty string on null.
pub fn c_string_from_ptr(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
}

/// Convert a Rust String to a CString, replacing interior NUL bytes.
pub fn cstring_lossy(s: &str) -> CString {
    CString::new(s.replace('\0', "\u{fffd}")).unwrap_or_else(|_| CString::new("").unwrap())
}

/// Log a semantic event if debug mode is on.
pub fn log_semantic_debug(debug: bool, target: &str, msg: &str) {
    if !debug {
        return;
    }

    // hitTest is high-frequency metadata. Normal --debug should show cursor,
    // focus, accessibility summaries, and perf; not every pointer movement.
    if msg.starts_with("hitTest") || msg == "hitTest console event" {
        let enabled = std::env::var("KITTY_WEB_UI_HITTEST_DEBUG")
            .map(|v| {
                v == "1" ||
                v == "true" ||
                v == "TRUE" ||
                v == "yes" ||
                v == "YES"
            })
            .unwrap_or(false);
        if !enabled {
            return;
        }
    }

    super::core_log(super::LogLevel::Debug, target, msg);
}

/// JSON-escape a string and wrap in double quotes.
fn json_quote(s: &str) -> String {
    format!("\"{}\"", json_escape(s))
}
