import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { BrowserCursorShape, BrowserHitTest, BrowserSize, Config, KeyModifiers, MouseButton } from "./types";
import type { InboundFrame } from "./frame-source";
import { debugLog, writeDebugBytes } from "./debug";

export interface HelperSpawnContext {
  url: string;
  captureFps: number;
  dpr: number;
  pageZoom: number;
  frameNonce: string;
  allowHttp: boolean;
  persist: boolean;
  debug: boolean;
  userAgent: string;
  siteProfile: string;
  width: number;
  height: number;
}

export interface HelperSpawnSpec {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

export interface HelperProcessBrowserOptions {
  kind: string;
  dprEnvName: string;
  spawn: (ctx: HelperSpawnContext) => HelperSpawnSpec;
}

export class HelperProcessBrowserController {
  private proc?: ChildProcess;
  private sock?: Socket;
  private frameWidth = 0;
  private frameHeight = 0;
  private frameStride = 0;
  private expectedFrameWidth = 0;
  private expectedFrameHeight = 0;
  private expectedFrameGeneration = 0;
  private dpr: number;
  private lastPressedButton: MouseButton | null = null;
  private lastClick: { x: number; y: number; button: MouseButton; at: number; count: number } | null = null;
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private semanticEventCount = 0;
  private lastSemanticSummaryAt = 0;
  private accessibilityEventCount = 0;
  private lastAckedSeq = 0;
  private lastAccessibilitySummaryAt = 0;
  private headerParseErrorCount = 0;
  onRawFrame?: (frame: InboundFrame) => void;
  onCursorChange?: (cursor: BrowserCursorShape) => void;
  onHitTest?: (hit: BrowserHitTest) => void;

  constructor(private config: Config, private options: HelperProcessBrowserOptions) {
    this.dpr = this.resolveDpr();
  }

  private get logPrefix() {
    return `[${this.options.kind}-ctrl]`;
  }

  private log(message: string) {
    debugLog(this.config.debug, message);
  }

  private resolveDpr(): number {
    const env = Number(process.env[this.options.dprEnvName] || "");
    if (Number.isFinite(env) && env > 0 && env <= 4) return env;
    // The offscreen browser CSS size is already set to the terminal's physical
    // pixel size. Returning 2 on Retina would produce a 2x oversized bitmap,
    // quadrupling bytes/frame and forcing Kitty to downscale it.
    return 1;
  }

  async open(initialSize?: BrowserSize) {
    const url = this.config.url || "https://example.com";
    // Nonce for TCP frame authentication: first message after connect must
    // match this value, then the server closes to new connections.
    const frameNonce = randomBytes(32).toString("hex");
    const allowHttp = !!this.config.allowHttp;
    const captureFps = this.config.captureFps ?? this.config.fps;
    const width = initialSize?.width || 1280;
    const height = initialSize?.height || 800;
    this.expectedFrameWidth = width;
    this.expectedFrameHeight = height;
    this.expectedFrameGeneration = 0;
    const spec = this.options.spawn({ 
      url,
      captureFps,
      dpr: this.dpr,
      pageZoom: this.config.pageZoom,
      frameNonce,
      allowHttp,
      persist: !!this.config.persist,
      debug: !!this.config.debug,
      userAgent: this.config.userAgent || "",
      siteProfile: this.config.siteProfile,
      width,
      height,
    });

    let portBuf = "";
    const inheritNativeStderr = process.env.KITTY_WEB_UI_NATIVE_STDERR === "inherit";
    this.proc = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", inheritNativeStderr ? "inherit" : "pipe"],
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
    });
    this.proc.stderr?.on("data", (d: Buffer) => {
      // Never write native stderr to the active alt-screen. It corrupts the
      // Kitty image surface. Route through the configured debug sink instead.
      writeDebugBytes(this.config.debug, d);
    });

    // Read port number from stdout.
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("port timeout")), 10000);
      this.proc!.stdout!.on("data", (chunk: Buffer) => {
        portBuf += chunk.toString("utf8");
        const nl = portBuf.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(timer);
          resolve(parseInt(portBuf.substring(0, nl)));
        }
      });
      this.proc!.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`${this.options.kind} exited code=${code}`));
      });
      this.proc!.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    this.log(`${this.logPrefix} connecting TCP localhost:${port}`);
    this.sock = connect({ host: "127.0.0.1", port });
    this.sock.on("connect", () => {
      this.log(`${this.logPrefix} TCP connected`);
      this.sock!.write(frameNonce + "\n");
    });
    this.sock.on("data", (chunk: Buffer) => this.onData(chunk));
    this.sock.on("error", (e) => this.log(`${this.logPrefix} socket error: ${e.message}`));

    // Do not wait for a first 1280x800 paint here. App startup computes the
    // terminal-sized viewport and sends it immediately; waiting for an initial
    // frame before resize is the main source of stale first-frame drops.
    this.log(`${this.logPrefix} frame stream starting expected=${width}x${height}`);
  }

  private send(cmd: Record<string, unknown>) {
    const data = Buffer.from(JSON.stringify(cmd), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(data.length, 0);
    this.proc?.stdin?.write(Buffer.concat([len, data]));
  }

  ackFrame(seq: number) {
    if (!Number.isFinite(seq) || seq <= 0 || seq <= this.lastAckedSeq) return;
    this.lastAckedSeq = seq;
    this.send({ type: "frameAck", seq });
  }

  async click(x: number, y: number) {
    const px = Math.round(x);
    const py = Math.round(y);
    const clickCount = this.nextClickCount(px, py, "left");
    this.send({ type: "click", x: px, y: py, button: "left", clickCount });
  }

  async mouseDown(x: number, y: number, button: MouseButton, modifiers?: KeyModifiers) {
    const px = Math.round(x);
    const py = Math.round(y);
    const normalizedButton = button === "none" ? "left" : button;
    this.lastPressedButton = normalizedButton;
    this.send({
      type: "mouseDown",
      x: px,
      y: py,
      button: normalizedButton,
      modifiers,
      clickCount: this.nextClickCount(px, py, normalizedButton),
    });
  }

  async mouseUp(x: number, y: number, button: MouseButton, modifiers?: KeyModifiers) {
    const normalizedButton = button === "none" ? this.lastPressedButton ?? "left" : button;
    this.send({
      type: "mouseUp",
      x: Math.round(x),
      y: Math.round(y),
      button: normalizedButton,
      modifiers,
      clickCount: this.lastClick?.button === normalizedButton ? this.lastClick.count : 1,
    });
    if (this.lastPressedButton === normalizedButton) this.lastPressedButton = null;
  }

  async mouseMove(x: number, y: number, button?: MouseButton, modifiers?: KeyModifiers) {
    this.send({
      type: "mouseMove",
      x: Math.round(x),
      y: Math.round(y),
      button: button ?? this.lastPressedButton ?? "none",
      modifiers,
    });
  }

  async wheel(x: number, y: number, deltaX: number, deltaY: number, modifiers?: KeyModifiers) {
    this.send({ type: "wheel", x: Math.round(x), y: Math.round(y), deltaX, deltaY, modifiers });
  }
  async type(text: string) { this.send({ type: "text", text }); }
  async press(key: string, modifiers?: KeyModifiers) { this.send({ type: "key", key, modifiers }); }
  async scroll(dx: number, dy: number) {
    // Wheel target: center of the viewport in CSS pixels.
    // frameWidth/Height already equals browser CSS size (terminal physical pixels).
    await this.wheel(Math.round(this.frameWidth / 2), Math.round(this.frameHeight / 2), dx, dy);
  }

  private nextClickCount(x: number, y: number, button: MouseButton): number {
    const now = performance.now();
    const previous = this.lastClick;
    const sameTarget =
      previous &&
      previous.button === button &&
      now - previous.at <= 500 &&
      Math.abs(previous.x - x) <= 4 &&
      Math.abs(previous.y - y) <= 4;
    const count = sameTarget ? Math.min(previous.count + 1, 3) : 1;
    this.lastClick = { x, y, button, at: now, count };
    return count;
  }

  async devicePixelRatio(): Promise<number> { return this.dpr; }
  async applyPageZoom() {}
  async resize(width: number, height: number) {
    const nextWidth = Math.round(width);
    const nextHeight = Math.round(height);
    if (nextWidth !== this.expectedFrameWidth || nextHeight !== this.expectedFrameHeight) {
      this.expectedFrameWidth = nextWidth;
      this.expectedFrameHeight = nextHeight;
      this.expectedFrameGeneration++;
    }
    this.send({ type: "resize", width: nextWidth, height: nextHeight });
  }

  async close() {
    try { this.send({ type: "stop" }); } catch {}
    this.sock?.destroy();
    this.proc?.kill();
  }

  private onData(chunk: Buffer) {
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;

    // State-machine parser: preserve every complete frame in stream order.
    // Dirty frames depend on their predecessor, so newest-only sampling here
    // would permanently lose changed regions. Avoid Buffer.concat(): raw frames
    // can be several MB and repeated concatenation creates excessive copying.
    const completeFrames: { hdr: any }[] = [];

    while (this.bufferedBytes >= 4) {
      const hdrLenBuf = this.peekBytes(4);
      if (!hdrLenBuf) break;

      const hdrLen = hdrLenBuf.readUInt32LE(0);

      // Header should be small JSON. If this is absurd, assume stream corruption
      // and skip one byte to try to resync.
      if (hdrLen <= 0 || hdrLen > 1_048_576) {
        this.skipBytes(1);
        continue;
      }

      const headerEnd = 4 + hdrLen;
      if (this.bufferedBytes < headerEnd) break;

      const hdrData = this.peekBytes(hdrLen, 4);
      if (!hdrData) break;

      let hdr: any;
      try {
        hdr = JSON.parse(hdrData.toString("utf8"));
      } catch {
        this.headerParseErrorCount++;
        if (this.config.debug && (this.headerParseErrorCount <= 5 || this.headerParseErrorCount % 100 === 0)) {
          this.log(
            `${this.logPrefix} invalid frame header count=${this.headerParseErrorCount} header=${JSON.stringify(hdrData.toString("utf8").slice(0, 200))}`,
          );
        }
        this.skipBytes(1);
        continue;
      }

      if (hdr.type === "cursor") {
        this.skipBytes(headerEnd);
        this.onCursorChange?.(normalizeCursorShape(hdr.cursor));
        continue;
      }

      if (hdr.type === "hitTest") {
        this.skipBytes(headerEnd);
        this.onHitTest?.(normalizeHitTest(hdr));
        if (typeof hdr.cursor === "string") this.onCursorChange?.(normalizeCursorShape(hdr.cursor));
        continue;
      }

      if (hdr.type === "messageRouter") {
        this.skipBytes(headerEnd);
        this.onMessageRouterEvent(hdr);
        continue;
      }

      if (hdr.type === "accessibility") {
        this.skipBytes(headerEnd);
        this.onAccessibilityEvent(hdr);
        continue;
      }

      if (hdr.type === "frameFile" && typeof hdr.byteLength === "number" && typeof hdr.path === "string") {
        // File-transfer frames contain only a length-prefixed JSON header; the
        // raw pixels live in the path named by hdr.path. Do not wait for the
        // following 4-byte payload length used by inline "frame" messages.
        // Waiting for those bytes makes every file frame one message late and
        // a static first paint can time out until another paint/resize arrives.
        this.skipBytes(headerEnd);
        completeFrames.push({ hdr });
        continue;
      }

      // Unrecognized header-only message type; skip and resync.
      this.skipBytes(headerEnd);
    }

    for (const { hdr } of completeFrames) {
      const generation = Number(hdr.generation) || 0;
      if (generation !== this.expectedFrameGeneration) {
        const seq = Number(hdr.seq) || undefined;
        this.log(
          `${this.logPrefix} discard stale generation seq=${seq ?? "?"} frame=${generation} expected=${this.expectedFrameGeneration} ${hdr.width}x${hdr.height}`,
        );
        if (seq) this.ackFrame(seq);
        continue;
      }

      this.frameWidth = hdr.width;
      this.frameHeight = hdr.height;
      this.frameStride = hdr.stride || hdr.width * (hdr.format === "rgb" ? 3 : 4);
      const format = hdr.format === "rgb" ? "rgb" : "rgba";

      const frame: InboundFrame = {
        seq: Number(hdr.seq) || undefined,
        path: hdr.path,
        byteLength: hdr.byteLength,
        width: this.frameWidth,
        height: this.frameHeight,
        format,
        dirty: hdr.dirty,
      };

      if (hdr.seq <= 2) {
        this.log(`${this.logPrefix} frame ${hdr.seq} ${hdr.width}x${hdr.height} dpr=${this.dpr}`);
      }

      this.onRawFrame?.(frame);
    }
  }

  private onMessageRouterEvent(hdr: any) {
    this.semanticEventCount++;

    const payload = hdr?.payload;
    const semantic = payload?.type === "semantic" ? payload : undefined;
    const kind = semantic?.kind ?? hdr?.kind ?? "unknown";

    // selectionchange/input can be very noisy. Keep detailed logs opt-in.
    if (process.env.KITTY_WEB_UI_SEMANTIC_DEBUG === "1") {
      this.log(`${this.logPrefix} semantic ${JSON.stringify(payload ?? hdr)}`);
      return;
    }

    const important =
      kind === "bridge-installed" ||
      kind === "focusin" ||
      kind === "focusout" ||
      kind === "compositionstart" ||
      kind === "compositionend";

    if (important) {
      this.log(`${this.logPrefix} semantic kind=${kind} payload=${JSON.stringify(payload)}`);
      return;
    }

    const now = performance.now();
    if (now - this.lastSemanticSummaryAt > 1000) {
      this.lastSemanticSummaryAt = now;
      this.log(`${this.logPrefix} semantic events=${this.semanticEventCount} lastKind=${kind}`);
    }
  }

  private onAccessibilityEvent(hdr: any) {
    this.accessibilityEventCount++;

    if (process.env.KITTY_WEB_UI_ACCESSIBILITY_DEBUG === "1") {
      this.log(`${this.logPrefix} accessibility ${JSON.stringify(hdr)}`);
      return;
    }

    if (hdr.kind === "summary") {
      this.log(
        `${this.logPrefix} accessibility summary tree=${hdr.treeEvents ?? 0} location=${hdr.locationEvents ?? 0}`,
      );
      return;
    }

    const now = performance.now();
    if (now - this.lastAccessibilitySummaryAt > 1000) {
      this.lastAccessibilitySummaryAt = now;
      this.log(
        `${this.logPrefix} accessibility events=${this.accessibilityEventCount} lastKind=${hdr.kind ?? "unknown"}`,
      );
    }
  }

  private peekBytes(length: number, offset = 0): Buffer | null {
    if (this.bufferedBytes < offset + length) return null;

    const out = Buffer.allocUnsafe(length);
    let copied = 0;
    let skipped = 0;

    for (const chunk of this.chunks) {
      if (skipped + chunk.length <= offset) {
        skipped += chunk.length;
        continue;
      }

      const start = Math.max(0, offset - skipped);
      const available = chunk.length - start;
      const take = Math.min(available, length - copied);

      chunk.copy(out, copied, start, start + take);

      copied += take;
      skipped += chunk.length;

      if (copied === length) return out;
    }

    return null;
  }

  private skipBytes(length: number) {
    let remaining = length;

    while (remaining > 0 && this.chunks.length > 0) {
      const first = this.chunks[0];

      if (first.length <= remaining) {
        this.chunks.shift();
        this.bufferedBytes -= first.length;
        remaining -= first.length;
      } else {
        this.chunks[0] = first.subarray(remaining);
        this.bufferedBytes -= remaining;
        remaining = 0;
      }
    }
  }

}

function normalizeCursorShape(value: unknown): BrowserCursorShape {
  return value === "text" || value === "pointer" || value === "crosshair" || value === "grab" || value === "grabbing" || value === "none"
    ? value
    : "default";
}

function normalizeHitTest(value: any): BrowserHitTest {
  return {
    x: Number.isFinite(Number(value?.x)) ? Number(value.x) : 0,
    y: Number.isFinite(Number(value?.y)) ? Number(value.y) : 0,
    cursor: normalizeCursorShape(value?.cursor),
    editable: !!value?.editable,
    clickable: !!value?.clickable,
    selectable: !!value?.selectable,
    tag: typeof value?.tag === "string" ? value.tag : undefined,
    role: typeof value?.role === "string" ? value.role : undefined,
    type: typeof value?.inputType === "string" ? value.inputType : undefined,
    label: typeof value?.label === "string" ? value.label : undefined,
  };
}
