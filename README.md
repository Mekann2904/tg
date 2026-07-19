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
- Rust toolchain (for the native Kitty renderer): `cargo`.
- A CEF binary distribution (`CEF_ROOT`) and a C++ toolchain.

## Setup

```bash
bun install

# Native Kitty renderer (Rust) — required for --kitty-renderer=rust
bun run build:kitty-runtime

# CEF engine helper
CEF_ROOT=/path/to/cef_binary_... bun run build:cef
```

## Run

```bash
# CEF + Rust renderer (the tuned combo)
bun run src/main.ts https://youtube.com --kitty-renderer=rust

# CEF + TypeScript renderer (no native build needed beyond the CEF helper)
bun run src/main.ts https://example.com --kitty-renderer=ts
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
update. The TypeScript fallback retains the older in-place update path.

The transport is chosen **per frame** from the dirty-rect size:

- small deltas → `direct` (inline base64, memory-only — no shm object, no disk);
- large deltas and full frames → `shm` (pixels bypass the PTY entirely, so video
  and full repaints never congest the pipe).

The standard CEF + Rust configuration uses shm and the two-frame staging
pipeline. Forced direct mode and the TypeScript renderer remain compatibility
paths and do not provide the same atomic visible-frame guarantee.

## Defaults baked into this build

These defaults are what makes the CEF + Rust combo flicker-free **and**
disk-write-free (the original motivation for #10090/#10092):

| Concern | Default | Why | Override |
|---|---|---|---|
| CEF frame transfer | **adaptive**: small deltas `direct`, large/full `shm` | `direct` for small UI/cursor deltas is memory-only and needs no shm object; `shm` for video/full frames avoids PTY congestion (full-frame `direct` flickers on some kitty sessions) | `KITTY_WEBVIEW_TRANSFER=shm\|file\|direct` (force one), `KITTY_WEBVIEW_DIRECT_THRESHOLD_BYTES` (default 384 KiB) |
| Transient usage hint (`N=1`) | **ON** | tells kitty these frames are short-lived → skip the graphics disk cache (no per-frame SSD writes) | `KITTY_WEBVIEW_TRANSIENT_HINT=0` |

If you run against a kitty **without** usage-hints support, disable the
transient hint or frames will be silently dropped:

```bash
KITTY_WEBVIEW_TRANSIENT_HINT=0 bun run src/main.ts https://example.com
```

Other knobs: `KITTY_WEBVIEW_PIXEL_FORMAT` (`rgb` default),
`KITTY_WEBVIEW_PIXEL_DIFF` (on by default).

## Layout

```
src/                 TypeScript app (main entry: src/main.ts)
native/kitty-runtime/  Rust Kitty graphics renderer
native/cef-core/       Rust CEF bridge (frame conversion + dirty-rect diffing)
native/cef-helper/     CEF helper app (C++); built into kitty-cef-helper.app
scripts/               build scripts
```
