import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, ftruncateSync, mkdtempSync, openSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Placement, RGBAFrame, ScreenshotFrame } from "./types";
import { debugLog } from "./debug";

const RAW_RETIRE_DELAY_MS = Number(process.env.KITTY_WEBVIEW_RAW_RETIRE_MS || 10_000);

export class KittyRenderer {
  private lastPlace?: Placement;

  // f=32 raw RGBA via temporary files in a 0700 private subdirectory to
  // prevent other users from reading raw frame data via predictable /tmp paths.
  private readonly _rawSlotCount = rawSlotCount();
  // Graphics protocol usage hint "transient" (N=1, PR kovidgoyal/kitty#10092):
  // tells kitty these frames are short-lived so it may skip the graphics disk
  // cache under the high-frequency browser workload this app produces. Default
  // ON for this build; disable with KITTY_WEBVIEW_TRANSIENT_HINT=0. Older kitty
  // rejects the unknown N key and drops the command, so it needs usage-hints
  // support (PR kovidgoyal/kitty#10092).
  private readonly _transientHint = transientHintEnabled();
  private readonly _displayImageId = 200;
  private readonly _placementId = 1;
  private readonly _rootFrame = 1;
  private readonly _deltaFrame = 2;
  // Older revisions rotated image ids 200..215.  Keep this list only for
  // startup/cleanup so stale placements from a previous crash are removed.
  private readonly _cleanupImageIds = Array.from({ length: 16 }, (_, i) => 200 + i);
  private _rawFileIndex = 0;
  private _rawDir: string | undefined;
  private _rawPaths: string[] = [];
  private _pathBase64Cache = new Map<string, string>();
  private _rawSlotSize = 0;
  // Never truncate a file after it has been exposed to kitty. On macOS kitty can
  // mmap() file-transfer payloads; truncating or replacing a mapped file while it
  // is being page-faulted can crash kitty with SIGBUS / cluster_pagein past EOF.
  // Size changes therefore allocate a fresh generation of slot files and retire
  // the old generation only after a grace period.
  private _rawInitialized = false;
  private _lastSourceKey = "";
  private _stdoutInFlight = false;
  private _retireTimers: Timer[] = [];
  private _retiredRawDirs: { dir: string; paths: string[]; timer: Timer }[] = [];

  private _rust?: ChildProcess;

  // Pipeline: track pending stdout write so the next file write can overlap.
  private _stdoutPending: Promise<void> = Promise.resolve();

  constructor(private config: Config) {
    if (shouldUseRustRenderer(config)) {
      this.startRustRenderer();
    }
    if (this._transientHint) {
      debugLog(this.config.debug, "[renderer] transient usage hint enabled (N=1); requires kitty graphics protocol usage hints (PR kovidgoyal/kitty#10092)");
    }
  }

  clear() {
    if (this._rust) {
      this.sendRust({ type: "clear" }).catch(() => {});
      this.lastPlace = undefined;
      return;
    }
    this.deleteRawImages();
    process.stdout.write("\x1b[2J\x1b[H");
    this.lastPlace = undefined;
  }

  dispose() {
    if (this._rust) {
      try { this._rust.stdin?.end(); } catch {}
      this._rust = undefined;
      this.lastPlace = undefined;
    } else {
      this.deleteRawImages();
      process.stdout.write(this.deleteSequence());
    }
    this.lastPlace = undefined;
    for (const timer of this._retireTimers) {
      try { clearTimeout(timer); } catch {}
    }
    this._retireTimers = [];
    for (const retired of this._retiredRawDirs) {
      this.removeRawDir(retired.dir, retired.paths);
    }
    this._retiredRawDirs = [];
    if (this._rawDir) {
      this.removeRawDir(this._rawDir, this._rawPaths);
    }
    this._rawDir = undefined;
    this._rawPaths = [];
  }

  /**
   * KittyGraphicsSink interface: render a frame at a placement. Hides the
   * buffer-vs-file-vs-direct routing and the dimension fallback behind one
   * seam — the same seam the Rust kitty-runtime satisfies as the other adapter.
   */
  async draw(frame: ScreenshotFrame, place: Placement) {
    const w = frame.width || place.pixelWidth;
    const h = frame.height || place.pixelHeight;
    if (frame.kind === "buffer") {
      await this.drawRawFile({ buffer: frame.data, width: w, height: h, format: frame.format, transfer: frame.transfer, dirty: frame.dirty }, place);
    } else {
      await this.drawRawFilePath({ path: frame.path, byteLength: frame.byteLength, width: w, height: h, format: frame.format, transfer: frame.transfer, dirty: frame.dirty }, place);
    }
  }

  async drawRawFile(rgba: RGBAFrame, place: Placement) {
    // Buffer frames arrive only when cef-core chose direct (small dirty deltas,
    // or forced-direct mode). Route to the Rust renderer's direct path, or to
    // inline base64 for the TS renderer fallback. Buffers are never written to
    // file slots: that would defeat the memory-only goal of the direct path.
    if (this._rust) {
      await this.sendRustDirect(rgba, place);
      return;
    }
    await this.drawDirectInline(rgba, place);
  }

  async drawRawFilePath(raw: { path: string; byteLength: number; width: number; height: number; format?: "rgba" | "rgb"; transfer?: "file" | "shm" | "direct"; dirty?: { x: number; y: number; width: number; height: number } }, place: Placement) {
    if (this._rust) {
      await this.sendRust({ type: "drawFile", raw, place });
      return;
    }
    let seq = "";

    const sourceKey = `${raw.width}x${raw.height}:${raw.format ?? "rgba"}`;
    const placementChanged = !!this.lastPlace && !samePlacement(this.lastPlace, place);
    const sourceChanged = this._lastSourceKey !== sourceKey;

    if (placementChanged || sourceChanged) {
      seq += this.deleteSequence();
      seq += "\x1b[2J\x1b[H";
      this._rawInitialized = false;
    }

    this.lastPlace = { ...place };
    this._lastSourceKey = sourceKey;

    const id = this._displayImageId;
    const payload = this.base64Path(raw.path);
    const kittyFormat = raw.format === "rgb" ? 24 : 32;
    const transfer = raw.transfer === "shm" ? "s" : "f";
    // N is only valid on data-transmit commands (a=T / a=f). Placement, compose,
    // animate and delete commands intentionally omit it.
    const usageHint = this._transientHint ? ",N=1" : "";

    if (!this._rawInitialized) {
      for (const i of this._cleanupImageIds) {
        seq += `\x1b_Ga=d,i=${i},q=2;\x1b\\`;
      }

      // First frame creates one stable image + one stable placement. Subsequent
      // dirty frames are sent as small animation frames and composited into
      // the root frame, avoiding a full-frame transmit for local damage.
      seq += `\x1b[${place.yCell};${place.xCell}H`;
      seq += `\x1b_Ga=T,i=${id},p=${this._placementId},f=${kittyFormat},t=${transfer},S=${raw.byteLength},s=${raw.width},v=${raw.height},c=${place.cols},r=${place.rows},C=1,q=2${usageHint};${payload}\x1b\\`;
      seq += `\x1b_Ga=a,i=${id},c=${this._rootFrame},q=2;\x1b\\`;
      this._rawInitialized = true;
    } else if (raw.dirty) {
      const d = raw.dirty;
      // In-place partial update of the root frame: a=f,r=ROOT,x,y,s,v,X=1 edits
      // the displayed frame directly and kitty redraws automatically — one
      // command, no scratch/compose/delete. The root frame is shared across shm
      // and direct deltas, so the source key must not depend on transfer mode.
      seq += `\x1b_Ga=f,i=${id},r=${this._rootFrame},f=${kittyFormat},t=${transfer},S=${raw.byteLength},x=${d.x},y=${d.y},s=${d.width},v=${d.height},X=1,q=2${usageHint};${payload}\x1b\\`;
    } else {
      seq += `\x1b_Ga=f,i=${id},r=${this._rootFrame},f=${kittyFormat},t=${transfer},S=${raw.byteLength},s=${raw.width},v=${raw.height},X=1,q=2${usageHint};${payload}\x1b\\`;
      seq += `\x1b_Ga=a,i=${id},c=${this._rootFrame},q=2;\x1b\\`;
    }

    await this._stdoutPending;
    this._stdoutPending = this.writeStdout(seq);
    await this._stdoutPending;
  }

  /**
   * TS-renderer fallback for direct (inline base64) frames. Buffer frames arrive
   * only when cef-core chose direct, so the pixels go straight to the PTY. Shares
   * the root-frame/init state with drawRawFilePath so a session can freely mix
   * shm (large/full) and direct (small) deltas on the same root image.
   */
  private async drawDirectInline(rgba: RGBAFrame, place: Placement) {
    let prefix = "";
    // Source identity is dimensions+format only — NOT transfer — so switching
    // between shm and direct between frames does not reinit the root frame.
    const sourceKey = `${rgba.width}x${rgba.height}:${rgba.format ?? "rgba"}`;
    const placementChanged = !!this.lastPlace && !samePlacement(this.lastPlace, place);
    const sourceChanged = this._lastSourceKey !== sourceKey;

    if (placementChanged || sourceChanged) {
      prefix += this.deleteSequence();
      prefix += "\x1b[2J\x1b[H";
      this._rawInitialized = false;
    }
    this.lastPlace = { ...place };
    this._lastSourceKey = sourceKey;

    const id = this._displayImageId;
    const kittyFormat = rgba.format === "rgb" ? 24 : 32;
    const usageHint = this._transientHint ? ",N=1" : "";

    // Init/full uses the full-frame buffer. Under adaptive mode the first frame
    // is always shm, so this init branch only runs under forced direct; a dirty
    // crop is never the first frame.
    if (!this._rawInitialized) {
      for (const i of this._cleanupImageIds) prefix += `\x1b_Ga=d,i=${i},q=2;\x1b\\`;
      prefix += `\x1b[${place.yCell};${place.xCell}H`;
      this._rawInitialized = true;
      const keys = `a=T,i=${id},p=${this._placementId},f=${kittyFormat},t=d,S=${rgba.buffer.length},s=${rgba.width},v=${rgba.height},c=${place.cols},r=${place.rows},C=1,q=2${usageHint}`;
      await this._stdoutPending;
      this._stdoutPending = this.writeChunkedDirect(keys, prefix, rgba.buffer);
      await this._stdoutPending;
      return;
    }

    if (rgba.dirty) {
      const d = rgba.dirty;
      const keys = `a=f,i=${id},r=${this._rootFrame},f=${kittyFormat},t=d,S=${rgba.buffer.length},x=${d.x},y=${d.y},s=${d.width},v=${d.height},X=1,q=2${usageHint}`;
      await this._stdoutPending;
      this._stdoutPending = this.writeChunkedDirect(keys, prefix, rgba.buffer);
      await this._stdoutPending;
      return;
    }

    // Forced-direct full-frame refresh.
    const keys = `a=f,i=${id},r=${this._rootFrame},f=${kittyFormat},t=d,S=${rgba.buffer.length},s=${rgba.width},v=${rgba.height},X=1,q=2${usageHint}`;
    await this._stdoutPending;
    this._stdoutPending = this.writeChunkedDirect(keys, prefix, rgba.buffer);
    await this._stdoutPending;
  }

  /**
   * Write a direct (t=d) payload as base64-chunked APC sequences. 3072 raw bytes
   * -> 4096 base64 chars; chunk size divisible by 3 avoids '=' padding in
   * intermediate chunks. Direct payloads are small dirty deltas, so joining in
   * memory is fine.
   */
  private writeChunkedDirect(keys: string, prefix: string, buffer: Buffer): Promise<void> {
    const RAW_CHUNK = 3072;
    if (buffer.length === 0) {
      return this.writeStdout(`${prefix}\x1b_G${keys};\x1b\\`);
    }
    const parts: string[] = [prefix];
    let offset = 0;
    let first = true;
    while (offset < buffer.length) {
      const end = Math.min(offset + RAW_CHUNK, buffer.length);
      const encoded = buffer.subarray(offset, end).toString("base64");
      const more = end < buffer.length;
      if (first) {
        parts.push(more ? `\x1b_G${keys},m=1;${encoded}\x1b\\` : `\x1b_G${keys};${encoded}\x1b\\`);
        first = false;
      } else {
        parts.push(more ? `\x1b_Gm=1;${encoded}\x1b\\` : `\x1b_Gm=0;${encoded}\x1b\\`);
      }
      offset = end;
    }
    return this.writeStdout(parts.join(""));
  }

  isBackpressured() {
    return this._stdoutInFlight;
  }

  private writeStdout(data: string | Buffer): Promise<void> {
    this._stdoutInFlight = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        this._stdoutInFlight = false;
        if (error) reject(error);
        else resolve();
      };

      const ok = process.stdout.write(data, (error) => done(error));

      if (!ok) {
        process.stdout.once("drain", () => done());
        process.stdout.once("error", done);
      }
    });
  }

  private async sendRustDirect(rgba: RGBAFrame, place: Placement): Promise<void> {
    const proc = this._rust;
    if (!proc || !proc.stdin?.writable) return;

    const command = {
      type: "drawDirect",
      raw: {
        byteLength: rgba.buffer.length,
        width: rgba.width,
        height: rgba.height,
        format: rgba.format ?? "rgba",
        dirty: rgba.dirty,
      },
      place,
    };

    const header = Buffer.from(JSON.stringify(command) + "\n");
    this._stdoutInFlight = true;

    if (this.config.debug && process.env.KITTY_WEB_UI_DIRECT_DEBUG === "1") {
      debugLog(true, `[renderer] direct write begin bytes=${rgba.buffer.length} ${rgba.width}x${rgba.height}`);
    }
    try {
      await writeOrDrain(proc.stdin, header);
      await writeOrDrain(proc.stdin, rgba.buffer);
      if (this.config.debug && process.env.KITTY_WEB_UI_DIRECT_DEBUG === "1") {
        debugLog(true, `[renderer] direct write end bytes=${rgba.buffer.length}`);
      }
    } finally {
      this._stdoutInFlight = false;
    }
  }

  resetRawFile() {
    if (this._rust) {
      this.sendRust({ type: "resetRawFile" }).catch(() => {});
      return;
    }
    this.deleteRawImages();
    this._rawInitialized = false;
  }

  private deleteRawImages() {
    this._rawInitialized = false;
    this._lastSourceKey = "";
    for (const id of this._cleanupImageIds) process.stdout.write(`\x1b_Ga=d,i=${id},q=2;\x1b\\`);
  }

  private deleteSequence(): string {
    return this._cleanupImageIds.map((id) => `\x1b_Ga=d,i=${id},q=2;\x1b\\`).join("");
  }

  private base64Path(path: string) {
    let encoded = this._pathBase64Cache.get(path);
    if (!encoded) {
      encoded = Buffer.from(path).toString("base64");
      this._pathBase64Cache.set(path, encoded);
    }
    return encoded;
  }

  private reinitializeRawSlots(size: number) {
    this.deleteRawImages();
    this._rawInitialized = false;
    this._lastSourceKey = "";
    this._rawFileIndex = 0;

    const oldDir = this._rawDir;
    const oldPaths = this._rawPaths;
    this._rawDir = this.createRawDir();
    this._rawPaths = this.createRawPaths(this._rawDir);
    this._pathBase64Cache.clear();
    this._rawSlotSize = size;

    for (const path of this._rawPaths) {
      const fd = openSync(path, "wx");
      try {
        ftruncateSync(fd, size);
      } finally {
        closeSync(fd);
      }
    }
    if (oldDir && oldPaths.length > 0) {
      this.retireRawDir(oldDir, oldPaths);
    }
  }

  private createRawDir() {
    return mkdtempSync(join(rawFrameDirBase(), `kitty-webview-${process.pid}-`));
  }

  private createRawPaths(dir: string) {
    return Array.from({ length: this._rawSlotCount }, (_, i) => join(dir, `${i}.rgba`));
  }

  private retireRawDir(dir: string, paths: string[]) {
    const timer = setTimeout(() => {
      this._retireTimers = this._retireTimers.filter((t) => t !== timer);
      this._retiredRawDirs = this._retiredRawDirs.filter((r) => r.timer !== timer);
      this.removeRawDir(dir, paths);
    }, RAW_RETIRE_DELAY_MS);
    this._retireTimers.push(timer);
    this._retiredRawDirs.push({ dir, paths, timer });
  }

  private removeRawDir(dir: string, paths: string[]) {
    for (const path of paths) {
      try { rmSync(path, { force: true }); } catch {}
    }
    try { rmdirSync(dir); } catch {}
  }

  private startRustRenderer() {
    const command = resolveRustRuntimePath();
    try {
      this._rust = spawn(command, [], {
        stdio: ["pipe", "inherit", process.env.KITTY_WEB_UI_NATIVE_STDERR === "inherit" ? "inherit" : "pipe"],
        env: process.env as Record<string, string>,
      }) as any;
    } catch (error) {
      debugLog(this.config.debug, `[renderer] failed to start rust renderer=${command}: ${(error as Error).message}`);
      this._rust = undefined;
      return;
    }

    debugLog(this.config.debug, `[renderer] rust renderer enabled command=${command}`);

    this._rust!.stderr?.on("data", (chunk: Buffer) => {
      debugLog(this.config.debug, `[kitty-runtime] ${chunk.toString("utf8").trimEnd()}`);
    });
    this._rust!.on("exit", (code, signal) => {
      debugLog(this.config.debug, `[renderer] rust renderer exited code=${code ?? "?"} signal=${signal ?? "?"}`);
      this._rust = undefined;
    });
  }

  private sendRust(command: unknown): Promise<void> {
    const proc = this._rust;
    if (!proc || !proc.stdin?.writable) return Promise.resolve();

    const line = JSON.stringify(command) + "\n";
    this._stdoutInFlight = true;

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        this._stdoutInFlight = false;
        if (error) reject(error);
        else resolve();
      };

      const ok = proc.stdin!.write(line);
      if (ok) {
        done();
        return;
      }

      proc.stdin!.once("drain", () => done());
      proc.stdin!.once("error", done);
    });
  }
}

function samePlacement(a: Placement, b: Placement) {
  return a.xCell === b.xCell && a.yCell === b.yCell && a.cols === b.cols && a.rows === b.rows && a.pixelWidth === b.pixelWidth && a.pixelHeight === b.pixelHeight;
}

function rawSlotCount() {
  const value = Number(process.env.KITTY_WEBVIEW_RAW_SLOTS || 2);
  if (!Number.isInteger(value)) return 2;
  return Math.max(2, Math.min(16, value));
}

// Graphics protocol usage hint "transient" (N=1, PR kovidgoyal/kitty#10092). Default
// ON for this build (targets Kitty with usage hints); disable with
// KITTY_WEBVIEW_TRANSIENT_HINT=0. Older kitty rejects the unknown N key and
// drops the whole command.
function transientHintEnabled() {
  const value = process.env.KITTY_WEBVIEW_TRANSIENT_HINT;
  if (value === "0" || value === "false" || value === "FALSE" || value === "no" || value === "NO") return false;
  return true;
}

function rawFrameDirBase() {
  // Kitty's file-transfer mode reads raw frames by pathname. On Linux, /dev/shm
  // keeps those per-frame writes in memory and avoids storage-backed /tmp I/O.
  // macOS does not expose a compatible /dev/shm, so it falls back to tmpdir().
  if (process.platform === "linux") {
    try {
      accessSync("/dev/shm", constants.W_OK | constants.X_OK);
      return "/dev/shm";
    } catch {}
  }
  return tmpdir();
}

function resolveRustRuntimePath() {
  const env = process.env.KITTY_WEB_UI_KITTY_RUNTIME;
  if (env) return env;
  return join(
    process.cwd(),
    "native",
    "kitty-runtime",
    "target",
    "release",
    "kitty-runtime",
  );
}

function shouldUseRustRenderer(config: Config) {
  const env = process.env.KITTY_WEB_UI_RUST_RENDERER;
  if (env === "1" || env === "true" || env === "TRUE" || env === "yes" || env === "YES") return true;
  if (env === "0" || env === "false" || env === "FALSE" || env === "no" || env === "NO") return false;

  if (config.kittyRenderer === "rust") return true;
  if (config.kittyRenderer === "ts") return false;

  // auto: use the Rust renderer when the binary exists. This keeps fresh
  // checkouts usable before `bun run build:kitty-runtime`, while making the
  // best-performing path the default after it has been built.
  const command = resolveRustRuntimePath();
  return existsSync(command);
}

function writeOrDrain(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    const ok = stream.write(chunk, (error?: Error | null) => done(error));
    if (!ok) {
      stream.once("drain", () => done());
      stream.once("error", done);
    }
  });
}
