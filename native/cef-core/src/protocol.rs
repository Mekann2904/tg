use std::ffi::c_char;

use crate::frame::FrameMeta;

/// Build the 4-byte-padded JSON header that is sent over TCP before each frame.
///
/// The TypeScript side reads the 4-byte LE length prefix, then the JSON body.
pub fn build_frame_header(meta: &FrameMeta, path: &str) -> String {
    let format = unsafe {
        std::ffi::CStr::from_ptr(meta.format as *const c_char)
            .to_string_lossy()
            .into_owned()
    };

    let mut json = format!(
        r#"{{"type":"frameFile","seq":{},"generation":{},"width":{},"height":{},"stride":{},"format":"{}","transfer":"file","byteLength":{},"path":"{}"}}"#,
        meta.seq,
        meta.generation,
        meta.width,
        meta.height,
        meta.stride,
        format,
        meta.byte_len,
        json_escape(path),
    );

    // Pad to 4-byte alignment (matches C++ FrameServer::SendHeader).
    while json.len() % 4 != 0 {
        json.push(' ');
    }

    json
}

/// Escape a string for embedding in a JSON string value.
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
mod tests {
    use super::*;

    #[test]
    fn test_json_escape() {
        assert_eq!(json_escape("hello"), "hello");
        assert_eq!(json_escape(r#"a"b\c"#), r#"a\"b\\c"#);
        assert_eq!(json_escape("a\nb"), r#"a\nb"#);
    }

    #[test]
    fn test_frame_header_alignment() {
        let meta = FrameMeta {
            seq: 1,
            generation: 0,
            width: 100,
            height: 100,
            stride: 400,
            byte_len: 40000,
            format: b"rgba\0".as_ptr() as *const c_char,
            path_ptr: std::ptr::null(),
            path_len: 0,
        };
        let header = build_frame_header(&meta, "/tmp/test.rgba");
        assert_eq!(header.len() % 4, 0);
        assert!(header.contains(r#""type":"frameFile""#));
        assert!(header.contains(r#""seq":1"#));
    }
}
