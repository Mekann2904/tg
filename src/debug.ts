import { appendFileSync } from "node:fs";

export const DEBUG_LOG_PATH = process.env.KITTY_WEBVIEW_DEBUG_LOG || "/tmp/kitty-webview-debug.log";

type DebugSink = "file" | "stderr" | "none";

function noDiskMode() {
  return process.env.KITTY_WEB_UI_NO_DISK === "1" ||
    process.env.KITTY_WEB_UI_NO_DISK === "true" ||
    process.env.KITTY_WEB_UI_NO_DISK === "yes";
}

function debugSink(): DebugSink {
  const value = process.env.KITTY_WEB_UI_DEBUG_SINK;
  if (value === "file" || value === "stderr" || value === "none") return value;

  // In no-disk mode, do not silently write debug logs to /tmp. Users can still
  // opt into stderr with KITTY_WEB_UI_DEBUG_SINK=stderr.
  if (noDiskMode()) return "none";

  return "file";
}

export function debugLog(enabled: boolean, message: string) {
  if (!enabled) return;
  const line = `${new Date().toISOString()} ${message}\n`;
  writeDebugBytes(enabled, Buffer.from(line));
}

export function writeDebugBytes(enabled: boolean, bytes: Buffer) {
  if (!enabled) return;

  const sink = debugSink();
  if (sink === "none") return;

  if (sink === "stderr") {
    try { process.stderr.write(bytes); } catch {}
    return;
  }

  appendFileSync(DEBUG_LOG_PATH, bytes);
}
