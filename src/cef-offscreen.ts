import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types";
import { HelperProcessBrowserController } from "./helper-process-browser";

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

          // One frame in flight, always. Dirty frames are relative to the last
          // delivered frame, so letting the helper outrun Kitty creates gaps no
          // later delta can repair. These match the native defaults (see
          // main.cc enableFrameAck / enableFlowControl / maxUnackedFrames) but
          // are stated here because this controller drives the ACKs.
          KITTY_WEB_UI_CEF_FRAME_ACK: process.env.KITTY_WEB_UI_CEF_FRAME_ACK ?? "1",
          KITTY_WEB_UI_CEF_FLOW_CONTROL: process.env.KITTY_WEB_UI_CEF_FLOW_CONTROL ?? "1",
          KITTY_WEB_UI_CEF_MAX_UNACKED_FRAMES: process.env.KITTY_WEB_UI_CEF_MAX_UNACKED_FRAMES ?? "1",
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
