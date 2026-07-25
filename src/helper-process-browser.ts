import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { BrowserCursorShape, BrowserHitTest, BrowserSize, Config, DirtyRect, KeyModifiers, MouseButton, PixelFormat } from "./types";
import type { InboundFrame } from "./frame-source";
import { debugLog, writeDebugBytes } from "./debug";
import { resolveSystemDpr } from "./system-dpr";

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

// Headers are small JSON (frame metadata, cursor, hit-test), well under 1 KiB.
// Cap at 64 KiB so a corrupted length prefix fails fast instead of allocating.
const MAX_HEADER_BYTES = 65_536;

// Inbound helper messages. The C++ helper owns this shape (main.cc emits these
// via SendHeader); a deviation is a fatal contract violation, not line noise.
type InboundFrameFileHeader = {
  type: "frameFile";
  seq?: number;
  generation?: number;
  width: number;
  height: number;
  format?: PixelFormat;
  byteLength: number;
  path: string;
  dirty?: DirtyRect;
};
type InboundCursorHeader = { type: "cursor"; cursor?: string };
type InboundHitTestHeader = {
  type: "hitTest";
  x?: number;
  y?: number;
  cursor?: string;
  editable?: boolean;
  clickable?: boolean;
  selectable?: boolean;
  tag?: string;
  role?: string;
  inputType?: string;
  label?: string;
};
type InboundHeader = InboundFrameFileHeader | InboundCursorHeader | InboundHitTestHeader;

export class HelperProcessBrowserController {
  private proc?: ChildProcess;
  private sock?: Socket;
  private buf = Buffer.alloc(0);
  private dead = false;
  private expectedFrameWidth = 0;
  private expectedFrameHeight = 0;
  private expectedFrameGeneration = 0;
  private dpr: number;
  private lastPressedButton: MouseButton | null = null;
  private lastClick: { x: number; y: number; button: MouseButton; at: number; count: number } | null = null;
  private lastAckedSeq = 0;
  onRawFrame?: (frame: InboundFrame) => void;
  onCursorChange?: (cursor: BrowserCursorShape) => void;
  onHitTest?: (hit: BrowserHitTest) => void;
  /** Fatal controller error (socket/proc/parse). App wires this to a clean shutdown. */
  onFatal?: (error: Error) => void;

  constructor(private config: Config, private options: HelperProcessBrowserOptions) {
    this.dpr = this.resolveDpr();
  }

  private get logPrefix() {
    return `[${this.options.kind}-ctrl]`;
  }

  private log(message: string) {
    debugLog(this.config.debug, message);
  }

  /** Unrecoverable controller error (socket/proc/parse). Logged once, socket
   *  torn down, then onFatal fires so the app can shut down via its existing
   *  finally block. Never throw from a socket/proc handler — it bypasses cleanup. */
  private fatal(message: string) {
    if (this.dead) return;
    this.dead = true;
    debugLog(true, `${this.logPrefix} ${message}`);
    this.sock?.destroy();
    this.onFatal?.(new Error(`${this.logPrefix} ${message}`));
  }

  private resolveDpr(): number {
    return resolveSystemDpr(process.env[this.options.dprEnvName]);
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
    this.expectedFrameWidth = Math.round(width * this.dpr);
    this.expectedFrameHeight = Math.round(height * this.dpr);
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

    // After the port handshake, a helper exit is fatal to the session. The
    // handshake listener above still fires but its reject() is a no-op now.
    this.proc.on("exit", (code) => this.fatal(`${this.options.kind} exited code=${code}`));

    this.log(`${this.logPrefix} connecting TCP localhost:${port}`);
    this.sock = connect({ host: "127.0.0.1", port });
    this.sock.on("connect", () => {
      this.log(`${this.logPrefix} TCP connected`);
      this.sock!.write(frameNonce + "\n");
    });
    this.sock.on("data", (chunk: Buffer) => this.onData(chunk));
    this.sock.on("error", (e) => this.fatal(`socket error: ${e.message}`));

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
    const nextFrameWidth = Math.round(nextWidth * this.dpr);
    const nextFrameHeight = Math.round(nextHeight * this.dpr);
    if (nextFrameWidth !== this.expectedFrameWidth || nextFrameHeight !== this.expectedFrameHeight) {
      this.expectedFrameWidth = nextFrameWidth;
      this.expectedFrameHeight = nextFrameHeight;
      this.expectedFrameGeneration++;
    }
    this.send({ type: "resize", width: nextWidth, height: nextHeight });
  }

  async close() {
    try { this.send({ type: "stop" }); } catch {}
    this.sock?.destroy();
    this.proc?.kill();
  }

  // Length-prefixed JSON header stream. Every message (frame metadata, cursor,
  // hit-test) is a small header; pixels travel out-of-band via shm, referenced
  // by hdr.path. Dirty frames depend on their predecessor, so headers are
  // handled in arrival order. Same framing pattern as KittyRenderer.
  private onData(chunk: Buffer) {
    if (this.dead) return;
    this.buf = Buffer.concat([this.buf, chunk]);

    while (this.buf.length >= 4) {
      const hdrLen = this.buf.readUInt32LE(0);
      // The helper is a trusted localhost+nonce peer, so a malformed length or
      // JSON body is a contract violation, not line noise — fail fast rather
      // than byte-resync (which only produces a misaligned garbage stream).
      if (hdrLen <= 0 || hdrLen > MAX_HEADER_BYTES) {
        this.fatal(`invalid frame length ${hdrLen}`);
        return;
      }
      if (this.buf.length < 4 + hdrLen) break;

      const hdrBytes = this.buf.subarray(4, 4 + hdrLen);
      let hdr: InboundHeader;
      try {
        hdr = JSON.parse(hdrBytes.toString("utf8")) as InboundHeader;
      } catch (e) {
        this.fatal(`invalid frame header: ${(e as Error).message}`);
        return;
      }
      this.buf = this.buf.subarray(4 + hdrLen);
      this.dispatchHeader(hdr);
    }
  }

  // Bytes are consumed in onData before dispatch; unknown types are ignored.
  private dispatchHeader(hdr: InboundHeader) {
    switch (hdr.type) {
      case "cursor":
        this.onCursorChange?.(normalizeCursorShape(hdr.cursor));
        break;
      case "hitTest":
        this.onHitTest?.(normalizeHitTest(hdr));
        if (typeof hdr.cursor === "string") this.onCursorChange?.(normalizeCursorShape(hdr.cursor));
        break;
      case "frameFile":
        this.dispatchFrameFile(hdr);
        break;
      default:
        break;
    }
  }

  private dispatchFrameFile(hdr: InboundFrameFileHeader) {
    const generation = Number(hdr.generation) || 0;
    const seq = Number(hdr.seq) || undefined;

    if (generation !== this.expectedFrameGeneration) {
      this.log(
        `${this.logPrefix} discard stale generation seq=${seq ?? "?"} frame=${generation} expected=${this.expectedFrameGeneration} ${hdr.width}x${hdr.height}`,
      );
      if (seq) this.ackFrame(seq);
      return;
    }

    if (seq !== undefined && seq <= 2) {
      this.log(`${this.logPrefix} frame ${seq} ${hdr.width}x${hdr.height} dpr=${this.dpr}`);
    }

    this.onRawFrame?.({
      seq,
      path: hdr.path,
      byteLength: hdr.byteLength,
      width: hdr.width,
      height: hdr.height,
      format: hdr.format === "rgb" ? "rgb" : "rgba",
      dirty: hdr.dirty,
    });
  }
}

function normalizeCursorShape(value: unknown): BrowserCursorShape {
  return value === "text" || value === "pointer" || value === "crosshair" || value === "grab" || value === "grabbing" || value === "none"
    ? value
    : "default";
}

function optNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeHitTest(value: InboundHitTestHeader): BrowserHitTest {
  return {
    x: optNumber(value.x),
    y: optNumber(value.y),
    cursor: normalizeCursorShape(value.cursor),
    editable: !!value.editable,
    clickable: !!value.clickable,
    selectable: !!value.selectable,
    tag: optString(value.tag),
    role: optString(value.role),
    type: optString(value.inputType),
    label: optString(value.label),
  };
}
