# tg

> **Beta.** This project is under active development. APIs, flags, and behavior
> may change without notice, and some code paths are known to be unstable.

Offscreen browser (CEF) rendered inside the [kitty](https://sw.kovidgoyal.net/)
terminal via the Kitty Graphics Protocol. Extracted from the `kitty-web-ui`
prototype.

This build targets a kitty that ships the graphics-protocol **usage hints**
(`N` key, [PR kovidgoyal/kitty#10092](https://github.com/kovidgoyal/kitty/pull/10092)).
Older kitty rejects the `N` key and drops the frame, so the transient hint would
break rendering there — see "Defaults" below.

## Requirements

- [kitty](https://sw.kovidgoyal.net/kitty/) with graphics-protocol usage hints (#10092).
- [Bun](https://bun.sh/) `>= 1.3.12`.
- Rust toolchain (for the Kitty graphics renderer): `cargo`.
- A CEF binary distribution (`CEF_ROOT`) and a C++ toolchain.

## Setup

```bash
bun install

# Kitty graphics renderer (Rust) — required
bun run build:kitty-runtime

# CEF engine helper
CEF_ROOT=/path/to/cef_binary_... bun run build:cef
```

## Run

```bash
bun run src/main.ts https://youtube.com
```

Controls:

- `Ctrl-C` or `Ctrl-Q`: exit
- mouse left click: click page
- mouse wheel: scroll
- printable text / Enter / Backspace / Tab / arrows: forwarded to the page

`--debug` writes a log to `/tmp/kitty-webview-debug.log`
(override with `KITTY_WEBVIEW_DEBUG_LOG=`).

## Frame transport: deltas, not full frames

CEF computes a dirty rectangle per paint (pixel-diffed against the previous
frame, with an area threshold) and transmits only that rectangle. The first
frame is a full `a=T` transmit + place. With the default Rust renderer, later
updates are assembled in an off-screen animation frame: copy the complete
visible frame, apply the dirty rectangle, then select the completed frame inside
synchronized output. The two animation frames alternate, so users see either
the complete old state or the complete new state, never an in-place partial
update. The Kitty Graphics Protocol is implemented once, in Rust
(`native/kitty-runtime`); there is no second renderer.

The transport is **shm**: every frame (full frames and deltas alike) is
written to a single-use POSIX shared-memory object and handed to Kitty via
`t=s`, so pixels bypass the PTY entirely. Deltas go through the two-frame
staging pipeline described above (copy → apply dirty rect off-screen → atomic
select), never as an in-place edit of the visible frame. (An earlier
`direct`/`file` inline mode was removed: in-place `a=f` frame updates are
unreliable on some Kitty sessions, and the disk-backed `file` path broke the
disk-write-free goal.)

## Defaults baked into this build

These defaults are what makes the CEF + Rust combo flicker-free **and**
disk-write-free (the original motivation for #10090/#10092). Rendering is
Rust-only.

| Concern | Default | Why | Override |
|---|---|---|---|
| CEF frame transfer | **shm** (single-use POSIX shm, `t=s`) | every frame bypasses the PTY; deltas run through the two-frame staging pipeline for an atomic swap; disk-write-free | — (shm is the only transport) |
| Transient usage hint (`N=1`) | **ON** | tells kitty these frames are short-lived → skip the graphics disk cache (no per-frame SSD writes) | `KITTY_WEBVIEW_TRANSIENT_HINT=0` |

If you run against a kitty **without** usage-hints support, disable the
transient hint or frames will be silently dropped:

```bash
KITTY_WEBVIEW_TRANSIENT_HINT=0 bun run src/main.ts https://example.com
```

Other knobs: `KITTY_WEBVIEW_PIXEL_FORMAT` (`rgba` default; use `rgb` to
force the 24-bit path, which costs less bandwidth but triggers a CPU
RGB24→ARGB8 expansion on Apple Silicon),
`KITTY_WEBVIEW_PIXEL_DIFF` (on by default),
`KITTY_WEBVIEW_DIRTY_THRESHOLD_PERCENT` (`0` by default, so full frames are
sent; set `1`–`100` to opt into partial updates as a performance tradeoff), and
`KITTY_WEB_UI_CEF_DPR` (auto-detected through CoreGraphics from the display
containing the largest portion of the current Kitty window; set explicitly to
override detection).

## Layout

```
src/                 TypeScript app (main entry: src/main.ts)
native/kitty-runtime/  Rust Kitty graphics renderer
native/cef-core/       Rust CEF bridge (frame conversion + dirty-rect diffing)
native/cef-helper/     CEF helper app (C++); built into kitty-cef-helper.app
scripts/               build scripts
```
