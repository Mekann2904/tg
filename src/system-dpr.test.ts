import { expect, test } from "bun:test";
import { findPlatformWindowId, resolveSystemDpr } from "./system-dpr";

test("explicit DPR overrides OS detection", () => {
  expect(resolveSystemDpr("1.5", "darwin")).toBe(1.5);
});

test("invalid DPR falls back to standard density off macOS", () => {
  expect(resolveSystemDpr("invalid", "linux")).toBe(1);
  expect(resolveSystemDpr("8", "linux")).toBe(1);
});

test("Kitty terminal window maps to its native platform window", () => {
  const listing = [{
    platform_window_id: 321,
    tabs: [{ windows: [{ id: 7 }, { id: 9 }] }],
  }];
  expect(findPlatformWindowId(listing, 9)).toBe(321);
  expect(findPlatformWindowId(listing, 10)).toBeNull();
});

test("macOS DPR is read from the current Kitty display or CoreGraphics fallback", () => {
  if (process.platform !== "darwin") return;
  const dpr = resolveSystemDpr(undefined, "darwin");
  expect(dpr).toBeGreaterThanOrEqual(1);
  expect(dpr).toBeLessThanOrEqual(4);
});
