use libc::{close, ftruncate, mmap, munmap, shm_open, shm_unlink, MAP_FAILED, MAP_SHARED, O_CREAT, O_EXCL, O_RDWR, PROT_READ, PROT_WRITE};
use std::ffi::CString;
use std::time::{SystemTime, UNIX_EPOCH};

/// Single-use POSIX shared-memory frame transport.
///
/// Each frame is written to a fresh shm object whose name is handed to Kitty
/// via `t=s`, so pixels bypass the PTY entirely. Kitty opens, reads, and
/// unlinks the object after reading, so names are never reused.
pub struct ShmSlots {
    next: u64,
    prefix: String,
}

impl ShmSlots {
    pub fn new() -> Self {
        let pid = std::process::id();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);

        // Keep shm names short. POSIX shm implementations and terminal parsers
        // are less likely to have issues with short single-component names.
        let prefix = format!("/kw{:x}{:x}", pid, stamp & 0xfffff);

        ShmSlots { next: 0, prefix }
    }

    pub fn mode(&self) -> &'static str {
        "single-use-shm"
    }

    /// Write a frame to a fresh single-use shm object and return its name.
    /// Returns None only if the object cannot be created or filled.
    pub fn write(&mut self, data: &[u8]) -> Option<String> {
        if data.is_empty() {
            return None;
        }

        let seq = self.next;
        self.next = self.next.wrapping_add(1);

        // Keep this short. POSIX shm names should be /name, with no additional
        // slashes. Kitty receives this exact name via t=s.
        let display_name = format!("{}{:x}", self.prefix, seq);
        let Ok(name) = CString::new(display_name.clone()) else {
            return None;
        };

        let fd = unsafe {
            shm_open(
                name.as_ptr(),
                O_CREAT | O_EXCL | O_RDWR,
                0o600,
            )
        };

        if fd < 0 {
            return None;
        }

        let result = unsafe { write_single_use_shm(&name, fd, data) };
        if result.is_err() {
            unsafe {
                close(fd);
                shm_unlink(name.as_ptr());
            }
            return None;
        }

        unsafe {
            close(fd);
        }

        // Do not shm_unlink() here. For Kitty t=s, the terminal opens, reads,
        // closes, and unlinks the POSIX shm object. Reusing or unlinking it on
        // the client side can make the image disappear.
        Some(display_name)
    }
}

unsafe fn write_single_use_shm(name: &CString, fd: i32, data: &[u8]) -> Result<(), ()> {
    let len = data.len();

    if ftruncate(fd, len as libc::off_t) != 0 {
        shm_unlink(name.as_ptr());
        return Err(());
    }

    let ptr = mmap(
        std::ptr::null_mut(),
        len,
        PROT_READ | PROT_WRITE,
        MAP_SHARED,
        fd,
        0,
    );

    if ptr == MAP_FAILED {
        shm_unlink(name.as_ptr());
        return Err(());
    }

    std::ptr::copy_nonoverlapping(
        data.as_ptr(),
        ptr as *mut u8,
        len,
    );

    // munmap after copy is fine. The named shm object remains alive until
    // Kitty opens and unlinks it.
    if munmap(ptr, len) != 0 {
        shm_unlink(name.as_ptr());
        return Err(());
    }

    Ok(())
}
