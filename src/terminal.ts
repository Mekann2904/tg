import type { BrowserCursorShape, BrowserHitTest, Config, TerminalSize } from "./types";

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CURSOR_SHAPE_BLOCK = "\x1b[2 q";
const CURSOR_SHAPE_BAR = "\x1b[6 q";
const CURSOR_SHAPE_UNDERLINE = "\x1b[4 q";
const CLEAR = "\x1b[2J\x1b[H";
const MOUSE_BASE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h";
const MOUSE_SGR = "\x1b[?1006h";
const MOUSE_PIXEL = "\x1b[?1016h";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l";
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
// Kitty keyboard protocol is useful for disambiguating modified keys, but it
// breaks IME text composition in many terminal setups. Keep it opt-in so
// committed Japanese text arrives as normal UTF-8 text.
const KITTY_KEYBOARD_ON = "\x1b[>9u";
const KITTY_KEYBOARD_OFF = "\x1b[<u";

export class TerminalController {
  private inputHandlers: ((bytes: Buffer) => void | Promise<void>)[] = [];
  private resizeHandlers: ((size: TerminalSize) => void | Promise<void>)[] = [];
  private done!: Promise<void>;
  private resolveDone!: () => void;
  private left = false;
  private queryBuffer = "";
  private pendingPixelQuery?: (size: { width: number; height: number } | null) => void;
  private pixelQuery?: Promise<{ width: number; height: number } | null>;
  private suppressInputUntil = 0;
  private resizeTimer?: Timer;
  private pageCursor: BrowserCursorShape = "default";
  private hitTest: BrowserHitTest | null = null;
  private pointerCell: { col: number; row: number } | null = null;

  constructor(private config: Config) {}

  enter() {
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
    if (this.config.useAltScreen) process.stdout.write(ALT_SCREEN_ON);
    process.stdout.write(CLEAR);
    if (this.config.hideCursor) process.stdout.write(CURSOR_HIDE);
    else process.stdout.write(CURSOR_SHAPE_BLOCK);
    process.stdout.write(MOUSE_BASE);
    process.stdout.write(MOUSE_SGR);
    if (this.config.mouseMode === "sgr-pixel") process.stdout.write(MOUSE_PIXEL);
    process.stdout.write(BRACKETED_PASTE_ON);
    if (process.env.KITTY_WEB_UI_KITTY_KEYBOARD === "1") process.stdout.write(KITTY_KEYBOARD_ON);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", this.handleData);
    }
    process.on("SIGINT", this.handleSigint);
    process.on("SIGTERM", this.handleSigterm);
    process.on("SIGWINCH", this.handleResize);
    process.stdout.on("resize", this.handleResize);
  }

  leave() {
    if (this.left) return;
    this.left = true;
    process.stdin.off("data", this.handleData);
    process.stdout.off("resize", this.handleResize);
    process.off("SIGINT", this.handleSigint);
    process.off("SIGTERM", this.handleSigterm);
    process.off("SIGWINCH", this.handleResize);
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = undefined;
    }
    if (this.pendingPixelQuery) {
      const resolve = this.pendingPixelQuery;
      this.pendingPixelQuery = undefined;
      this.pixelQuery = undefined;
      this.queryBuffer = "";
      resolve(null);
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    if (process.env.KITTY_WEB_UI_KITTY_KEYBOARD === "1") process.stdout.write(KITTY_KEYBOARD_OFF);
    process.stdout.write(BRACKETED_PASTE_OFF);
    process.stdout.write(MOUSE_OFF);
    process.stdout.write(CURSOR_SHAPE_BLOCK + CURSOR_SHOW);
    process.stdout.write("\x1b[0m");
    if (this.config.useAltScreen) process.stdout.write(ALT_SCREEN_OFF);
    this.resolveDone?.();
  }

  onInput(fn: (bytes: Buffer) => void | Promise<void>) {
    this.inputHandlers.push(fn);
  }

  onResize(fn: (size: TerminalSize) => void | Promise<void>) {
    this.resizeHandlers.push(fn);
  }

  async currentSize(): Promise<TerminalSize> {
    const cols = process.stdout.columns ?? 100;
    const rows = process.stdout.rows ?? 30;
    const pixels = await this.queryPixelSize(cols, rows);
    return {
      cols,
      rows,
      pixelWidth: pixels?.width,
      pixelHeight: pixels?.height,
    };
  }

  async queryPixelSize(cols = process.stdout.columns ?? 100, rows = process.stdout.rows ?? 30, timeoutMs = 150): Promise<{ width: number; height: number } | null> {
    if (!process.stdin.isTTY) return null;
    if (this.pixelQuery) return await this.pixelQuery;
    this.pixelQuery = new Promise((resolve) => {
      this.pendingPixelQuery = resolve;
      // 16t asks for terminal cell size in pixels: CSI 6 ; height ; width t.
      // Multiplying by cols/rows gives the exact drawable cell grid size, avoiding
      // blurry Kitty scaling caused by 14t window-size replies that can include
      // padding or logical/points dimensions on macOS. 14t remains a fallback.
      process.stdout.write("\x1b[16t\x1b[14t");
      setTimeout(() => {
        if (this.pendingPixelQuery === resolve) {
          const fallback = parseTerminalPixelReply(this.queryBuffer, cols, rows);
          this.pendingPixelQuery = undefined;
          this.pixelQuery = undefined;
          this.queryBuffer = "";
          resolve(fallback);
        }
      }, timeoutMs);
    });
    return await this.pixelQuery;
  }

  setPointerCursorPosition(col: number, row: number) {
    this.pointerCell = { col: Math.max(1, Math.round(col)), row: Math.max(1, Math.round(row)) };
    this.refreshCursorOverlay();
  }

  setPageCursorShape(cursor: BrowserCursorShape) {
    this.pageCursor = cursor;
    this.refreshCursorOverlay();
  }

  setHitTest(hit: BrowserHitTest | null) {
    this.hitTest = hit;
    if (hit?.cursor) this.pageCursor = hit.cursor;
    this.refreshCursorOverlay();
  }

  refreshCursorOverlay() {
    if (this.left) return;

    const cursor = this.hitTest?.cursor ?? this.pageCursor;
    if (cursor === "text" && this.pointerCell) {
      process.stdout.write(`${CURSOR_SHAPE_BAR}\x1b[${this.pointerCell.row};${this.pointerCell.col}H${CURSOR_SHOW}`);
      return;
    }

    if ((cursor === "pointer" || cursor === "grab" || cursor === "grabbing") && this.pointerCell && !this.config.hideCursor) {
      process.stdout.write(`${CURSOR_SHAPE_UNDERLINE}\x1b[${this.pointerCell.row};${this.pointerCell.col}H${CURSOR_SHOW}`);
      return;
    }

    process.stdout.write(this.config.hideCursor ? CURSOR_HIDE : `${CURSOR_SHAPE_BLOCK}${CURSOR_SHOW}`);
  }

  wait() {
    return this.done;
  }

  requestExit() {
    this.resolveDone?.();
  }

  private handleData = (bytes: Buffer) => {
    if (this.pendingPixelQuery) {
      this.queryBuffer += bytes.toString("utf8");
      const cols = process.stdout.columns ?? 100;
      const rows = process.stdout.rows ?? 30;
      const pixels = parseTerminalPixelReply(this.queryBuffer, cols, rows, true);
      if (pixels) {
        const resolve = this.pendingPixelQuery;
        this.pendingPixelQuery = undefined;
        this.pixelQuery = undefined;
        this.queryBuffer = "";
        this.suppressInputUntil = performance.now() + 50;
        resolve(pixels);
        return;
      }
      // Do not feed terminal query replies into the normal input parser.
      // User input during the short query window is intentionally swallowed.
      return;
    }

    if (performance.now() < this.suppressInputUntil) {
      return;
    }

    for (const fn of this.inputHandlers) void fn(bytes);
  };

  private handleResize = () => {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);

    this.resizeTimer = setTimeout(() => {
      void (async () => {
        const size = await this.currentSize();
        for (const fn of this.resizeHandlers) void fn(size);
      })();
    }, this.config.resizeDebounceMs);
  };

  private handleSigint = () => this.requestExit();
  private handleSigterm = () => this.requestExit();
}

function parseTerminalPixelReply(buffer: string, cols: number, rows: number, requireCellSize = false): { width: number; height: number } | null {
  // CSI 6 ; height ; width t: cell size in pixels. Prefer this for Kitty image
  // placement because images are positioned in terminal cells.
  const cell = buffer.match(/\x1b\[6;(\d+);(\d+)t/);
  if (cell) {
    const cellHeight = Number(cell[1]);
    const cellWidth = Number(cell[2]);
    if (cellWidth > 0 && cellHeight > 0) {
      return { width: Math.round(cellWidth * cols), height: Math.round(cellHeight * rows) };
    }
  }

  if (requireCellSize) return null;

  // CSI 4 ; height ; width t: window/text area size in pixels. Some macOS
  // terminal replies are less useful for exact cell-grid image placement, so this
  // is only a fallback when 16t is unavailable.
  const area = buffer.match(/\x1b\[4;(\d+);(\d+)t/);
  if (area) {
    const height = Number(area[1]);
    const width = Number(area[2]);
    if (width > 0 && height > 0) return { width, height };
  }

  return null;
}
