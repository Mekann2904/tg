import type { KeyModifiers } from "./types";

export interface PendingWheel {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  modifiers?: KeyModifiers;
}

/**
 * Coalesces a burst of mouse-wheel events into a single dispatch.
 *
 * Consecutive wheel events that arrive within `coalesceMs` are summed
 * (deltaX/deltaY accumulate, x/y track the latest position, and the latest
 * defined modifiers win) and flushed once. A manual `flush()` forces any
 * pending event out immediately — used when an ordered event (click/key)
 * follows a wheel so it cannot overtake the coalesced dispatch.
 */
export class WheelCoalescer {
  private pending: PendingWheel | null = null;
  private timer?: Timer;

  constructor(
    private readonly coalesceMs: number,
    private readonly onFlush: (wheel: PendingWheel) => void,
  ) {}

  queue(x: number, y: number, deltaX: number, deltaY: number, modifiers?: KeyModifiers) {
    if (!this.pending) {
      this.pending = { x, y, deltaX, deltaY, modifiers };
    } else {
      this.pending.x = x;
      this.pending.y = y;
      this.pending.deltaX += deltaX;
      this.pending.deltaY += deltaY;
      if (modifiers !== undefined) this.pending.modifiers = modifiers;
    }

    if (this.coalesceMs === 0) {
      this.flush();
      return;
    }

    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), this.coalesceMs);
    }
  }

  flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const wheel = this.pending;
    this.pending = null;
    if (wheel) this.onFlush(wheel);
  }

  dispose() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = null;
  }
}
