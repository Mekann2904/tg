import type { BrowserSize, Config, Placement, TerminalSize } from "./types";

export class ViewportMapper {
  private terminal: TerminalSize;
  private browser: BrowserSize;
  private place: Placement;

  constructor(private config: Config) {
    this.terminal = {
      cols: process.stdout.columns ?? 100,
      rows: process.stdout.rows ?? 30,
    };

    this.browser = {
      width: config.width ?? Math.min(config.maxWidth, 1000),
      height: config.height ?? Math.min(config.maxHeight, 600),
    };

    this.place = this.computePlacement();
  }

  placement(): Placement {
    return this.place;
  }

  terminalCellToBrowserPixel(col: number, row: number) {
    const relCol = col - this.place.xCell;
    const relRow = row - this.place.yCell;

    const x = (relCol / Math.max(1, this.place.cols)) * this.browser.width;
    const y = (relRow / Math.max(1, this.place.rows)) * this.browser.height;

    return {
      x: clamp(Math.round(x), 0, this.browser.width - 1),
      y: clamp(Math.round(y), 0, this.browser.height - 1),
    };
  }

  /** Convert terminal pixel coordinates (sgr-pixel mode) to terminal cell coordinates. */
  terminalPixelToCell(pixelX: number, pixelY: number) {
    const termPixelW = this.terminal.pixelWidth ?? this.terminal.cols * 10;
    const termPixelH = this.terminal.pixelHeight ?? this.terminal.rows * 20;
    const cw = termPixelW / Math.max(1, this.terminal.cols);
    const ch = termPixelH / Math.max(1, this.terminal.rows);

    return {
      col: clamp(Math.floor((pixelX - 1) / Math.max(1, cw)) + 1, 1, this.terminal.cols),
      row: clamp(Math.floor((pixelY - 1) / Math.max(1, ch)) + 1, 1, this.terminal.rows),
    };
  }

  /** Convert terminal pixel coordinates (sgr-pixel mode) to browser CSS pixels. */
  terminalPixelToBrowserPixel(pixelX: number, pixelY: number) {
    const termPixelW = this.terminal.pixelWidth ?? this.terminal.cols * 10;
    const termPixelH = this.terminal.pixelHeight ?? this.terminal.rows * 20;
    const cw = termPixelW / Math.max(1, this.terminal.cols);
    const ch = termPixelH / Math.max(1, this.terminal.rows);

    const viewportPixelW = this.place.cols * cw;
    const viewportPixelH = this.place.rows * ch;

    // SGR pixel mouse coordinates are 1-based, like cell SGR coordinates.
    const relX = pixelX - 1 - this.place.xPixel;
    const relY = pixelY - 1 - this.place.yPixel;

    const x = (relX / Math.max(1, viewportPixelW)) * this.browser.width;
    const y = (relY / Math.max(1, viewportPixelH)) * this.browser.height;

    return {
      x: clamp(Math.round(x), 0, this.browser.width - 1),
      y: clamp(Math.round(y), 0, this.browser.height - 1),
    };
  }

  resize(size: TerminalSize, devicePixelRatio = 1): BrowserSize {
    this.terminal = size;

    const estimatedCellWidth = 10;
    const estimatedCellHeight = 20;
    const terminalPixelWidth = size.pixelWidth ?? Math.round(size.cols * estimatedCellWidth);
    const terminalPixelHeight = size.pixelHeight ?? Math.round(size.rows * estimatedCellHeight);

    // Use terminal physical pixels as browser CSS size for 1:1 bitmap→Kitty mapping.
    // Retina displays need full physical resolution; CEF offscreen paint always
    // produces CSS-resolution bitmaps, so CSS must match the target physical size.
    const cssWidth = Math.round(terminalPixelWidth * this.config.viewportScale * this.config.displayScale);
    const cssHeight = Math.round(terminalPixelHeight * this.config.viewportScale * this.config.displayScale);

    const fitted = fitInside(
      this.config.width ?? cssWidth,
      this.config.height ?? cssHeight,
      this.config.maxWidth || terminalPixelWidth,
      this.config.maxHeight || terminalPixelHeight,
    );

    this.browser = fitted;
    this.place = this.computePlacement();

    return this.browser;
  }

  private computePlacement(): Placement {
    const maxCols = Math.max(1, Math.floor(this.terminal.cols * this.config.displayScale));
    const maxRows = Math.max(1, Math.floor(this.terminal.rows * this.config.displayScale));

    const terminalPixelWidth = this.terminal.pixelWidth ?? this.terminal.cols * 10;
    const terminalPixelHeight = this.terminal.pixelHeight ?? this.terminal.rows * 20;
    const cellWidth = terminalPixelWidth / Math.max(1, this.terminal.cols);
    const cellHeight = terminalPixelHeight / Math.max(1, this.terminal.rows);

    const browserRatio = this.browser.width / this.browser.height;
    const placementRatio = (maxCols * cellWidth) / (maxRows * cellHeight);

    let cols = maxCols;
    let rows = maxRows;

    if (placementRatio > browserRatio) {
      cols = Math.max(1, Math.round((rows * cellHeight * browserRatio) / cellWidth));
    } else {
      rows = Math.max(1, Math.round((cols * cellWidth) / browserRatio / cellHeight));
    }

    const xCell = Math.max(1, Math.floor((this.terminal.cols - cols) / 2) + 1);
    const yCell = Math.max(1, Math.floor((this.terminal.rows - rows) / 2) + 1);

    // estimate pixel offset of viewport top-left from terminal cell (1,1)
    const termPixelW = this.terminal.pixelWidth ?? this.terminal.cols * 10;
    const termPixelH = this.terminal.pixelHeight ?? this.terminal.rows * 20;
    const cw = termPixelW / Math.max(1, this.terminal.cols);
    const ch = termPixelH / Math.max(1, this.terminal.rows);
    const xPixel = Math.round((xCell - 1) * cw);
    const yPixel = Math.round((yCell - 1) * ch);

    return {
      xCell,
      yCell,
      cols,
      rows,
      // Actual destination size in terminal pixels. Raw image sources should aim
      // to match this size exactly; otherwise Kitty has to resample and text
      // becomes visibly soft on macOS/Retina.
      pixelWidth: Math.max(1, Math.round(cols * cw)),
      pixelHeight: Math.max(1, Math.round(rows * ch)),
      xPixel,
      yPixel,
    };
  }
}

function fitInside(width: number, height: number, maxWidth: number, maxHeight: number): BrowserSize {
  const ratio = Math.min(maxWidth / width, maxHeight / height, 1);

  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
