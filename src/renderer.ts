import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config, Placement, ScreenshotFrame } from "./types";
import { debugLog } from "./debug";

/**
 * Kitty graphics renderer.
 *
 * The Kitty Graphics Protocol is implemented once, in Rust, by the
 * `native/kitty-runtime` binary (two-frame staging pipeline with synchronized
 * output). This class is a thin adapter that spawns that binary and forwards
 * frames as length/JSON commands on stdin. The previous in-process TypeScript
 * renderer (inline base64 + raw file slots) was a duplicate of the Rust
 * implementation and has been removed; Rust is now the single source of truth.
 */
export class KittyRenderer {
  private _rust?: ChildProcess;
  private _stdoutInFlight = false;

  constructor(private config: Config) {
    this.startRustRenderer();
  }

  async draw(frame: ScreenshotFrame, place: Placement) {
    const w = frame.width;
    const h = frame.height;
    if (frame.kind === "buffer") {
      await this.sendRustDirect(
        { byteLength: frame.data.length, width: w, height: h, format: frame.format, dirty: frame.dirty },
        place,
        frame.data,
      );
    } else {
      await this.sendRust({
        type: "drawFile",
        raw: { path: frame.path, byteLength: frame.byteLength, width: w, height: h, format: frame.format, transfer: frame.transfer, dirty: frame.dirty },
        place,
      });
    }
  }

  clear() {
    this.sendRust({ type: "clear" }).catch(() => {});
  }

  resetRawFile() {
    this.sendRust({ type: "resetRawFile" }).catch(() => {});
  }

  isBackpressured() {
    return this._stdoutInFlight;
  }

  dispose() {
    const proc = this._rust;
    if (!proc) return;
    // Ask the runtime to delete its placements, then close stdin to exit.
    this.sendRust({ type: "dispose" }).catch(() => {});
    try { proc.stdin?.end(); } catch {}
    this._rust = undefined;
  }

  private startRustRenderer() {
    const command = resolveRustRuntimePath();
    if (!existsSync(command)) {
      throw new Error(
        `Rust kitty-runtime not found at ${command}\n` +
        "Build it first: bun run build:kitty-runtime",
      );
    }
    try {
      this._rust = spawn(command, [], {
        stdio: ["pipe", "inherit", process.env.KITTY_WEB_UI_NATIVE_STDERR === "inherit" ? "inherit" : "pipe"],
        env: process.env as Record<string, string>,
      });
    } catch (error) {
      throw new Error(`failed to start rust renderer=${command}: ${(error as Error).message}`);
    }

    debugLog(this.config.debug, `[renderer] rust renderer enabled command=${command}`);

    this._rust.stderr?.on("data", (chunk: Buffer) => {
      debugLog(this.config.debug, `[kitty-runtime] ${chunk.toString("utf8").trimEnd()}`);
    });
    this._rust.on("exit", (code, signal) => {
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

  private async sendRustDirect(
    raw: { byteLength: number; width: number; height: number; format?: "rgba" | "rgb"; dirty?: { x: number; y: number; width: number; height: number } },
    place: Placement,
    buffer: Buffer,
  ): Promise<void> {
    const proc = this._rust;
    if (!proc || !proc.stdin?.writable) return;

    const command = {
      type: "drawDirect",
      raw: {
        byteLength: raw.byteLength,
        width: raw.width,
        height: raw.height,
        format: raw.format ?? "rgba",
        dirty: raw.dirty,
      },
      place,
    };

    const header = Buffer.from(JSON.stringify(command) + "\n");
    this._stdoutInFlight = true;

    if (this.config.debug && process.env.KITTY_WEB_UI_DIRECT_DEBUG === "1") {
      debugLog(true, `[renderer] direct write begin bytes=${buffer.length} ${raw.width}x${raw.height}`);
    }
    try {
      await writeOrDrain(proc.stdin, header);
      await writeOrDrain(proc.stdin, buffer);
      if (this.config.debug && process.env.KITTY_WEB_UI_DIRECT_DEBUG === "1") {
        debugLog(true, `[renderer] direct write end bytes=${buffer.length}`);
      }
    } finally {
      this._stdoutInFlight = false;
    }
  }
}

function resolveRustRuntimePath() {
  const env = process.env.KITTY_WEB_UI_KITTY_RUNTIME;
  if (env) return env;
  return join(process.cwd(), "native", "kitty-runtime", "target", "release", "kitty-runtime");
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
