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
  private runtimeOutput = Buffer.alloc(0);
  private pendingRuntimeWrites: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(private config: Config) {
    this.startRustRenderer();
  }

  async draw(frame: ScreenshotFrame, place: Placement) {
    await this.sendRust({
      type: "drawFile",
      raw: {
        path: frame.path,
        byteLength: frame.byteLength,
        width: frame.width,
        height: frame.height,
        format: frame.format,
        dirty: frame.dirty,
      },
      place,
    });
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
        // Runtime stdout is length-framed IPC. The parent is the sole terminal
        // writer, preventing Kitty graphics APCs from racing cursor CSI output.
        stdio: ["pipe", "pipe", process.env.KITTY_WEB_UI_NATIVE_STDERR === "inherit" ? "inherit" : "pipe"],
        env: process.env as Record<string, string>,
      });
    } catch (error) {
      throw new Error(`failed to start rust renderer=${command}: ${(error as Error).message}`);
    }

    debugLog(this.config.debug, `[renderer] rust renderer enabled command=${command}`);

    this._rust.stdout?.on("data", (chunk: Buffer) => this.handleRuntimeOutput(chunk));
    this._rust.stderr?.on("data", (chunk: Buffer) => {
      debugLog(this.config.debug, `[kitty-runtime] ${chunk.toString("utf8").trimEnd()}`);
    });
    this._rust.on("exit", (code, signal) => {
      debugLog(this.config.debug, `[renderer] rust renderer exited code=${code ?? "?"} signal=${signal ?? "?"}`);
      const error = new Error(`rust renderer exited code=${code ?? "?"} signal=${signal ?? "?"}`);
      for (const pending of this.pendingRuntimeWrites.splice(0)) pending.reject(error);
      this._stdoutInFlight = false;
      this._rust = undefined;
    });
  }

  private sendRust(command: unknown): Promise<void> {
    const proc = this._rust;
    if (!proc || !proc.stdin?.writable) return Promise.resolve();

    const line = JSON.stringify(command) + "\n";
    this._stdoutInFlight = true;

    return new Promise((resolve, reject) => {
      this.pendingRuntimeWrites.push({ resolve, reject });
      proc.stdin!.write(line, (error) => {
        if (!error) return;
        const pending = this.pendingRuntimeWrites.shift();
        this._stdoutInFlight = this.pendingRuntimeWrites.length > 0;
        pending?.reject(error);
      });
    });
  }

  private handleRuntimeOutput(chunk: Buffer) {
    this.runtimeOutput = Buffer.concat([this.runtimeOutput, chunk]);

    while (this.runtimeOutput.length >= 4) {
      const length = this.runtimeOutput.readUInt32LE(0);
      if (this.runtimeOutput.length < 4 + length) return;

      const packet = this.runtimeOutput.subarray(4, 4 + length);
      this.runtimeOutput = this.runtimeOutput.subarray(4 + length);
      const pending = this.pendingRuntimeWrites.shift();

      process.stdout.write(packet, (error) => {
        this._stdoutInFlight = this.pendingRuntimeWrites.length > 0;
        if (error) pending?.reject(error);
        else pending?.resolve();
      });
    }
  }

}

function resolveRustRuntimePath() {
  const env = process.env.KITTY_WEB_UI_KITTY_RUNTIME;
  if (env) return env;
  return join(process.cwd(), "native", "kitty-runtime", "target", "release", "kitty-runtime");
}

