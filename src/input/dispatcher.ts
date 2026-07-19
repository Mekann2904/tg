import type { InputEvent } from "../types";
import type { BrowserController } from "../browser";
import type { ViewportMapper } from "../viewport";

export async function dispatchInput(event: InputEvent, webview: BrowserController, viewport: ViewportMapper, pixelMode = false) {
  switch (event.type) {
    case "noop":
      return;
    case "exit":
      return;
    case "text":
      await webview.type(event.text);
      return;
    case "key":
      await webview.press(event.key, event.modifiers);
      return;
    case "mouse": {
      const { x, y } = pixelMode
        ? viewport.terminalPixelToBrowserPixel(event.col, event.row)
        : viewport.terminalCellToBrowserPixel(event.col, event.row);
      if (event.action === "wheel") return webview.wheel(x, y, event.deltaX ?? 0, event.deltaY ?? 0, event.modifiers);
      if (event.action === "move") return webview.mouseMove(x, y, event.button, event.modifiers);
      if (event.action === "press") return webview.mouseDown(x, y, event.button ?? "left", event.modifiers);
      if (event.action === "release") return webview.mouseUp(x, y, event.button ?? "none", event.modifiers);
    }
  }
}
