/// Convert CEF BGRA buffer to RGBA or RGB.
///
/// CEF produces pixels in BGRA order (blue, green, red, alpha).
/// Kitty expects RGBA or RGB.
pub fn convert_bgra_into(src: &[u8], width: u32, height: u32, rgb: bool, out: &mut Vec<u8>) {
    let pixels = width as usize * height as usize;
    let channels = if rgb { 3 } else { 4 };
    out.resize(pixels * channels, 0);

    for i in 0..pixels {
        let src_base = i * 4;
        let dst_base = i * channels;
        out[dst_base] = src[src_base + 2];
        out[dst_base + 1] = src[src_base + 1];
        out[dst_base + 2] = src[src_base];
        if !rgb {
            out[dst_base + 3] = src[src_base + 3];
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirtyRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Convert only a dirty rectangle from a full CEF BGRA frame into a tightly
/// packed RGBA/RGB buffer. The returned buffer starts at (0, 0); the caller
/// carries `rect.x/y` separately for Kitty frame composition.
pub fn convert_bgra_rect_into(src: &[u8], frame_width: u32, rect: DirtyRect, rgb: bool, out: &mut Vec<u8>) {
    let channels = if rgb { 3usize } else { 4usize };
    let width = rect.width as usize;
    let height = rect.height as usize;
    out.resize(width * height * channels, 0);

    for row in 0..height {
        for col in 0..width {
            let src_base = (((rect.y as usize + row) * frame_width as usize) + rect.x as usize + col) * 4;
            let dst_base = (row * width + col) * channels;
            out[dst_base] = src[src_base + 2];
            out[dst_base + 1] = src[src_base + 1];
            out[dst_base + 2] = src[src_base];
            if !rgb {
                out[dst_base + 3] = src[src_base + 3];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reusable_rgb_buffer_matches_known_pixels_and_keeps_allocation() {
        let bgra = [30, 20, 10, 255, 60, 50, 40, 255];
        let mut out = Vec::with_capacity(32);
        let allocation = out.as_ptr();

        convert_bgra_into(&bgra, 2, 1, true, &mut out);

        assert_eq!(out, [10, 20, 30, 40, 50, 60]);
        assert_eq!(out.as_ptr(), allocation);
    }

    #[test]
    fn reusable_dirty_buffer_is_tightly_packed() {
        let bgra = [
            3, 2, 1, 255, 6, 5, 4, 255,
            9, 8, 7, 255, 12, 11, 10, 255,
        ];
        let mut out = Vec::new();

        convert_bgra_rect_into(
            &bgra,
            2,
            DirtyRect { x: 1, y: 0, width: 1, height: 2 },
            true,
            &mut out,
        );

        assert_eq!(out, [4, 5, 6, 10, 11, 12]);
    }
}
