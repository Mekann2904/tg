import type { ScreenshotFrame } from "./types";

/** A frame as it arrives from the browser helper, before rendering. */
export interface InboundFrame {
  seq?: number;
  data?: Buffer;
  path?: string;
  byteLength: number;
  width: number;
  height: number;
  format?: "rgba" | "rgb";
  transfer?: "file" | "shm" | "direct";
  dirty?: { x: number; y: number; width: number; height: number };
}

export type FrameDropReason = "stale" | "backpressure";

export interface FrameSourceDeps {
  /** Release a frame to the producer. Rendered frames are acked via complete(). */
  ack: (seq?: number) => void;
  isBackpressured: () => boolean;
  onFrame?: () => void;
  onDrop?: (frame: InboundFrame, reason: FrameDropReason) => void;
}

const STALE_PX = 2;

/**
 * Preserves the dependency chain between browser frame deltas.
 *
 * Dirty frames are relative to the previously emitted browser frame, so they
 * must be rendered in FIFO order. A full frame is self-contained and may
 * supersede queued (not yet rendered) deltas. Producer ACK happens only after
 * the renderer has accepted the frame through complete().
 */
export class FrameSource {
  private pending: InboundFrame[] = [];
  private expected = { width: 0, height: 0 };

  constructor(private deps: FrameSourceDeps) {}

  push(frame: InboundFrame): void {
    if (this.isStale(frame)) {
      this.deps.ack(frame.seq);
      this.deps.onDrop?.(frame, "stale");
      this.deps.onFrame?.();
      return;
    }

    if (!frame.dirty) {
      this.releasePending();
    }
    this.pending.push(frame);
    this.deps.onFrame?.();
  }

  next(): ScreenshotFrame | null {
    if (this.deps.isBackpressured()) return null;
    const frame = this.pending.shift();
    return frame ? toScreenshot(frame) : null;
  }

  /** Acknowledge only after the renderer's write/drain has completed. */
  complete(seq?: number): void {
    this.deps.ack(seq);
  }

  setExpectedSize(width: number, height: number): void {
    this.expected = { width: Math.round(width), height: Math.round(height) };
    this.releasePending();
  }

  clear(): void {
    this.releasePending();
  }

  private releasePending(): void {
    for (const frame of this.pending) this.deps.ack(frame.seq);
    this.pending = [];
  }

  private isStale(frame: InboundFrame): boolean {
    if (this.expected.width <= 0 || this.expected.height <= 0) return false;
    return (
      Math.abs(frame.width - this.expected.width) > STALE_PX ||
      Math.abs(frame.height - this.expected.height) > STALE_PX
    );
  }
}

function toScreenshot(f: InboundFrame): ScreenshotFrame {
  if (f.path) {
    return {
      kind: "file",
      seq: f.seq,
      path: f.path,
      byteLength: f.byteLength,
      width: f.width,
      height: f.height,
      format: f.format ?? "rgba",
      transfer: f.transfer ?? "file",
      dirty: f.dirty,
    };
  }
  return {
    kind: "buffer",
    seq: f.seq,
    data: f.data!,
    width: f.width,
    height: f.height,
    transfer: f.transfer === "direct" ? "direct" : undefined,
    format: f.format ?? "rgba",
    dirty: f.dirty,
  };
}
