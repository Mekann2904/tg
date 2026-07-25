import type { TerminalSize } from "./types";

/**
 * Debounces terminal resize requests into batched browser resizes.
 *
 * Each `request()` records the latest size and arms a trailing-edge debounce
 * timer (`debounceMs`). When it fires, `runBatch()` is invoked once to drain
 * every size accumulated so far: the batch calls `take()` on each iteration to
 * pull the latest pending size (or null when drained), so a single batch can
 * absorb a whole burst without re-entering the browser command queue.
 *
 * Sizes that arrive while a batch is running are not applied mid-batch; after
 * the batch settles they re-arm the debounce, so the browser is only ever
 * resized to the most recent geometry. `dispose()` cancels any armed timer and
 * freezes the coordinator so late requests can no longer schedule work.
 */
export class ResizeCoordinator {
  private latest: TerminalSize | null = null;
  private running = false;
  private timer?: Timer;
  private disposed = false;

  constructor(
    private readonly debounceMs: number,
    private readonly runBatch: () => Promise<void>,
    private readonly onSettled?: () => void,
  ) {}

  request(size: TerminalSize) {
    if (this.disposed) return;
    this.latest = size;
    this.arm();
  }

  /** Pull the latest pending size, or null once drained. Called by runBatch. */
  take(): TerminalSize | null {
    const size = this.latest;
    this.latest = null;
    return size;
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private arm() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.running || this.disposed) return;
    if (this.debounceMs === 0) {
      void this.fire();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.fire();
    }, this.debounceMs);
  }

  private async fire() {
    this.running = true;
    try {
      await this.runBatch();
    } finally {
      this.running = false;
      this.onSettled?.();
      if (this.latest && !this.disposed) this.arm();
    }
  }
}
