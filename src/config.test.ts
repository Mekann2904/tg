import { expect, test } from "bun:test";
import { parseConfig } from "./config";

test("default and explicit 60 fps produce identical frame settings", () => {
  const defaults = parseConfig(["https://example.com"]);
  const explicit = parseConfig(["https://example.com", "--fps=60", "--capture-fps=60"]);

  expect({ fps: defaults.fps, captureFps: defaults.captureFps }).toEqual({ fps: 60, captureFps: 60 });
  expect({ fps: defaults.fps, captureFps: defaults.captureFps }).toEqual({
    fps: explicit.fps,
    captureFps: explicit.captureFps,
  });
});

test("stable profile defaults capture rate to 30 fps", () => {
  const config = parseConfig(["https://example.com", "--site-profile=stable"]);
  expect({ fps: config.fps, captureFps: config.captureFps }).toEqual({ fps: 60, captureFps: 30 });
});
