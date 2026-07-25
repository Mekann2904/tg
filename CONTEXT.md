# kitty-web-ui

CEF offscreen browser engine that renders web pages inside the Kitty terminal
via the Kitty Graphics Protocol.

## Language

**Kitty offscreen**: The only display mode. A CEF offscreen host captures web
page bitmaps, which are rendered in the terminal using Kitty Graphics Protocol
(f=32 raw RGBA, or f=24 RGB).

**CEF host window**: The offscreen CEF client that loads and renders the remote
web page. Its size matches the terminal's physical pixel dimensions for 1:1
sharp rendering on Retina displays.

**Placement**: The terminal cell region where the page bitmap is drawn. Defined by xCell, yCell, cols, rows, pixelWidth, pixelHeight. Input coordinates are converted from terminal cells/pixels to browser CSS pixels using this placement.

_Avoid_: Viewport, display area

**Dangerous scheme**: A URL scheme blocked at the navigation level: `file:`, `javascript:`, `data:`, `devtools:`, `chrome:`, `chrome-extension:`. Only `https:` and `http:` are allowed.

_Avoid_: Unsafe protocol, blocked origin

**Sandbox**: CEF/Chromium's renderer sandbox. Always enabled for remote content.

**FramePump**: The render loop scheduler that drives frame capture from CEF and Kitty Graphics Protocol output. Operates in hybrid mode (fixed-rate terminal updates driven by paint/input/resize dirty flags).

**Dirty rect / frame delta**: The rectangle of pixels that changed since the previous frame. It is an opt-in performance mode controlled by `KITTY_WEBVIEW_DIRTY_THRESHOLD_PERCENT`; full frames are the default because partial Kitty animation-frame updates can briefly corrupt rectangular regions.

## Example dialogue

> **Dev**: 危険スキームの `javascript:` でナビゲートしようとしたら？
>
> **Domain expert**: will-navigate 相当のフックでブロックする。http/https 以外は一切通さない。
