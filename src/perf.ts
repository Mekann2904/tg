export class PerfStats {
  screenshotMs = 0;
  drawMs = 0;
  frameMs = 0;
  fps = 0;
  dropped = 0;
  maxFrameMs = 0;
  maxGapMs = 0;
  rssMb = 0;
  heapMb = 0;
  externalMb = 0;

  private frames = 0;
  private last = performance.now();
  private lastSampleAt = 0;
  private windowMaxFrameMs = 0;
  private windowMaxGapMs = 0;

  sampleFrame() {
    this.frames++;

    const now = performance.now();
    this.windowMaxFrameMs = Math.max(this.windowMaxFrameMs, this.frameMs);
    if (this.lastSampleAt > 0) {
      this.windowMaxGapMs = Math.max(this.windowMaxGapMs, now - this.lastSampleAt);
    }
    this.lastSampleAt = now;

    const mem = process.memoryUsage?.();
    if (mem) {
      this.rssMb = mem.rss / 1048576;
      this.heapMb = mem.heapUsed / 1048576;
      this.externalMb = mem.external / 1048576;
    }

    const dt = now - this.last;

    if (dt >= 1000) {
      this.fps = (this.frames * 1000) / dt;
      this.maxFrameMs = this.windowMaxFrameMs;
      this.maxGapMs = this.windowMaxGapMs;
      this.frames = 0;
      this.windowMaxFrameMs = 0;
      this.windowMaxGapMs = 0;
      this.last = now;
    }
  }

  line() {
    return `fps=${this.fps.toFixed(1)} frame=${this.frameMs.toFixed(2)}ms maxFrame=${this.maxFrameMs.toFixed(2)}ms gapMax=${this.maxGapMs.toFixed(2)}ms screenshot=${this.screenshotMs.toFixed(2)}ms draw=${this.drawMs.toFixed(2)}ms rss=${this.rssMb.toFixed(1)}MB heap=${this.heapMb.toFixed(1)}MB external=${this.externalMb.toFixed(1)}MB dropped=${this.dropped}`;
  }

  logEverySecond(sink: (line: string) => void = console.error) {
    sink(this.line());
  }
}
