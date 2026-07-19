//! Standalone probe: test Kitty protocol response reading step by step.
//! 1. Kitty version query (DA3 request) — simplest possible response test
//! 2. graphics query action with q=0
//! 3. t=f file transfer with q=0
//! 4. t=s shm transfer with q=0

use std::ffi::CString;
use std::fs;

use base64::Engine;

const PIXELS: [u8; 16] = [
    0xFF, 0x00, 0x00, 0xFF,
    0xFF, 0x00, 0x00, 0xFF,
    0xFF, 0x00, 0x00, 0xFF,
    0xFF, 0x00, 0x00, 0xFF,
];

fn main() {
    let tty_in = libc::STDIN_FILENO;
    let tty_out = libc::STDOUT_FILENO;

    if unsafe { libc::isatty(tty_in) } == 0 {
        eprintln!("ERROR: stdin is not a terminal");
        std::process::exit(1);
    }

    // Save original termios
    let mut orig: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(tty_in, &mut orig) } != 0 {
        eprintln!("ERROR: tcgetattr failed");
        std::process::exit(1);
    }
    let mut raw = orig;
    unsafe { libc::cfmakeraw(&mut raw) };
    raw.c_oflag |= libc::OPOST; // keep output processing
    // Ensure read doesn't block forever: VMIN=1, VTIME=0
    raw.c_cc[libc::VMIN] = 1;
    raw.c_cc[libc::VTIME] = 0;
    unsafe { libc::tcsetattr(tty_in, libc::TCSANOW, &raw) };

    let _guard = scopeguard::guard((), |()| {
        unsafe { libc::tcsetattr(tty_in, libc::TCSANOW, &orig) };
    });

    // Drain any pending input
    drain_input(tty_in);

    // ---- Test 0: DA3 (device attributes, secondary) ----
    eprintln!("=== Test 0: DA3 (identify terminal) ===");
    // Send CSI > c (DA3 / secondary device attributes)
    raw_write(tty_out, b"\x1b[>c");
    let da3 = read_response(tty_in, 1000);
    eprintln!("  response: {}", escape_repr(&da3));
    if da3.is_empty() {
        eprintln!("  ❌ NO RESPONSE — cannot read from terminal at all");
        eprintln!("  This usually means the probe is not running in a real terminal");
        eprintln!("  or the terminal does not respond to DA3.");
    } else {
        let s = String::from_utf8_lossy(&da3);
        if s.contains("kitty") || s.starts_with("\x1bP>") || s.contains("0;kitty") {
            eprintln!("  ✅ Kitty (or Kitty-compatible) detected");
        } else {
            eprintln!("  ⚠️  Terminal responded but may not be Kitty");
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(100));
    drain_input(tty_in);

    // ---- Test 1: Kitty graphics query (send_query) ----
    eprintln!("\n=== Test 1: Kitty graphics send_query ===");

    // Use the official query action. Do not use q=1/q=2 for capability
    // detection, because q is response-suppression. This sends a 1x1 RGB
    // direct image query. A supporting terminal should return OK or ERR.
    raw_write(tty_out, b"\x1b_Ga=q,t=d,f=24,s=1,v=1,q=0;AAAA\x1b\\");
    let qresp = read_response(tty_in, 1000);
    eprintln!("  response: {}", escape_repr(&qresp));
    if has_graphics_response(&qresp) {
        eprintln!("  ✅ Kitty graphics protocol is responding");
    } else if qresp.is_empty() {
        eprintln!("  ❌ NO RESPONSE — graphics query action did not respond");
    } else {
        eprintln!("  ⚠️  Got some response, unclear format");
    }

    std::thread::sleep(std::time::Duration::from_millis(100));
    drain_input(tty_in);

    // ---- Test 2: t=f (file transfer) ----
    eprintln!("\n=== Test 2: t=f (file transfer) ===");
    let pid = std::process::id();
    let fpath = format!("/tmp/kwui-probe-{}", pid);
    match fs::write(&fpath, &PIXELS) {
        Ok(_) => {}
        Err(e) => {
            eprintln!("  FAIL: write file: {}", e);
            return;
        }
    }
    let payload_f = base64::engine::general_purpose::STANDARD.encode(fpath.as_bytes());
    let cmd_f = format!(
        "\x1b_Ga=T,i=91001,f=32,s=2,v=2,t=f,S={},q=0;{}\x1b\\",
        PIXELS.len(),
        payload_f,
    );
    eprintln!("  cmd (escaped): {}", escape_repr(cmd_f.as_bytes()));
    raw_write(tty_out, cmd_f.as_bytes());
    let fresp = read_response(tty_in, 1000);
    eprintln!("  response: {}", escape_repr(&fresp));
    let f_ok = classify("t=f", &fresp);
    let _ = fs::remove_file(&fpath);

    std::thread::sleep(std::time::Duration::from_millis(100));
    drain_input(tty_in);

    // ---- Test 3: t=s (shm transfer) ----
    eprintln!("\n=== Test 3: t=s (shm transfer) ===");
    let shm_name = format!("/kwui-probe-{}", pid);
    let c_name = CString::new(shm_name.clone()).unwrap();
    let shm_result = create_shm(&c_name);

    match shm_result {
        Ok(()) => {
            let payload_s = base64::engine::general_purpose::STANDARD.encode(shm_name.as_bytes());
            let cmd_s = format!(
                "\x1b_Ga=T,i=91002,f=32,s=2,v=2,t=s,S={},q=0;{}\x1b\\",
                PIXELS.len(),
                payload_s,
            );
            eprintln!("  cmd (escaped): {}", escape_repr(cmd_s.as_bytes()));
            raw_write(tty_out, cmd_s.as_bytes());
            let sresp = read_response(tty_in, 1000);
            eprintln!("  response: {}", escape_repr(&sresp));
            let s_ok = classify("t=s", &sresp);

            // For POSIX shared memory, Kitty-compatible terminals should
            // unlink after reading. Try cleanup anyway; ENOENT is fine.
            unsafe {
                libc::shm_unlink(c_name.as_ptr());
            };

            std::thread::sleep(std::time::Duration::from_millis(100));
            drain_input(tty_in);

            // Cleanup: delete the test images
            raw_write(tty_out, b"\x1b_Ga=d,i=91001,q=1\x1b\\");
            raw_write(tty_out, b"\x1b_Ga=d,i=91002,q=1\x1b\\");

            // ---- Final summary ----
            eprintln!("\n=== Summary ===");
            eprintln!("  DA3 response: {}", if da3.is_empty() { "NONE" } else { "GOT" });
            eprintln!("  Graphics query: {}", if qresp.is_empty() { "NONE" } else { "GOT" });
            eprintln!("  t=f: {}", f_ok);
            eprintln!("  t=s: {}", s_ok);

            if s_ok.contains("OK") {
                eprintln!("\n✅ t=s is supported — shm transfer works");
            } else if f_ok.contains("OK") && !s_ok.contains("OK") {
                eprintln!("\n❌ t=f works but t=s did not — shared memory transfer is not usable in this terminal/session");
            } else if !da3.is_empty() && qresp.is_empty() && fresp.is_empty() && sresp.is_empty() {
                eprintln!("\n⚠️  Terminal responds to DA3 but NOT to graphics protocol");
                eprintln!("   Or this probe is not reading APC responses from the same terminal stream.");
            }
        }
        Err(e) => {
            eprintln!("  FAIL: shm creation: {}", e);
            unsafe { libc::shm_unlink(c_name.as_ptr()); };
        }
    }
}

fn create_shm(c_name: &CString) -> Result<(), String> {
    let fd = unsafe {
        libc::shm_open(
            c_name.as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_RDWR,
            0o600,
        )
    };
    if fd < 0 {
        return Err(format!("shm_open: {}", std::io::Error::last_os_error()));
    }
    if unsafe { libc::ftruncate(fd, PIXELS.len() as libc::off_t) } != 0 {
        unsafe { libc::close(fd); libc::shm_unlink(c_name.as_ptr()); };
        return Err("ftruncate failed".to_string());
    }
    let ptr = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            PIXELS.len(),
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED,
            fd,
            0,
        )
    };
    if ptr == libc::MAP_FAILED {
        unsafe { libc::close(fd); libc::shm_unlink(c_name.as_ptr()); };
        return Err(format!("mmap: {}", std::io::Error::last_os_error()));
    }
    unsafe {
        std::ptr::copy_nonoverlapping(PIXELS.as_ptr(), ptr as *mut u8, PIXELS.len());
        libc::munmap(ptr, PIXELS.len());
        libc::close(fd);
    }
    Ok(())
}

fn raw_write(fd: i32, data: &[u8]) {
    unsafe {
        libc::write(fd, data.as_ptr() as *const libc::c_void, data.len());
        libc::tcdrain(fd);
    }
}

fn drain_input(fd: i32) {
    let mut buf = [0u8; 1024];
    // Set non-blocking briefly to drain
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags >= 0 {
        unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
        for _ in 0..10 {
            let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n <= 0 { break; }
        }
        unsafe { libc::fcntl(fd, libc::F_SETFL, flags) };
    }
}

fn read_response(fd: i32, timeout_ms: u64) -> Vec<u8> {
    let mut response = Vec::new();
    let mut buf = [0u8; 1024];
    let start = std::time::Instant::now();

    loop {
        let elapsed = start.elapsed();
        if elapsed > std::time::Duration::from_millis(timeout_ms) {
            break;
        }

        let remaining = std::time::Duration::from_millis(timeout_ms) - elapsed;
        let mut tv = libc::timeval {
            tv_sec: remaining.as_secs() as libc::time_t,
            tv_usec: remaining.subsec_micros() as libc::suseconds_t,
        };
        let mut fds: libc::fd_set = unsafe { std::mem::zeroed() };
        unsafe {
            libc::FD_ZERO(&mut fds);
            libc::FD_SET(fd, &mut fds);
        };

        let n = unsafe {
            libc::select(
                fd + 1,
                &mut fds,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut tv,
            )
        };

        if n < 0 {
            let err = std::io::Error::last_os_error();
            eprintln!("  [debug] select error: {} (errno={})", err, err.raw_os_error().unwrap_or(0));
            break;
        }
        if n == 0 {
            continue;
        }

        let n = unsafe {
            libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len())
        };
        if n <= 0 {
            eprintln!("  [debug] read returned {}", n);
            break;
        }
        let n = n as usize;
        response.extend_from_slice(&buf[..n]);
        eprintln!("  [debug] read {} bytes", n);

        // Kitty APC responses end with ESC backslash
        if response.windows(2).any(|w| w == b"\x1b\\") {
            break;
        }
    }

    response
}

fn escape_repr(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len());
    for &b in data {
        match b {
            0x1b => s.push_str("ESC"),
            b' '..=b'~' => s.push(b as char),
            _ => s.push_str(&format!("\\x{:02x}", b)),
        }
    }
    s
}

fn has_graphics_response(response: &[u8]) -> bool {
    let s = String::from_utf8_lossy(response);
    s.contains("OK") ||
        s.contains("ERR") ||
        response.windows(2).any(|w| w == b"\x1b\\")
}

fn classify(label: &str, response: &[u8]) -> String {
    let s = String::from_utf8_lossy(response);
    if s.contains("OK") {
        format!("{} ✅ OK", label)
    } else if s.contains("ERR") {
        // Try to extract error detail
        let start = s.find("ERR").unwrap();
        let end = s[start..].find('\x1b').unwrap_or(s[start..].len());
        format!("{} ❌ {}", label, &s[start..start + end])
    } else if response.is_empty() {
        format!("{} ⚠️  NO RESPONSE", label)
    } else {
        format!("{} ❓ {}", label, escape_repr(response))
    }
}
