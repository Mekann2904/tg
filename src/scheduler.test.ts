import { expect, test } from "bun:test";
import { FramePump } from "./scheduler";

test("FramePump dirty mode renders immediately on request", async () => {
  const pump = new FramePump(1, "dirty");
  let renders = 0;

  pump.onRender(async () => {
    renders++;
  });

  pump.start();
  pump.request("external");
  await Bun.sleep(1);
  pump.stop();

  expect(renders).toBe(1);
});

test("FramePump renders again when a request arrives during an active render", async () => {
  const pump = new FramePump(60, "dirty");
  let renders = 0;
  let releaseFirstRender!: () => void;
  const firstRenderDone = new Promise<void>((resolve) => {
    releaseFirstRender = resolve;
  });

  pump.onRender(async () => {
    renders++;
    if (renders === 1) {
      pump.request("input");
      await firstRenderDone;
    }
  });

  pump.start();
  pump.request("start");
  await Bun.sleep(10);
  expect(renders).toBe(1);

  releaseFirstRender();

  for (let i = 0; i < 10 && renders < 2; i++) {
    await Bun.sleep(10);
  }

  pump.stop();
  expect(renders).toBe(2);
});
