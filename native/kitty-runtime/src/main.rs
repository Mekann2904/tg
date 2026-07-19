use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::io::{self, BufRead, BufReader, Write};

const DISPLAY_IMAGE_ID: u32 = 200;
const PLACEMENT_ID: u32 = 1;
const ROOT_FRAME: u32 = 1;
const STAGING_FRAME: u32 = 2;
const SYNC_BEGIN: &str = "\x1b[?2026h";
const SYNC_END: &str = "\x1b[?2026l";

#[derive(Default)]
struct Runtime {
    raw_initialized: bool,
    last_source_key: String,
    last_place: Option<Placement>,
    cleanup_image_ids: Vec<u32>,
    current_frame: u32,
    has_staging_frame: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Placement {
    x_cell: u32,
    y_cell: u32,
    cols: u32,
    rows: u32,
    pixel_width: u32,
    pixel_height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFile {
    path: String,
    byte_length: usize,
    width: u32,
    height: u32,
    #[serde(default = "default_format")]
    format: String,
    dirty: Option<DirtyRect>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirtyRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum Command {
    #[serde(rename = "drawFile")]
    DrawFile {
        raw: RawFile,
        place: Placement,
    },
    #[serde(rename = "clear")]
    Clear,
    #[serde(rename = "resetRawFile")]
    ResetRawFile,
    #[serde(rename = "dispose")]
    Dispose,
}

fn default_format() -> String {
    "rgba".to_string()
}

fn main() -> Result<()> {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut stdout = io::stdout().lock();
    let mut runtime = Runtime {
        cleanup_image_ids: (200..216).collect(),
        ..Runtime::default()
    };

    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }

        let command: Command = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[kitty-runtime] invalid command json: {e}: {line}");
                continue;
            }
        };

        match command {
            Command::DrawFile { raw, place } => {
                runtime.draw_file(&mut stdout, raw, place)?;
            }
            Command::Clear => {
                runtime.delete_raw_images(&mut stdout)?;
                stdout.write_all(b"\x1b[2J\x1b[H")?;
                runtime.last_place = None;
                stdout.flush()?;
            }
            Command::ResetRawFile => {
                runtime.delete_raw_images(&mut stdout)?;
                runtime.raw_initialized = false;
                stdout.flush()?;
            }
            Command::Dispose => {
                runtime.delete_raw_images(&mut stdout)?;
                stdout.write_all(runtime.delete_sequence().as_bytes())?;
                stdout.flush()?;
                break;
            }
        }
    }

    Ok(())
}

impl Runtime {
    fn draw_file<W: Write>(&mut self, out: &mut W, raw: RawFile, place: Placement) -> Result<()> {
        let mut seq = String::new();
        let format = if raw.format == "rgb" { "rgb" } else { "rgba" };
        let source_key = format!("{}x{}:{}", raw.width, raw.height, format);

        let placement_changed = self
            .last_place
            .as_ref()
            .map(|last| last != &place)
            .unwrap_or(false);
        let source_changed = self.last_source_key != source_key;

        if placement_changed || source_changed {
            seq.push_str(&self.delete_sequence());
            seq.push_str("\x1b[2J\x1b[H");
            self.raw_initialized = false;
            self.current_frame = ROOT_FRAME;
            self.has_staging_frame = false;
        }

        self.last_place = Some(place.clone());
        self.last_source_key = source_key;

        let kitty_format = if format == "rgb" { 24 } else { 32 };
        let transient = if transient_hint() { ",N=1" } else { "" };
        // POSIX shm: payload is the base64 of the single-use shm object name.
        // Kitty unlinks it after reading, so never cache these names.
        let transfer_code = "s";
        let payload = STANDARD.encode(raw.path.as_bytes());

        if !self.raw_initialized {
            for id in &self.cleanup_image_ids {
                seq.push_str(&format!("\x1b_Ga=d,i={id},q=2;\x1b\\"));
            }

            seq.push_str(&format!("\x1b[{};{}H", place.y_cell, place.x_cell));
            seq.push_str(&format!(
                "\x1b_Ga=T,i={},p={},f={},t={},S={},s={},v={},c={},r={},C=1,q=2{transient};{}\x1b\\",
                DISPLAY_IMAGE_ID,
                PLACEMENT_ID,
                kitty_format,
                transfer_code,
                raw.byte_length,
                raw.width,
                raw.height,
                place.cols,
                place.rows,
                payload,
            ));
            seq.push_str(&format!("\x1b_Ga=a,i={},c={},q=2;\x1b\\", DISPLAY_IMAGE_ID, ROOT_FRAME));
            self.raw_initialized = true;
            self.current_frame = ROOT_FRAME;
            self.has_staging_frame = false;
        } else if !self.has_staging_frame && raw.dirty.is_some() {
            // The second animation frame must be seeded by a full frame. Using a
            // dirty payload to create it can produce a transparent canvas on
            // some Kitty versions. Until the full seed arrives, keep the known
            // complete root visible and update it in place.
            let d = raw.dirty.as_ref().unwrap();
            seq.push_str(&format!(
                "\x1b_Ga=f,i={},r={},f={},t={},S={},x={},y={},s={},v={},X=1,q=2{transient};{}\x1b\\",
                DISPLAY_IMAGE_ID, ROOT_FRAME, kitty_format, transfer_code, raw.byte_length,
                d.x, d.y, d.width, d.height, payload,
            ));
        } else {
            // Build the next complete frame off-screen and only then select it.
            // Synchronized output prevents an intermediate state from painting.
            let target = if self.current_frame == ROOT_FRAME { STAGING_FRAME } else { ROOT_FRAME };
            seq.push_str(SYNC_BEGIN);

            if self.has_staging_frame {
                seq.push_str(&format!(
                    "\x1b_Ga=c,i={},r={},c={},w={},h={},C=1,q=2;\x1b\\",
                    DISPLAY_IMAGE_ID, self.current_frame, target, raw.width, raw.height,
                ));
            }

            if let Some(d) = raw.dirty {
                let base = if self.has_staging_frame {
                    format!("r={target}")
                } else {
                    format!("c={}", self.current_frame)
                };
                seq.push_str(&format!(
                    "\x1b_Ga=f,i={}, {},f={},t={},S={},x={},y={},s={},v={},X=1,q=2{transient};{}\x1b\\",
                    DISPLAY_IMAGE_ID, base, kitty_format, transfer_code, raw.byte_length,
                    d.x, d.y, d.width, d.height, payload,
                ).replace(", ", ","));
            } else {
                let base = if self.has_staging_frame {
                    format!("r={target}")
                } else {
                    format!("c={}", self.current_frame)
                };
                seq.push_str(&format!(
                    "\x1b_Ga=f,i={}, {},f={},t={},S={},s={},v={},X=1,q=2{transient};{}\x1b\\",
                    DISPLAY_IMAGE_ID, base, kitty_format, transfer_code, raw.byte_length,
                    raw.width, raw.height, payload,
                ).replace(", ", ","));
            }

            seq.push_str(&format!("\x1b_Ga=a,i={},c={},q=2;\x1b\\", DISPLAY_IMAGE_ID, target));
            seq.push_str(SYNC_END);
            self.current_frame = target;
            self.has_staging_frame = true;
        }

        out.write_all(seq.as_bytes()).context("write kitty graphics sequence")?;
        out.flush().context("flush kitty graphics sequence")?;
        Ok(())
    }

    fn delete_raw_images<W: Write>(&mut self, out: &mut W) -> Result<()> {
        self.raw_initialized = false;
        self.current_frame = ROOT_FRAME;
        self.has_staging_frame = false;
        self.last_source_key.clear();
        for id in &self.cleanup_image_ids {
            write!(out, "\x1b_Ga=d,i={id},q=2;\x1b\\")?;
        }
        Ok(())
    }

    fn delete_sequence(&self) -> String {
        self.cleanup_image_ids
            .iter()
            .map(|id| format!("\x1b_Ga=d,i={id},q=2;\x1b\\"))
            .collect::<Vec<_>>()
            .join("")
    }

}

// Graphics protocol usage hint "transient" (N=1, PR kovidgoyal/kitty#10092). Default
// ON for this build (targets Kitty with usage hints); disable with
// KITTY_WEBVIEW_TRANSIENT_HINT=0. Older kitty rejects the unknown N key and
// drops the command.
fn transient_hint() -> bool {
    match std::env::var("KITTY_WEBVIEW_TRANSIENT_HINT") {
        Ok(v) => !(v == "0" || v == "false" || v == "FALSE" || v == "no" || v == "NO"),
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place() -> Placement {
        Placement { x_cell: 1, y_cell: 1, cols: 2, rows: 2, pixel_width: 2, pixel_height: 2 }
    }

    fn raw(dirty: Option<DirtyRect>) -> RawFile {
        RawFile {
            path: "/frame".into(), byte_length: if dirty.is_some() { 3 } else { 12 },
            width: 2, height: 2, format: "rgb".into(), dirty,
        }
    }

    #[test]
    fn file_deltas_are_staged_and_swapped_atomically() {
        let mut runtime = Runtime { cleanup_image_ids: vec![], ..Runtime::default() };
        let mut output = Vec::new();
        runtime.draw_file(&mut output, raw(None), place()).unwrap();
        output.clear();

        runtime.draw_file(
            &mut output,
            raw(Some(DirtyRect { x: 1, y: 0, width: 1, height: 1 })),
            place(),
        ).unwrap();
        let first = String::from_utf8(output.clone()).unwrap();
        assert!(!first.contains(SYNC_BEGIN));
        assert!(first.contains("a=f,i=200,r=1"));
        assert!(!first.contains("a=a,i=200,c=2"));

        // A full frame safely seeds the hidden frame even when background-copy
        // semantics differ between Kitty versions.
        output.clear();
        runtime.draw_file(&mut output, raw(None), place()).unwrap();
        let seed = String::from_utf8(output.clone()).unwrap();
        assert!(seed.starts_with(SYNC_BEGIN));
        assert!(seed.contains("a=f,i=200,c=1"));
        assert!(seed.contains("a=a,i=200,c=2"));
        assert!(seed.ends_with(SYNC_END));

        output.clear();
        runtime.draw_file(
            &mut output,
            raw(Some(DirtyRect { x: 0, y: 1, width: 1, height: 1 })),
            place(),
        ).unwrap();
        let second = String::from_utf8(output.clone()).unwrap();
        assert!(second.contains("a=c,i=200,r=2,c=1,w=2,h=2,C=1"));
        assert!(second.contains("a=f,i=200,r=1"));
        assert!(second.contains("a=a,i=200,c=1"));

        output.clear();
        runtime.draw_file(
            &mut output,
            raw(Some(DirtyRect { x: 1, y: 1, width: 1, height: 1 })),
            place(),
        ).unwrap();
        let third = String::from_utf8(output).unwrap();
        assert!(third.contains("a=c,i=200,r=1,c=2,w=2,h=2,C=1"));
        assert!(third.contains("a=f,i=200,r=2"));
        assert!(third.contains("a=a,i=200,c=2"));
    }

}
