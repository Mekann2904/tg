import { expect, test } from "bun:test";
import { defaultConfig } from "./config";
import { ViewportMapper } from "./viewport";

test("HiDPI keeps CSS geometry logical while placement uses physical pixels", () => {
  const mapper = new ViewportMapper({ ...defaultConfig, url: "https://example.com" });

  const browser = mapper.resize(
    { cols: 180, rows: 50, pixelWidth: 1800, pixelHeight: 1000 },
    2,
  );

  expect(browser).toEqual({ width: 900, height: 500 });
  expect(mapper.placement()).toMatchObject({
    cols: 180,
    rows: 50,
    pixelWidth: 1800,
    pixelHeight: 1000,
  });
  expect(mapper.terminalCellToBrowserPixel(91, 26)).toEqual({ x: 450, y: 250 });
});

test("standard DPI keeps CSS and physical bitmap sizes equal", () => {
  const mapper = new ViewportMapper({ ...defaultConfig, url: "https://example.com" });

  const browser = mapper.resize(
    { cols: 90, rows: 30, pixelWidth: 900, pixelHeight: 600 },
    1,
  );

  expect(browser).toEqual({ width: 900, height: 600 });
  expect(mapper.placement()).toMatchObject({ pixelWidth: 900, pixelHeight: 600 });
});
