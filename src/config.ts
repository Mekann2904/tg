import type { Config } from "./types";

export const defaultConfig: Omit<Config, "url"> = {
  maxWidth: 0,
  maxHeight: 0,
  fps: 60,
  captureFps: undefined,
  siteProfile: "default",
  viewportScale: 1,
  displayScale: 1,
  resizeDebounceMs: 300,
  scrollCoalesceMs: 8,
  pageZoom: 1,
  userAgent: undefined,
  useAltScreen: true,
  hideCursor: true,
  mouseMode: "sgr-pixel",
  quitKeys: ["ctrl-c", "ctrl-q"],
  debug: false,
  cefControlPreset: undefined,
  nativeResolution: false,
};

export function parseConfig(args: string[]): Config {
  const [urlArg, ...rest] = args;
  if (!urlArg || urlArg.startsWith("-")) usage();

  const config: Config = { ...defaultConfig, url: urlArg };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);

    const [rawKey, inlineValue] = arg.split("=", 2);
    const key = rawKey.replace(/^--/, "");
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) return undefined;
      i++;
      return next;
    };

    switch (key) {
      case "width":
        config.width = parsePositiveInt(takeValue(), key);
        break;
      case "height":
        config.height = parsePositiveInt(takeValue(), key);
        break;
      case "fps":
        config.fps = parsePositiveInt(takeValue(), key);
        break;
      case "capture-fps":
        config.captureFps = parsePositiveInt(takeValue(), key);
        break;
      case "site-profile":
        config.siteProfile = enumValue(takeValue(), ["default", "stable"], key) as Config["siteProfile"];
        break;
      case "scale":
      case "viewport-scale":
        config.viewportScale = parseScale(takeValue(), key);
        break;
      case "zoom":
      case "page-zoom":
        config.pageZoom = parseScale(takeValue(), key);
        break;
      case "user-agent":
        config.userAgent = takeValue();
        if (!config.userAgent) throw new Error("--user-agent requires a value");
        break;
      case "debug":
        config.debug = true;
        break;
      case "cef-control":
        config.cefControlPreset = enumValue(takeValue(), ["basic", "semantic", "devtools", "full"], key) as Config["cefControlPreset"];
        break;
      case "no-alt-screen":
        config.useAltScreen = false;
        break;
      case "mouse-mode":
        config.mouseMode = enumValue(takeValue(), ["cell", "sgr", "sgr-pixel"], key) as Config["mouseMode"];
        break;
      case "max-width":
        config.maxWidth = parsePositiveInt(takeValue(), key);
        break;
      case "max-height":
        config.maxHeight = parsePositiveInt(takeValue(), key);
        break;
      case "display-scale":
        config.displayScale = parseScale(takeValue(), key, 1);
        break;
      case "resize-debounce":
        config.resizeDebounceMs = parsePositiveInt(takeValue(), key);
        break;
      case "scroll-coalesce-ms":
        config.scrollCoalesceMs = parseNonNegativeInt(takeValue(), key);
        break;
      case "native":
        config.nativeResolution = true;
        break;
      case "allow-http":
        config.allowHttp = true;
        break;
      case "quit-keys": {
        const value = takeValue();
        if (!value) throw new Error("--quit-keys requires a comma-separated value");
        config.quitKeys = value.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
        break;
      }
      case "persist":
        config.persist = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (config.siteProfile === "stable" && config.captureFps === undefined) {
    config.captureFps = Math.min(config.fps, 30);
  }

  return config;
}

function usage(): never {
  throw new Error(
    "Usage: kitty-webview <url> [--cef-control=basic|semantic|devtools|full] [--fps=60] [--capture-fps=N] [--site-profile=default|stable] [--width=N] [--height=N] [--scale=1] [--zoom=1] [--max-width=N] [--max-height=N] [--display-scale=1] [--resize-debounce=300] [--scroll-coalesce-ms=8] [--mouse-mode=sgr|sgr-pixel] [--no-alt-screen] [--quit-keys=ctrl-q] [--debug] [--native] [--user-agent=...]"
  );
}

function parsePositiveInt(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
  return n;
}

function parseNonNegativeInt(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

function parseScale(value: string | undefined, name: string, max = 2): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`--${name} must be > 0 and <= ${max}`);
  return n;
}

function enumValue(value: string | undefined, allowed: string[], name: string): string {
  if (!value || !allowed.includes(value)) throw new Error(`--${name} must be one of: ${allowed.join(", ")}`);
  return value;
}
