import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types";
import { HelperProcessBrowserController } from "./helper-process-browser";

type CefControlPreset = "basic" | "semantic" | "devtools" | "full";

function cefControlPreset(config: Config): CefControlPreset {
  const value = config.cefControlPreset ?? process.env.KITTY_WEB_UI_CEF_CONTROL_PRESET;
  if (value === "basic" || value === "semantic" || value === "devtools" || value === "full") return value;
  return "full";
}

function presetDefault(name: string, enabled: boolean) {
  return process.env[name] ?? (enabled ? "1" : "0");
}

function resolveCefLayerEnv(config: Config): Record<string, string> {
  const preset = cefControlPreset(config);

  const messageRouter =
    preset === "semantic" ||
    preset === "devtools" ||
    preset === "full";

  const devtools =
    preset === "devtools" ||
    preset === "full";

  const devtoolsInput =
    preset === "devtools" ||
    preset === "full";

  const accessibility =
    preset === "full";

  return {
    // Presets:
    //   basic     = CEF OSR + physical input only
    //   semantic  = MessageRouter semantic events only
    //   devtools  = MessageRouter + DevTools + DevTools input
    //   full      = devtools + throttled Accessibility summary
    //
    // Individual env vars still override the preset.
    KITTY_WEB_UI_CEF_MESSAGE_ROUTER: presetDefault("KITTY_WEB_UI_CEF_MESSAGE_ROUTER", messageRouter),
    KITTY_WEB_UI_CEF_DEVTOOLS_LAYER: presetDefault("KITTY_WEB_UI_CEF_DEVTOOLS_LAYER", devtools),
    KITTY_WEB_UI_CEF_INPUT_DEVTOOLS: presetDefault("KITTY_WEB_UI_CEF_INPUT_DEVTOOLS", devtoolsInput),
    KITTY_WEB_UI_CEF_ACCESSIBILITY: presetDefault("KITTY_WEB_UI_CEF_ACCESSIBILITY", accessibility),

    // Current best-known stable profile:
    //   Rust Kitty renderer + CEF full control + throttled semantic hit-test.
    // Cursor shape still comes from CEF OnCursorChange; hit-test is metadata
    // and should not run for every mouse pixel.
    KITTY_WEB_UI_CEF_HITTEST_THROTTLE_MS: process.env.KITTY_WEB_UI_CEF_HITTEST_THROTTLE_MS ?? "75",
    KITTY_WEB_UI_CEF_HITTEST_MIN_DELTA_PX: process.env.KITTY_WEB_UI_CEF_HITTEST_MIN_DELTA_PX ?? "8",

    // Keep exactly one frame in flight. Dirty frames are relative to the last
    // delivered frame, so allowing the helper to outrun Kitty can create gaps
    // that no later delta can repair. ACK is sent after stdout write/drain.
    KITTY_WEB_UI_CEF_FRAME_ACK: process.env.KITTY_WEB_UI_CEF_FRAME_ACK ?? "1",
    KITTY_WEB_UI_CEF_FLOW_CONTROL: process.env.KITTY_WEB_UI_CEF_FLOW_CONTROL ?? "1",
    KITTY_WEB_UI_CEF_MAX_UNACKED_FRAMES: process.env.KITTY_WEB_UI_CEF_MAX_UNACKED_FRAMES ?? "1",

    KITTY_WEB_UI_CEF_ACCESSIBILITY_THROTTLE_MS: process.env.KITTY_WEB_UI_CEF_ACCESSIBILITY_THROTTLE_MS ?? "1000",
  };
}

function resolveCefHelper(): string {
  const env = process.env.KITTY_WEB_UI_CEF_HELPER;
  if (env) return env;
  // On macOS CEF requires an app bundle structure for ICU data resolution.
  // The actual binary lives inside kitty-cef-helper.app/Contents/MacOS/.
  return join(import.meta.dir, "..", "native", "cef-helper", "kitty-cef-helper.app", "Contents", "MacOS", "kitty-cef-helper");
}

export class CefBrowserController extends HelperProcessBrowserController {
  constructor(config: Config) {
    const command = resolveCefHelper();
    if (!existsSync(command)) {
      throw new Error(
        `CEF helper not found at ${command}\n` +
        "Build it first: CEF_ROOT=/path/to/cef_binary_... bun run build:cef\n" +
        "Or set KITTY_WEB_UI_CEF_HELPER to the helper path.",
      );
    }
    super(config, {
      kind: "cef",
      dprEnvName: "KITTY_WEB_UI_CEF_DPR",
      spawn: (ctx) => ({
        command,
        env: {
          // Browser frames are opaque, so RGB24 sounds cheaper (25% less data
          // than RGBA32). But on Apple Silicon the OpenGL/Metal driver stores
          // textures as 32-bit ARGB8, so a 24-bit upload is expanded on the CPU
          // every frame (glgConvertTo_32<BGR8_ARGB8> in profiles), which costs
          // far more than the bytes saved — especially under shm (t=s), where
          // pixels bypass the PTY and bandwidth is not the bottleneck. Default
          // to RGBA32; set KITTY_WEBVIEW_PIXEL_FORMAT=rgb to force 24-bit.
          KITTY_WEBVIEW_PIXEL_FORMAT: process.env.KITTY_WEBVIEW_PIXEL_FORMAT || "rgba",

          ...resolveCefLayerEnv(config),
        },
        args: [
          ctx.url,
          String(ctx.captureFps),
          String(ctx.dpr),
          String(ctx.pageZoom),
          ctx.frameNonce,
          ctx.allowHttp ? "1" : "0",
          ctx.persist ? "1" : "0",
          ctx.debug ? "1" : "0",
          ctx.userAgent,
          ctx.siteProfile,
          String(ctx.width),
          String(ctx.height),
        ],
      }),
    });
  }
}
