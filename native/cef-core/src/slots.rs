use libc::{close, ftruncate, mmap, munmap, shm_open, shm_unlink, MAP_FAILED, MAP_SHARED, O_CREAT, O_EXCL, O_RDWR, PROT_READ, PROT_WRITE};
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_SLOTS: usize = 8;
const MAX_SLOTS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferKind {
    File,
    Shm,
    Direct,
}

impl TransferKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TransferKind::File => "file",
            TransferKind::Shm => "shm",
            TransferKind::Direct => "direct",
        }
    }
}

pub struct FrameWrite {
    pub name: String,
    pub transfer: TransferKind,
}

pub enum FrameSlots {
    /// Adaptive (default): small dirty deltas go direct (inline base64,
    /// memory-only); full frames and large deltas go through `shm`. Falls back
    /// to direct if the stored transport cannot accept the payload.
    Adaptive { shm: ShmSlots, threshold: usize },
    /// Forced single transport (KITTY_WEBVIEW_TRANSFER=shm|file|direct).
    Shm(ShmSlots),
    File(RawSlots),
    Direct,
}

impl FrameSlots {
    pub fn new() -> Self {
        match transfer_preference().as_str() {
            "file" => FrameSlots::File(RawSlots::new()),
            "direct" | "inline" | "memory" => FrameSlots::Direct,
            "shm" => {
                // Strict shm mode. Do not silently fall back to file, because
                // KITTY_WEBVIEW_TRANSFER=shm is expected to avoid disk-backed
                // frame transport entirely.
                FrameSlots::Shm(ShmSlots::new())
            }
            // default ("auto"/unknown): adaptive. Small payloads bypass shm
            // entirely (memory-only, no per-frame shm object); large/full
            // payloads use shm to avoid PTY congestion and the full-frame
            // direct flicker seen on some kitty sessions.
            _ => FrameSlots::Adaptive {
                shm: ShmSlots::new(),
                threshold: direct_threshold(),
            },
        }
    }

    /// Per-frame transport choice. `full_frame` forces the stored transport:
    /// a full-frame base64 inline transfer congests the PTY and flickers on
    /// some kitty sessions, so full frames never go direct.
    pub fn choose(&self, payload_bytes: usize, full_frame: bool) -> TransferKind {
        match self {
            FrameSlots::Adaptive { threshold, .. } => {
                if full_frame || payload_bytes >= *threshold {
                    TransferKind::Shm
                } else {
                    TransferKind::Direct
                }
            }
            FrameSlots::Shm(_) => TransferKind::Shm,
            FrameSlots::File(_) => TransferKind::File,
            FrameSlots::Direct => TransferKind::Direct,
        }
    }

    /// Write a payload to the stored transport (shm or file). Used for full
    /// frames and large deltas. Returns None only if the transport cannot
    /// accept the payload; the caller then falls back to direct.
    pub fn write_stored(&mut self, data: &[u8]) -> Option<FrameWrite> {
        match self {
            FrameSlots::Adaptive { shm, .. } | FrameSlots::Shm(shm) => {
                shm.write(data).map(|name| FrameWrite { name, transfer: TransferKind::Shm })
            }
            FrameSlots::File(s) => {
                s.write(data).map(|name| FrameWrite { name, transfer: TransferKind::File })
            }
            FrameSlots::Direct => None,
        }
    }

    pub fn slot_count(&self) -> usize {
        match self {
            FrameSlots::Adaptive { shm, .. } => shm.slot_count(),
            FrameSlots::Shm(s) => s.slot_count(),
            FrameSlots::File(s) => s.slot_count(),
            FrameSlots::Direct => 0,
        }
    }

    pub fn mode(&self) -> &'static str {
        match self {
            FrameSlots::Adaptive { .. } => "adaptive-direct-shm",
            FrameSlots::Shm(s) => s.mode(),
            FrameSlots::File(s) => s.mode(),
            FrameSlots::Direct => "direct-inline",
        }
    }

    pub fn is_direct(&self) -> bool {
        matches!(self, FrameSlots::Direct)
    }
}

fn transfer_preference() -> String {
    std::env::var("KITTY_WEBVIEW_TRANSFER")
        .ok()
        .map(|v| v.to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "auto".to_string())
}

/// Largest dirty payload sent via direct (inline base64). Above this, or for
/// any full frame, the stored transport (shm) is used to avoid PTY congestion.
/// 384 KiB covers typical cursor/UI/text deltas; larger repaints (scrolling,
/// video) and full frames go through shm where pixels bypass the PTY entirely.
fn direct_threshold() -> usize {
    std::env::var("KITTY_WEBVIEW_DIRECT_THRESHOLD_BYTES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .map(|v| v.max(1024))
        .unwrap_or(393_216)
}

fn slot_count_from_env() -> usize {
    std::env::var("KITTY_WEBVIEW_SHM_SLOTS")
        .ok()
        .or_else(|| std::env::var("KITTY_WEBVIEW_RAW_SLOTS").ok())
        .and_then(|v| v.parse::<usize>().ok())
        .map(|n| n.clamp(2, MAX_SLOTS))
        .unwrap_or(DEFAULT_SLOTS)
}

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

    pub fn slot_count(&self) -> usize {
        // There is intentionally no reusable shm ring. Kitty unlinks POSIX shm
        // objects after reading them, so each frame must get a fresh name.
        1
    }

    pub fn mode(&self) -> &'static str {
        "single-use-shm"
    }

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

/// Bounded raw file slots for Kitty file-transfer frames.
///
/// Do not create one file per frame. Video pages turn that into heavy
/// open/write/rename/unlink pressure on macOS. A bounded slot ring keeps the
/// transport predictable. Correctness should come from flow control, not
/// unbounded path creation.
pub struct RawSlots {
    dir: PathBuf,
    paths: Vec<PathBuf>,
    fds: Vec<fs::File>,
    next: usize,
    slot_size: u64,
}

impl RawSlots {
    pub fn new() -> Self {
        let slot_count = slot_count_from_env();

        let base = Self::raw_dir_base();
        let pid = std::process::id();
        let tmpl = format!("kitty-webview-cef-{}-XXXXXX", pid);

        let dir = match tempfile_in(&base, &tmpl) {
            Ok(d) => d,
            Err(_) => base.clone(),
        };

        let mut paths = Vec::with_capacity(slot_count);
        let mut fds = Vec::with_capacity(slot_count);
        let ext = if std::env::var("KITTY_WEBVIEW_PIXEL_FORMAT").as_deref() == Ok("rgb") {
            "rgb"
        } else {
            "rgba"
        };

        for i in 0..slot_count {
            let p = dir.join(format!("{}.{}", i, ext));
            match fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .mode(0o600)
                .open(&p)
            {
                Ok(f) => {
                    paths.push(p);
                    fds.push(f);
                }
                Err(_) => continue,
            }
        }

        RawSlots {
            dir,
            paths,
            fds,
            next: 0,
            slot_size: 0,
        }
    }

    pub fn slot_count(&self) -> usize {
        self.fds.len()
    }

    pub fn mode(&self) -> &'static str {
        "bounded-file-slots"
    }

    /// Write frame data to the next bounded slot. Returns the file path.
    pub fn write(&mut self, data: &[u8]) -> Option<String> {
        if data.is_empty() || self.fds.is_empty() {
            return None;
        }

        let len = data.len() as u64;
        if self.slot_size != len {
            self.slot_size = len;
            for f in &self.fds {
                f.set_len(len).ok()?;
            }
            self.next = 0;
        }

        let slot = self.next % self.fds.len();
        self.next = self.next.wrapping_add(1);

        use std::os::unix::fs::FileExt;
        self.fds[slot].write_all_at(data, 0).ok()?;
        Some(self.paths[slot].to_string_lossy().into_owned())
    }

    pub fn max_slots() -> usize {
        MAX_SLOTS
    }

    fn raw_dir_base() -> PathBuf {
        if let Ok(val) = std::env::var("KITTY_WEBVIEW_RAW_DIR") {
            if !val.is_empty() {
                return PathBuf::from(val);
            }
        }
        if fs::metadata("/dev/shm").map(|m| m.is_dir()).unwrap_or(false) {
            let probe = PathBuf::from("/dev/shm").join(format!("kitty-webview-probe-{}", std::process::id()));
            if let Ok(f) = fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .mode(0o600)
                .open(&probe)
            {
                drop(f);
                let _ = fs::remove_file(probe);
                return PathBuf::from("/dev/shm");
            }
        }
        std::env::var("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp"))
    }
}

impl Drop for RawSlots {
    fn drop(&mut self) {
        self.fds.clear();
        for p in &self.paths {
            let _ = fs::remove_file(p);
        }
        let _ = fs::remove_dir(&self.dir);
    }
}

/// Minimal mkdtemp equivalent.
fn tempfile_in(base: &PathBuf, tmpl: &str) -> io::Result<PathBuf> {
    use std::ffi::CString;
    let path = base.join(tmpl);
    let c_path = CString::new(path.to_string_lossy().into_owned()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "bad path"))?;
    let mut buf: Vec<u8> = c_path.into_bytes_with_nul();
    let ptr = buf.as_mut_ptr() as *mut i8;
    let result = unsafe { libc::mkdtemp(ptr) };
    if result.is_null() {
        return Err(io::Error::last_os_error());
    }
    let c_str = unsafe { std::ffi::CStr::from_ptr(result) };
    Ok(PathBuf::from(c_str.to_string_lossy().into_owned()))
}
