export type RenderMode = "continuous" | "hybrid" | "dirty";

export interface FramePumpStats {
  requested: number;
  rendered: number;
  dropped: number;
  lastFrameMs: number;
  fps: number;
}

/**
 * FramePump drives a steady render loop at `targetFps`.
 *
 * The pump runs a continuous setTimeout loop that targets absolute wall-clock
 * times (t₀, t₀+T, t₀+2T, …). This prevents drift caused by relative-delay
 * accumulation — each tick's setTimeout compensates for how long the current
 * tick actually took.
 *
 * When a frame callback is already in-flight, incoming requests are coalesced
 * via the `dirty` flag and picked up on the next tick.
 */
export class FramePump {
  private running = false;
  private rendering = false;
  private dirty = true;
  private renderFn?: () => Promise<void>;
  private renderQueued = false;

  private requested = 0;
  private rendered = 0;
  private dropped = 0;
  private lastFrameMs = 0;
  private lastStatsTime = performance.now();
  private framesInWindow = 0;
  private measuredFps = 0;

  // Absolute-time scheduling for continuous/hybrid modes.
  // Dirty mode is event-driven: request() queues a render immediately instead
  // of waiting for the next polling tick.
  private loopTimer?: Timer;
  private targetInterval: number;
  private nextTickTime = 0;

  constructor(
    private targetFps: number,
    private mode: RenderMode,
  ) {
    this.targetInterval = 1000 / targetFps;
  }

  onRender(fn: () => Promise<void>) {
    this.renderFn = fn;
  }

  start() {
    if (this.running) return;

    this.running = true;
    this.dirty = true;

    if (this.mode === "dirty") {
      this.queueRenderNow();
      return;
    }

    // First tick fires immediately so the initial frame is not delayed.
    // Subsequent ticks are paced against an absolute clock, so bursts of
    // CEF paint events are coalesced into at most one terminal update per
    // target interval.
    this.nextTickTime = performance.now();
    this.scheduleLoop();
  }

  stop() {
    this.running = false;
    this.renderQueued = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = undefined;
    }
  }

  request(reason: "start" | "input" | "resize" | "tick" | "external" = "external") {
    this.requested++;
    this.dirty = true;
    if (this.mode === "dirty") this.queueRenderNow();
  }

  stats(): FramePumpStats {
    return {
      requested: this.requested,
      rendered: this.rendered,
      dropped: this.dropped,
      lastFrameMs: this.lastFrameMs,
      fps: this.measuredFps,
    };
  }

  private queueRenderNow() {
    if (!this.running || this.renderQueued || this.rendering || !this.dirty) return;

    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (!this.running || this.rendering || !this.dirty) return;
      this.scheduleRender();
    });
  }

  private scheduleLoop() {
    if (!this.running) return;

    const now = performance.now();

    if (now >= this.nextTickTime) {
      // Tick is due — run it.
      if (!this.rendering && this.dirty) {
        this.scheduleRender();
      }

      // Advance nextTickTime by one or more intervals. If we fell behind
      // by more than one full interval, skip the missed ticks rather than
      // bursting to catch up.
      this.nextTickTime += this.targetInterval;
      if (this.nextTickTime < now) {
        this.nextTickTime = now + this.targetInterval;
      }
    }

    const delay = Math.max(0, this.nextTickTime - performance.now());
    this.loopTimer = setTimeout(() => this.scheduleLoop(), delay);
  }

  /**
   * Non-async render scheduler using .then() chaining.
   * Avoids async function frame creation + await overhead.
   */
  private scheduleRender() {
    if (!this.renderFn) return;

    this.rendering = true;
    this.dirty = false;
    const t0 = performance.now();
    const pump = this;

    this.renderFn().then(
      function () {
        pump.rendered++;
        pump.framesInWindow++;
        pump.lastFrameMs = performance.now() - t0;
        pump.updateFps();
        pump.rendering = false;
        if (pump.mode === "dirty" && pump.dirty) pump.queueRenderNow();
      },
      function () {
        pump.dropped++;
        pump.rendering = false;
        if (pump.mode === "dirty" && pump.dirty) pump.queueRenderNow();
      },
    );
  }

  private updateFps() {
    const now = performance.now();
    const dt = now - this.lastStatsTime;

    if (dt >= 1000) {
      this.measuredFps = (this.framesInWindow * 1000) / dt;
      this.framesInWindow = 0;
      this.lastStatsTime = now;
    }
  }
}
