import type { Config, InputEvent } from "./types";
import { debugLog, DEBUG_LOG_PATH } from "./debug";
import { dispatchInput } from "./input/dispatcher";
import { parseStream } from "./input/parser";
import { PerfStats } from "./perf";
import { createBrowserController } from "./browser";
import { KittyRenderer } from "./renderer";
import { FrameSource } from "./frame-source";
import type { InboundFrame } from "./frame-source";
import { FramePump } from "./scheduler";
import { TerminalController } from "./terminal";
import { ViewportMapper } from "./viewport";

export class App {
  constructor(private config: Config) {}

  async run() {
    const terminal = new TerminalController(this.config);
    const webview = createBrowserController(this.config);
    const renderer = new KittyRenderer(this.config);
    const viewport = new ViewportMapper(this.config);
    // Hybrid mode: paint/input/resize only marks the pump dirty.
    // Terminal updates are emitted on an absolute fixed-rate clock. This keeps
    // Kitty from receiving bursty paint trains when the offscreen paint
    // cadence is uneven.
    const pump = new FramePump(this.config.fps, "hybrid");
    const perf = new PerfStats();
    const frameSource = new FrameSource({
      ack: (seq) => { if (seq) webview.ackFrame?.(seq); },
      isBackpressured: () => renderer.isBackpressured(),
      onFrame: () => pump.request("external"),
      onDrop: (f, reason) => debugLog(this.config.debug, `[frame] drop ${reason} seq=${f.seq} ${f.width}x${f.height}`),
    });
    let loggedFirstFrame = false;
    let browserQueue = Promise.resolve();
    let resizeInProgress = false;
    let latestResize: import("./types").TerminalSize | null = null;
    let resizing = false;
    let dpr = 1;
    let lastMouseMove = "";
    let acceptingEvents = true;
    let pendingWheel: { x: number; y: number; deltaX: number; deltaY: number; modifiers?: import("./types").KeyModifiers } | null = null;
    let wheelFlushTimer: Timer | undefined;
    let resizeDebounceTimer: Timer | undefined;
    debugLog(this.config.debug, `[app] debug log path=${DEBUG_LOG_PATH}`);
    debugLog(this.config.debug, `[app] frame config fps=${this.config.fps} captureFps=${this.config.captureFps ?? this.config.fps} siteProfile=${this.config.siteProfile}`);

    const enqueueBrowserOperation = (name: string, fn: () => Promise<void>) => {
      browserQueue = browserQueue
        .then(() => fn())
        .catch((error) => {
          debugLog(this.config.debug, `[app] ${name} failed: ${String(error)}`);
        });
      return browserQueue;
    };

    const scheduleResize = () => {
      if (resizeDebounceTimer) {
        clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = undefined;
      }
      if (resizing) return;
      resizing = true;
      enqueueBrowserOperation("resize", async () => {
        resizeInProgress = true;
        try {
          while (latestResize) {
            const nextSize = latestResize;
            latestResize = null;
            renderer.clear();
            renderer.resetRawFile();
            frameSource.clear();
            const next = viewport.resize(nextSize, dpr);
            if (next.width > 0 && next.height > 0) {
              // Frame generation already rejects pre-resize paints. Do not
              // reject by dimensions here: HiDPI CEF builds may report either
              // DIP or backing-pixel OnPaint dimensions during scale changes.
              await webview.resize(next.width, next.height);
            }
          }
        } finally {
          resizing = false;
          resizeInProgress = false;
          pump.request("resize");
          if (latestResize && acceptingEvents) queueResize();
        }
      }).catch(() => {});
    };

    const queueResize = () => {
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      const delay = Math.max(0, this.config.resizeDebounceMs);
      if (delay === 0) {
        scheduleResize();
        return;
      }
      resizeDebounceTimer = setTimeout(() => {
        resizeDebounceTimer = undefined;
        scheduleResize();
      }, delay);
    };

    try {
      terminal.enter();
      dpr = await webview.devicePixelRatio();
      const initialTerminalSize = await terminal.currentSize();
      const initialBrowserSize = viewport.resize(initialTerminalSize, dpr);
      // Accept CEF's first OnPaint dimensions as authoritative. Depending on
      // CEF/macOS version this can transition from DIP to backing pixels after
      // screen info is applied; the Kitty placement scales either form.
      debugLog(this.config.debug, `[app] terminal=${JSON.stringify(initialTerminalSize)} dpr=${dpr} browser=${JSON.stringify(initialBrowserSize)} placement=${JSON.stringify(viewport.placement())}`);

      await webview.open(initialBrowserSize);
      await webview.applyPageZoom();

      // The helper emits each parsed frame via onRawFrame; FrameSource preserves
      // dependent deltas in order, applies staleness/backpressure policy, and
      // nudges the pump. The helper's one-in-flight ACK gate prevents backlog.
      const ctrl = webview as any;
      ctrl.onRawFrame = (f: InboundFrame) => frameSource.push(f);
      ctrl.onCursorChange = (cursor: import("./types").BrowserCursorShape) => {
        terminal.setPageCursorShape(cursor);
      };
      ctrl.onHitTest = (hit: import("./types").BrowserHitTest) => {
        terminal.setHitTest(hit);
      };

      pump.onRender(async () => {
        if (resizeInProgress) return;

        const frameStart = performance.now();
        const screenshotStart = performance.now();
        const frame = frameSource.next();
        perf.screenshotMs = performance.now() - screenshotStart;
        if (!frame) return;

        if (this.config.debug && !loggedFirstFrame) {
          loggedFirstFrame = true;
          debugLog(this.config.debug, `[app] draw first frame format=${frame.format} placement=${JSON.stringify(viewport.placement())}`);
        }

        const place = viewport.placement();
        if (this.config.debug && (Math.abs((frame.width || 0) - place.pixelWidth) > 2 || Math.abs((frame.height || 0) - place.pixelHeight) > 2)) {
          debugLog(true, `[app] raw source/destination mismatch source=${frame.width}x${frame.height} dest=${place.pixelWidth}x${place.pixelHeight} placement=${JSON.stringify(place)}`);
        }
        const drawStart = performance.now();
        await renderer.draw(frame, place);
        // Deltas are relative to the previously delivered frame. Release the
        // helper only after Kitty has accepted this frame's complete write.
        frameSource.complete(frame.seq);

        perf.drawMs = performance.now() - drawStart;
        perf.frameMs = performance.now() - frameStart;

        // Cursor state is refreshed by cursor/hit-test/pointer events. Rewriting
        // cursor CSI controls after every video frame makes Kitty repaint its
        // cursor overlay at the capture frame rate and causes visible flicker.
        perf.sampleFrame();
      });

      const flushWheel = () => {
        if (wheelFlushTimer) {
          clearTimeout(wheelFlushTimer);
          wheelFlushTimer = undefined;
        }
        const wheel = pendingWheel;
        pendingWheel = null;
        if (!wheel) return;
        enqueueBrowserOperation("wheel dispatch", async () => {
          await webview.wheel(wheel.x, wheel.y, wheel.deltaX, wheel.deltaY, wheel.modifiers);
          pump.request("input");
        });
      };

      const updatePointerCursorPosition = (event: Extract<InputEvent, { type: "mouse" }>) => {
        const cell = this.config.mouseMode === "sgr-pixel"
          ? viewport.terminalPixelToCell(event.col, event.row)
          : { col: event.col, row: event.row };
        terminal.setPointerCursorPosition(cell.col, cell.row);
      };

      const queueWheel = (event: Extract<InputEvent, { type: "mouse" }> & { action: "wheel" }) => {
        updatePointerCursorPosition(event);
        const { x, y } = viewport.terminalPixelToBrowserPixel(event.col, event.row);
        const deltaX = event.deltaX ?? 0;
        const deltaY = event.deltaY ?? 0;
        if (!pendingWheel) {
          pendingWheel = { x, y, deltaX, deltaY, modifiers: event.modifiers };
        } else {
          pendingWheel.x = x;
          pendingWheel.y = y;
          pendingWheel.deltaX += deltaX;
          pendingWheel.deltaY += deltaY;
          pendingWheel.modifiers = event.modifiers ?? pendingWheel.modifiers;
        }

        if (this.config.scrollCoalesceMs === 0) {
          flushWheel();
          return;
        }

        if (!wheelFlushTimer) {
          wheelFlushTimer = setTimeout(flushWheel, this.config.scrollCoalesceMs);
        }
      };

      // Streaming input buffer. 1 MB cap prevents unbounded growth from
      // malformed escape sequences or unterminated bracketed paste.
      const INPUT_BUF_MAX = 1_048_576;
      let inputBuf = Buffer.alloc(0);
      terminal.onInput((bytes) => {
        if (process.env.KITTY_WEB_UI_INPUT_DEBUG === "1") {
          debugLog(
            true,
            `[input:raw] len=${bytes.length} hex=${bytes.toString("hex")} text=${JSON.stringify(bytes.toString("utf8"))}`,
          );
        }

        if (!acceptingEvents) return;
        if (inputBuf.length + bytes.length > INPUT_BUF_MAX) {
          // Discard and reset to prevent DoS via runaway buffer growth.
          inputBuf = Buffer.alloc(0);
          return;
        }
        inputBuf = Buffer.concat([inputBuf, bytes]);
        let ev;
        while ((ev = parseStream(inputBuf)) !== null) {
          inputBuf = inputBuf.subarray(ev.consumed);
          const event = ev.event;
          if (process.env.KITTY_WEB_UI_INPUT_DEBUG === "1") {
            debugLog(true, `[input:parsed] consumed=${ev.consumed} event=${JSON.stringify(event)}`);
          }

          if (event.type === "exit" || isQuitEvent(event, this.config.quitKeys)) {
            terminal.requestExit();
            return;
          }
          if (event.type === "mouse") updatePointerCursorPosition(event);
          if (event.type === "mouse" && event.action === "wheel") {
            lastMouseMove = "";
            queueWheel(event as InputEvent & { type: "mouse"; action: "wheel" });
            continue;
          }

          // Preserve input ordering: a click/key after wheel must not overtake
          // the coalesced wheel event that is waiting for its short flush timer.
          flushWheel();

          if (event.type === "mouse" && event.action === "move") {
            const moveKey = `${event.col}:${event.row}:${event.button ?? "none"}`;
            if (moveKey === lastMouseMove) continue;
            lastMouseMove = moveKey;
          } else {
            lastMouseMove = "";
          }
          enqueueBrowserOperation("input dispatch", async () => {
            await dispatchInput(event, webview, viewport, true);
            pump.request("input");
          });
        }
      });

      terminal.onResize((size) => {
        if (!acceptingEvents) return;
        latestResize = size;
        queueResize();
      });

      pump.start();
      pump.request("start");

      if (this.config.debug) {
        const debugInterval = setInterval(() => debugLog(true, `[perf] ${perf.line()}`), 1000);
        try {
          await terminal.wait();
        } finally {
          clearInterval(debugInterval);
        }
      } else {
        await terminal.wait();
      }
    } finally {
      acceptingEvents = false;
      if (wheelFlushTimer) clearTimeout(wheelFlushTimer);
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      pump.stop();
      try {
        await drainQueue(browserQueue, this.config.debug, "browser");
        await webview.close();
      } finally {
        renderer.dispose();
        terminal.leave();
      }
    }
  }
}

async function drainQueue(queue: Promise<void>, debug: boolean, name: string) {
  const drained = await Promise.race([queue.then(() => true, () => true), Bun.sleep(500).then(() => false)]);
  if (!drained) debugLog(debug, `[app] ${name} queue did not drain before shutdown`);
}


function isQuitEvent(event: import("./types").InputEvent, quitKeys: string[]) {
  if (event.type !== "key") return false;
  const mods = event.modifiers || {};
  const combo = [
    mods.ctrl ? "ctrl" : "",
    mods.alt ? "alt" : "",
    mods.meta ? "meta" : "",
    mods.shift ? "shift" : "",
    event.key.toLowerCase(),
  ].filter(Boolean).join("-");
  return quitKeys.map((k) => k.toLowerCase()).includes(combo);
}
