import type { BrowserCursorShape, BrowserHitTest, BrowserSize, Config } from "./types";
import type { InboundFrame } from "./frame-source";
import { CefBrowserController } from "./cef-offscreen";

export interface BrowserController {
  open(initialSize?: BrowserSize): Promise<void>;
  close(): Promise<void>;
  click(x: number, y: number): Promise<void>;
  mouseDown(x: number, y: number, button: import("./types").MouseButton, modifiers?: import("./types").KeyModifiers): Promise<void>;
  mouseUp(x: number, y: number, button: import("./types").MouseButton, modifiers?: import("./types").KeyModifiers): Promise<void>;
  mouseMove(x: number, y: number, button?: import("./types").MouseButton, modifiers?: import("./types").KeyModifiers): Promise<void>;
  wheel(x: number, y: number, deltaX: number, deltaY: number, modifiers?: import("./types").KeyModifiers): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string, modifiers?: import("./types").KeyModifiers): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  devicePixelRatio(): Promise<number>;
  applyPageZoom(): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  ackFrame?(seq: number): void;
  onRawFrame?: (frame: InboundFrame) => void;
  onCursorChange?: (cursor: BrowserCursorShape) => void;
  onHitTest?: (hit: BrowserHitTest) => void;
}

export function createBrowserController(config: Config): BrowserController {
  return new CefBrowserController(config) as any;
}
