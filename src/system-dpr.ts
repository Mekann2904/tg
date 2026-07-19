import { dlopen } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CORE_GRAPHICS = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

/** Resolve the backing scale of the macOS main display from CoreGraphics. */
export function resolveSystemDpr(
  override = process.env.KITTY_WEB_UI_CEF_DPR,
  platform = process.platform,
): number {
  const configured = Number(override ?? "");
  if (Number.isFinite(configured) && configured >= 0.5 && configured <= 4) return configured;
  if (platform !== "darwin") return 1;

  const windowScale = resolveKittyWindowDpr();
  if (windowScale !== null) return windowScale;

  try {
    const graphics = dlopen(CORE_GRAPHICS, {
      CGMainDisplayID: { args: [], returns: "u32" },
      CGDisplayCopyDisplayMode: { args: ["u32"], returns: "ptr" },
      CGDisplayModeGetWidth: { args: ["ptr"], returns: "usize" },
      CGDisplayModeGetPixelWidth: { args: ["ptr"], returns: "usize" },
    });
    const foundation = dlopen(CORE_FOUNDATION, {
      CFRelease: { args: ["ptr"], returns: "void" },
    });

    try {
      const mode = graphics.symbols.CGDisplayCopyDisplayMode(graphics.symbols.CGMainDisplayID());
      if (!mode) return 1;
      try {
        const logicalWidth = Number(graphics.symbols.CGDisplayModeGetWidth(mode));
        const pixelWidth = Number(graphics.symbols.CGDisplayModeGetPixelWidth(mode));
        if (logicalWidth <= 0 || pixelWidth <= 0) return 1;
        return Math.max(0.5, Math.min(4, pixelWidth / logicalWidth));
      } finally {
        foundation.symbols.CFRelease(mode);
      }
    } finally {
      foundation.close();
      graphics.close();
    }
  } catch {
    return 1;
  }
}

function resolveKittyWindowDpr(): number | null {
  const kittyWindowId = Number(process.env.KITTY_WINDOW_ID ?? "");
  if (!Number.isInteger(kittyWindowId) || kittyWindowId <= 0) return null;

  try {
    const listing = spawnSync("kitty", ["@", "ls"], { encoding: "utf8", timeout: 1000 });
    if (listing.status !== 0 || !listing.stdout) return null;
    const platformWindowId = findPlatformWindowId(JSON.parse(listing.stdout), kittyWindowId);
    if (!platformWindowId) return null;

    const runtime = process.env.KITTY_WEB_UI_KITTY_RUNTIME
      || join(import.meta.dir, "..", "native", "kitty-runtime", "target", "release", "kitty-runtime");
    const result = spawnSync(runtime, ["--display-scale", String(platformWindowId)], {
      encoding: "utf8",
      timeout: 1000,
    });
    const scale = Number(result.stdout?.trim());
    return result.status === 0 && Number.isFinite(scale) && scale >= 0.5 && scale <= 4 ? scale : null;
  } catch {
    return null;
  }
}

export function findPlatformWindowId(listing: unknown, kittyWindowId: number): number | null {
  if (!Array.isArray(listing)) return null;
  for (const osWindow of listing) {
    const tabs = Array.isArray(osWindow?.tabs) ? osWindow.tabs : [];
    for (const tab of tabs) {
      const windows = Array.isArray(tab?.windows) ? tab.windows : [];
      if (windows.some((window: any) => Number(window?.id) === kittyWindowId)) {
        const id = Number(osWindow?.platform_window_id);
        return Number.isInteger(id) && id > 0 ? id : null;
      }
    }
  }
  return null;
}
