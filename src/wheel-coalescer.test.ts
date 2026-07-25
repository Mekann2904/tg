import { test, expect } from "bun:test";
import { WheelCoalescer } from "./wheel-coalescer";

test("coalesceMs=0 flushes immediately on queue", () => {
  const flushed: number[] = [];
  const c = new WheelCoalescer(0, (w) => flushed.push(w.deltaY));
  c.queue(10, 20, 0, 5);
  c.queue(10, 20, 0, 7);
  expect(flushed).toEqual([5, 7]);
});

test("events within the coalesce window are summed into one flush", async () => {
  const flushed: { deltaX: number; deltaY: number; x: number; y: number }[] = [];
  const c = new WheelCoalescer(30, (w) => flushed.push({ deltaX: w.deltaX, deltaY: w.deltaY, x: w.x, y: w.y }));

  c.queue(1, 1, 0, 2);
  c.queue(2, 2, 0, 3);
  c.queue(3, 3, 0, 4);

  // Nothing flushed synchronously while the timer is armed.
  expect(flushed).toEqual([]);
  await Bun.sleep(50);

  expect(flushed).toEqual([{ deltaX: 0, deltaY: 9, x: 3, y: 3 }]);
});

test("a second burst arms a fresh timer after the first flushes", async () => {
  const flushed: number[] = [];
  const c = new WheelCoalescer(20, (w) => flushed.push(w.deltaY));

  c.queue(0, 0, 0, 1);
  await Bun.sleep(40);
  c.queue(0, 0, 0, 10);
  await Bun.sleep(40);

  expect(flushed).toEqual([1, 10]);
});

test("manual flush forces the pending event out and cancels the timer", async () => {
  const flushed: number[] = [];
  const c = new WheelCoalescer(100, (w) => flushed.push(w.deltaY));

  c.queue(0, 0, 0, 5);
  c.flush();
  expect(flushed).toEqual([5]);

  // After a manual flush, the timer must not fire later.
  await Bun.sleep(120);
  expect(flushed).toEqual([5]);
});

test("manual flush with nothing pending is a no-op", () => {
  const flushed: number[] = [];
  const c = new WheelCoalescer(50, (w) => flushed.push(w.deltaY));
  c.flush();
  expect(flushed).toEqual([]);
});

test("undefined modifiers preserve the previously seen modifiers within a burst", () => {
  const flushed: (boolean | undefined)[] = [];
  const c = new WheelCoalescer(100, (w) => flushed.push(w.modifiers?.shift));

  c.queue(0, 0, 0, 1, { shift: true });
  // Second event omits modifiers → first event's modifiers are retained.
  c.queue(0, 0, 0, 1);
  c.flush();

  expect(flushed).toEqual([true]);
});

test("dispose cancels the armed timer and drops pending state", async () => {
  const flushed: number[] = [];
  const c = new WheelCoalescer(100, (w) => flushed.push(w.deltaY));

  c.queue(0, 0, 0, 5);
  c.dispose();
  await Bun.sleep(120);

  expect(flushed).toEqual([]);
});
