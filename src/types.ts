export interface Config {
  url: string;
  width?: number;
  height?: number;
  /** 0 = auto (terminal pixel dimensions) */
  maxWidth: number;
  /** 0 = auto (terminal pixel dimensions) */
  maxHeight: number;
  fps: number;
  captureFps?: number;
  siteProfile: "default" | "stable";
  viewportScale: number;
  displayScale: number;
  resizeDebounceMs: number;
  scrollCoalesceMs: number;
  pageZoom: number;
  userAgent?: string;
  useAltScreen: boolean;
  hideCursor: boolean;
  mouseMode: "cell" | "sgr" | "sgr-pixel";
  quitKeys: string[];
  debug: boolean;
  cefControlPreset?: "basic" | "semantic" | "devtools" | "full";
  allowHttp?: boolean;
  persist?: boolean;
}

export type BrowserKey = string;

export interface KeyModifiers {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export type MouseButton = "left" | "middle" | "right" | "back" | "forward" | "none";
export type BrowserCursorShape = "default" | "text" | "pointer" | "crosshair" | "grab" | "grabbing" | "none";

export interface BrowserHitTest {
  x: number;
  y: number;
  cursor: BrowserCursorShape;
  editable: boolean;
  clickable: boolean;
  selectable: boolean;
  tag?: string;
  role?: string;
  type?: string;
  label?: string;
}

export type InputEvent =
  | { type: "noop" }
  | { type: "exit" }
  | { type: "text"; text: string }
  | { type: "key"; key: BrowserKey; modifiers?: KeyModifiers }
  | {
      type: "mouse";
      action: "press" | "release" | "move" | "wheel";
      button?: MouseButton;
      col: number;
      row: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: KeyModifiers;
    };

export type PixelFormat = "rgba" | "rgb";

export type ScreenshotFrame = {
  seq?: number;
  path: string;
  byteLength: number;
  width: number;
  height: number;
  format: PixelFormat;
  dirty?: DirtyRect;
};

export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TerminalSize {
  cols: number;
  rows: number;
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface BrowserSize {
  width: number;
  height: number;
}

export interface Placement {
  xCell: number;
  yCell: number;
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
  /** pixel offset of the viewport top-left from terminal cell (1,1) */
  xPixel: number;
  yPixel: number;
}

export class ExitSignal extends Error {
  constructor() {
    super("exit requested");
  }
}
