import { test, expect } from "bun:test";
import { FrameSource, type InboundFrame, type FrameSourceDeps, type FrameDropReason } from "./frame-source";

function makeDeps(opts: { backpressured?: boolean; onFrame?: () => void; onDrop?: (f: InboundFrame, r: FrameDropReason) => void } = {}) {
  const acked: (number | undefined)[] = [];
  const drops: { seq?: number; reason: FrameDropReason }[] = [];
  let frames = 0;
  const deps: FrameSourceDeps = {
    ack: (seq) => acked.push(seq),
    isBackpressured: () => opts.backpressured ?? false,
    onFrame: opts.onFrame ?? (() => { frames++; }),
    onDrop: opts.onDrop ?? ((f, reason) => drops.push({ seq: f.seq, reason })),
  };
  return { deps, acked, drops, get frames() { return frames; } };
}

function frame(seq: number, w = 100, h = 100, extra: Partial<InboundFrame> = {}): InboundFrame {
  return { seq, path: "/dev/shm/frame", byteLength: w * h * 4, width: w, height: h, ...extra };
}

test("dirty frames are delivered in order so every changed region is applied", () => {
  const ctx = makeDeps();
  const fs = new FrameSource(ctx.deps);
  fs.setExpectedSize(100, 100);
  fs.push(frame(1, 100, 100, { dirty: { x: 0, y: 0, width: 10, height: 10 } }));
  fs.push(frame(2, 100, 100, { dirty: { x: 90, y: 90, width: 10, height: 10 } }));
  expect(fs.next()?.seq).toBe(1);
  expect(fs.next()?.seq).toBe(2);
});

test("a full frame supersedes queued deltas", () => {
  const ctx = makeDeps();
  const fs = new FrameSource(ctx.deps);
  fs.setExpectedSize(100, 100);
  fs.push(frame(1, 100, 100, { dirty: { x: 0, y: 0, width: 10, height: 10 } }));
  fs.push(frame(2));
  expect(fs.next()?.seq).toBe(2);
  expect(fs.next()).toBe(null);
  expect(ctx.acked).toContain(1);
});

test("next() returns null when empty", () => {
  const ctx = makeDeps();
  expect(new FrameSource(ctx.deps).next()).toBe(null);
});

test("stale-sized frame is rejected at store time, acked, and reported", () => {
  const ctx = makeDeps();
  const fs = new FrameSource(ctx.deps);
  fs.setExpectedSize(100, 100);
  fs.push(frame(1, 400, 300));
  expect(ctx.acked).toContain(1);
  expect(ctx.drops).toEqual([{ seq: 1, reason: "stale" }]);
  expect(fs.next()).toBe(null);
});

test("store-time check is not applied before an expected size is set", () => {
  const ctx = makeDeps();
  const fs = new FrameSource(ctx.deps);
  fs.push(frame(1, 1280, 800));
  expect(fs.next()).not.toBe(null);
});

test("setExpectedSize clears the buffered frame", () => {
  const ctx = makeDeps();
  const fs = new FrameSource(ctx.deps);
  fs.setExpectedSize(100, 100);
  fs.push(frame(1));
  fs.setExpectedSize(200, 200);
  expect(fs.next()).toBe(null);
});

test("backpressure retains a frame until rendering can resume", () => {
  let backpressured = true;
  const ctx = makeDeps();
  ctx.deps.isBackpressured = () => backpressured;
  const fs = new FrameSource(ctx.deps);
  fs.setExpectedSize(100, 100);
  fs.push(frame(7));
  expect(fs.next()).toBe(null);
  expect(ctx.acked).not.toContain(7);
  backpressured = false;
  expect(fs.next()?.seq).toBe(7);
});

test("a frame is acknowledged only after rendering completes", () => {
  const ctx = makeDeps();
  const fs = new FrameSource(ctx.deps);
  fs.setExpectedSize(100, 100);
  fs.push(frame(5));
  const taken = fs.next();
  expect(ctx.acked).not.toContain(5);
  fs.complete(taken?.seq);
  expect(ctx.acked).toContain(5);
});

test("onFrame fires for accepted and stale pushes", () => {
  const ctx = makeDeps();
  const fs = new FrameSource(ctx.deps);
  fs.setExpectedSize(100, 100);
  fs.push(frame(1));
  fs.push(frame(2, 999, 999));
  expect(ctx.frames).toBe(2);
});

test("clear() drops and acks the buffered frame without reporting", () => {
  const ctx = makeDeps();
  const fs = new FrameSource(ctx.deps);
  fs.setExpectedSize(100, 100);
  fs.push(frame(9));
  fs.clear();
  expect(ctx.acked).toContain(9);
  expect(ctx.drops).toEqual([]);
  expect(fs.next()).toBe(null);
});

test("file frame shape is preserved through next()", () => {
  const ctx = makeDeps();
  const fs = new FrameSource(ctx.deps);
  fs.setExpectedSize(100, 100);
  fs.push(frame(1, 100, 100, { path: "/dev/shm/x", dirty: { x: 1, y: 2, width: 3, height: 4 } }));
  const got = fs.next();
  expect(got?.kind).toBe("file");
  if (got?.kind === "file") {
    expect(got.path).toBe("/dev/shm/x");
    expect(got.dirty).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  }
});
