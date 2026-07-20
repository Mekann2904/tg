import type { BrowserSize, Config, Placement, TerminalSize } from "./types";

/** Fallback cell size in terminal pixels when the terminal does not report one. */
const DEFAULT_CELL_WIDTH_PX = 10;
const DEFAULT_CELL_HEIGHT_PX = 20;

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

  /** Resolved cell width in terminal pixels, derived from the current terminal size. */
  private get cellWidth(): number {
    const termPixelW = this.terminal.pixelWidth ?? this.terminal.cols * DEFAULT_CELL_WIDTH_PX;
    return termPixelW / Math.max(1, this.terminal.cols);
  }

  private get cellHeight(): number {
    const termPixelH = this.terminal.pixelHeight ?? this.terminal.rows * DEFAULT_CELL_HEIGHT_PX;
    return termPixelH / Math.max(1, this.terminal.rows);
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
    return {
      col: clamp(Math.floor((pixelX - 1) / Math.max(1, this.cellWidth)) + 1, 1, this.terminal.cols),
      row: clamp(Math.floor((pixelY - 1) / Math.max(1, this.cellHeight)) + 1, 1, this.terminal.rows),
    };
  }

  /** Convert terminal pixel coordinates (sgr-pixel mode) to browser CSS pixels. */
  terminalPixelToBrowserPixel(pixelX: number, pixelY: number) {
    const viewportPixelW = this.place.cols * this.cellWidth;
    const viewportPixelH = this.place.rows * this.cellHeight;

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

    // CEF view dimensions are CSS pixels (DIPs); OnPaint multiplies them by
    // devicePixelRatio to produce the physical bitmap consumed by Kitty.
    const dpr = Math.max(0.5, devicePixelRatio);
    const terminalPixelWidth = this.cellWidth * this.terminal.cols;
    const terminalPixelHeight = this.cellHeight * this.terminal.rows;
    const cssWidth = Math.round((terminalPixelWidth / dpr) * this.config.viewportScale * this.config.displayScale);
    const cssHeight = Math.round((terminalPixelHeight / dpr) * this.config.viewportScale * this.config.displayScale);

    const fitted = fitInside(
      this.config.width ?? cssWidth,
      this.config.height ?? cssHeight,
      this.config.maxWidth || cssWidth,
      this.config.maxHeight || cssHeight,
    );

    this.browser = fitted;
    this.place = this.computePlacement();

    return this.browser;
  }

  private computePlacement(): Placement {
    const maxCols = Math.max(1, Math.floor(this.terminal.cols * this.config.displayScale));
    const maxRows = Math.max(1, Math.floor(this.terminal.rows * this.config.displayScale));

    const browserRatio = this.browser.width / this.browser.height;
    const placementRatio = (maxCols * this.cellWidth) / (maxRows * this.cellHeight);

    let cols = maxCols;
    let rows = maxRows;

    if (placementRatio > browserRatio) {
      cols = Math.max(1, Math.round((rows * this.cellHeight * browserRatio) / this.cellWidth));
    } else {
      rows = Math.max(1, Math.round((cols * this.cellWidth) / browserRatio / this.cellHeight));
    }

    const xCell = Math.max(1, Math.floor((this.terminal.cols - cols) / 2) + 1);
    const yCell = Math.max(1, Math.floor((this.terminal.rows - rows) / 2) + 1);

    return {
      xCell,
      yCell,
      cols,
      rows,
      // Actual destination size in terminal pixels. Raw image sources should aim
      // to match this size exactly; otherwise Kitty has to resample and text
      // becomes visibly soft on macOS/Retina.
      pixelWidth: Math.max(1, Math.round(cols * this.cellWidth)),
      pixelHeight: Math.max(1, Math.round(rows * this.cellHeight)),
      xPixel: Math.round((xCell - 1) * this.cellWidth),
      yPixel: Math.round((yCell - 1) * this.cellHeight),
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
