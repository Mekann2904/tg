import { test, expect } from "bun:test";
import { ResizeCoordinator } from "./resize-coordinator";

test("debounceMs=0 fires runBatch synchronously on request", () => {
  let calls = 0;
  const c = new ResizeCoordinator(0, () => {
    calls++;
    return Promise.resolve();
  });
  c.request({ cols: 80, rows: 24 });
  expect(calls).toBe(1);
});

test("multiple requests within the debounce window fire one batch", async () => {
  let calls = 0;
  const c = new ResizeCoordinator(30, () => {
    calls++;
    return Promise.resolve();
  });
  c.request({ cols: 80, rows: 24 });
  c.request({ cols: 100, rows: 30 });
  c.request({ cols: 120, rows: 40 });

  expect(calls).toBe(0);
  await Bun.sleep(50);
  expect(calls).toBe(1);
});

test("a trailing burst after the first window fires a second batch", async () => {
  let calls = 0;
  const c = new ResizeCoordinator(30, () => {
    calls++;
    return Promise.resolve();
  });
  c.request({ cols: 80, rows: 24 });
  await Bun.sleep(50);
  expect(calls).toBe(1);

  c.request({ cols: 100, rows: 30 });
  c.request({ cols: 120, rows: 40 });
  await Bun.sleep(50);
  expect(calls).toBe(2);
});

test("take returns the latest size and drains the pending slot", () => {
  const c = new ResizeCoordinator(0, () => Promise.resolve());
  c.request({ cols: 80, rows: 24 });
  c.request({ cols: 100, rows: 30 });
  expect(c.take()).toEqual({ cols: 100, rows: 30 });
  expect(c.take()).toBeNull();
});

test("a batch absorbs a burst by draining take() until null", async () => {
  const cols: number[] = [];
  const c = new ResizeCoordinator(30, async () => {
    let s;
    while ((s = c.take())) cols.push(s.cols);
  });
  c.request({ cols: 80, rows: 24 });
  c.request({ cols: 100, rows: 30 });
  c.request({ cols: 120, rows: 40 });
  await Bun.sleep(50);

  // Only the latest size in the burst is seen by the batch.
  expect(cols).toEqual([120]);
});

test("a request arriving during a running batch re-arms after settle", async () => {
  const cols: number[] = [];
  let resolveBatch: (() => void) | undefined;
  const c = new ResizeCoordinator(20, () => {
    return new Promise<void>((resolve) => {
      resolveBatch = resolve;
    }).then(async () => {
      let s;
      while ((s = c.take())) cols.push(s.cols);
    });
  });

  c.request({ cols: 80, rows: 24 });
  await Bun.sleep(40); // batch 1 is now running and awaiting resolveBatch
  expect(cols).toEqual([]);

  c.request({ cols: 100, rows: 30 }); // arrives mid-batch
  resolveBatch?.();
  await Bun.sleep(50); // settle + debounce + batch 2

  expect(cols).toEqual([100]);
});

test("onSettled fires once after each batch completes", async () => {
  const settled: number[] = [];
  let n = 0;
  const c = new ResizeCoordinator(
    20,
    () => {
      n++;
      return Promise.resolve();
    },
    () => settled.push(n),
  );
  c.request({ cols: 80, rows: 24 });
  await Bun.sleep(40);
  c.request({ cols: 100, rows: 30 });
  await Bun.sleep(40);

  expect(settled).toEqual([1, 2]);
});

test("dispose cancels the armed timer and ignores later requests", async () => {
  let calls = 0;
  const c = new ResizeCoordinator(100, () => {
    calls++;
    return Promise.resolve();
  });
  c.request({ cols: 80, rows: 24 });
  c.dispose();
  await Bun.sleep(120);
  expect(calls).toBe(0);

  c.request({ cols: 100, rows: 30 });
  await Bun.sleep(120);
  expect(calls).toBe(0);
});
