#[cfg(target_os = "macos")]
mod macos {
    use libc::{c_char, c_double, c_void};
    use std::ffi::CString;

    type CFTypeRef = *const c_void;
    type CFArrayRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type CFStringRef = *const c_void;
    type CGDirectDisplayID = u32;
    type CGWindowID = u32;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint { x: c_double, y: c_double }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize { width: c_double, height: c_double }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect { origin: CGPoint, size: CGSize }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: CGWindowID) -> CFArrayRef;
        fn CGRectMakeWithDictionaryRepresentation(dict: CFDictionaryRef, rect: *mut CGRect) -> bool;
        fn CGGetDisplaysWithRect(rect: CGRect, max_displays: u32, displays: *mut CGDirectDisplayID, count: *mut u32) -> i32;
        fn CGDisplayBounds(display: CGDirectDisplayID) -> CGRect;
        fn CGDisplayCopyDisplayMode(display: CGDirectDisplayID) -> CFTypeRef;
        fn CGDisplayModeGetWidth(mode_ref: CFTypeRef) -> usize;
        fn CGDisplayModeGetPixelWidth(mode_ref: CFTypeRef) -> usize;

        fn CFArrayGetCount(array: CFArrayRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFArrayRef, index: isize) -> CFTypeRef;
        fn CFDictionaryGetValue(dict: CFDictionaryRef, key: CFTypeRef) -> CFTypeRef;
        fn CFStringCreateWithCString(allocator: CFTypeRef, string: *const c_char, encoding: u32) -> CFStringRef;
        fn CFRelease(value: CFTypeRef);
    }

    const K_CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW: u32 = 1 << 3;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    pub fn for_window(window_id: u32) -> Option<f64> {
        unsafe {
            let windows = CGWindowListCopyWindowInfo(K_CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW, window_id);
            if windows.is_null() || CFArrayGetCount(windows) == 0 {
                if !windows.is_null() { CFRelease(windows); }
                return None;
            }

            let window = CFArrayGetValueAtIndex(windows, 0);
            let key_text = CString::new("kCGWindowBounds").ok()?;
            let key = CFStringCreateWithCString(std::ptr::null(), key_text.as_ptr(), K_CF_STRING_ENCODING_UTF8);
            let bounds = CFDictionaryGetValue(window, key);
            let mut rect = CGRect {
                origin: CGPoint { x: 0.0, y: 0.0 },
                size: CGSize { width: 0.0, height: 0.0 },
            };
            let represented = !bounds.is_null() && CGRectMakeWithDictionaryRepresentation(bounds, &mut rect);
            CFRelease(key);
            CFRelease(windows);
            if !represented { return None; }

            let mut displays = [0u32; 16];
            let mut count = 0u32;
            if CGGetDisplaysWithRect(rect, displays.len() as u32, displays.as_mut_ptr(), &mut count) != 0 || count == 0 {
                return None;
            }

            let display = displays[..count as usize]
                .iter()
                .copied()
                .max_by(|a, b| {
                    intersection_area(rect, CGDisplayBounds(*a))
                        .total_cmp(&intersection_area(rect, CGDisplayBounds(*b)))
                })?;
            let mode = CGDisplayCopyDisplayMode(display);
            if mode.is_null() { return None; }
            let logical = CGDisplayModeGetWidth(mode) as f64;
            let physical = CGDisplayModeGetPixelWidth(mode) as f64;
            CFRelease(mode);
            if logical <= 0.0 || physical <= 0.0 { return None; }
            Some((physical / logical).clamp(0.5, 4.0))
        }
    }

    fn intersection_area(a: CGRect, b: CGRect) -> f64 {
        let left = a.origin.x.max(b.origin.x);
        let top = a.origin.y.max(b.origin.y);
        let right = (a.origin.x + a.size.width).min(b.origin.x + b.size.width);
        let bottom = (a.origin.y + a.size.height).min(b.origin.y + b.size.height);
        (right - left).max(0.0) * (bottom - top).max(0.0)
    }
}

pub fn for_window(window_id: u32) -> Option<f64> {
    #[cfg(target_os = "macos")]
    { macos::for_window(window_id) }
    #[cfg(not(target_os = "macos"))]
    { let _ = window_id; None }
}
