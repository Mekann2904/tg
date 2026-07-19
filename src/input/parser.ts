import type { InputEvent } from "../types";
import { parseCsiUInput, parseKey } from "./keyboard";
import { parseSgrMouse } from "./mouse";

/**
 * Streaming input parser.
 * Returns { event, consumed } where `consumed` is the number of bytes consumed.
 * Returns null if more bytes are needed to complete the current sequence.
 */
export function parseStream(bytes: Buffer): { event: InputEvent; consumed: number } | null {
  if (bytes.length === 0) return null;

  // C0 controls in raw mode. Application-level quit binding is handled
  // outside the parser so browser shortcuts can be forwarded when desired.
  if (bytes[0] === 0x0d || bytes[0] === 0x0a) return { event: { type: "key", key: "Enter" }, consumed: 1 };
  if (bytes[0] === 0x7f || bytes[0] === 0x08) return { event: { type: "key", key: "Backspace" }, consumed: 1 };
  if (bytes[0] === 0x09) return { event: { type: "key", key: "Tab" }, consumed: 1 };
  if (bytes[0] >= 0x01 && bytes[0] <= 0x1a) {
    return { event: { type: "key", key: String.fromCharCode(64 + bytes[0]), modifiers: { ctrl: true } }, consumed: 1 };
  }

  // Printable Unicode text without ESC. This covers ordinary typing from the
  // terminal, including non-ASCII text emitted by IME and paste paths when the
  // terminal is not using bracketed paste.
  if (bytes[0] !== 0x1b) {
    const text = readUtf8TextPrefix(bytes);
    if (text) return { event: { type: "text", text: text.value }, consumed: text.consumed };
    if (isLikelyIncompleteUtf8(bytes)) return null;
    // Invalid or unsupported byte: consume one byte to prevent parser deadlock.
    return { event: { type: "noop" }, consumed: 1 };
  }

  if (bytes.length < 2) return null;
  const s = bytes.toString("utf8");

  // Bracketed paste: \x1b[200~...\x1b[201~
  if (s.startsWith("\x1b[200~")) {
    const pasteEnd = s.indexOf("\x1b[201~");
    if (pasteEnd === -1) return null;
    const text = s.slice(6, pasteEnd);
    return { event: { type: "text", text }, consumed: Buffer.byteLength(s.slice(0, pasteEnd + 6)) };
  }

  // SGR mouse: \x1b[<...M or \x1b[<...m
  if (s.startsWith("\x1b[<")) {
    const end = findSgrMouseEnd(s);
    if (end === -1) return null;
    const seq = s.slice(0, end + 1);
    const mouse = parseSgrMouse(seq);
    return { event: mouse ?? { type: "noop" }, consumed: Buffer.byteLength(seq) };
  }

  // CSI sequences: \x1b[... (arrows, function keys, Kitty CSI-u keyboard protocol, etc.)
  if (s.startsWith("\x1b[")) {
    const csiEnd = s.slice(2).search(/[A-Za-z~]/);
    if (csiEnd === -1) return null;
    const seq = s.slice(0, 2 + csiEnd + 1);
    const csiU = parseCsiUInput(seq);
    if (csiU) return { event: csiU, consumed: Buffer.byteLength(seq) };
    const key = parseKey(seq);
    return { event: key ? { type: "key", ...key } : { type: "noop" }, consumed: Buffer.byteLength(seq) };
  }

  // Alt/meta + printable character: ESC + text byte sequence.
  const altText = readUtf8TextPrefix(bytes.subarray(1));
  if (altText) {
    const char = altText.value[0];
    return { event: { type: "key", key: char, modifiers: { alt: true } }, consumed: 1 + Buffer.byteLength(char) };
  }

  // Simple ESC sequences: ESC + one char
  const seq = s.slice(0, 2);
  const key = parseKey(seq);
  return { event: key ? { type: "key", ...key } : { type: "key", key: "Escape" }, consumed: key ? 2 : 1 };
}

function findSgrMouseEnd(s: string): number {
  const mIdx = s.indexOf("M");
  const rIdx = s.indexOf("m");
  if (mIdx === -1) return rIdx;
  if (rIdx === -1) return mIdx;
  return Math.min(mIdx, rIdx);
}

function readUtf8TextPrefix(bytes: Buffer): { value: string; consumed: number } | null {
  let end = 0;
  while (end < bytes.length) {
    const len = utf8SequenceLength(bytes[end]);
    if (len === 0) break;
    if (end + len > bytes.length) break;
    if (len > 1 && !hasValidUtf8Continuation(bytes, end, len)) break;
    const cp = bytes.subarray(end, end + len).toString("utf8");
    if (cp === "\uFFFD") break;
    if (isControlLike(cp)) break;
    end += len;
  }
  if (end === 0) return null;
  return { value: bytes.subarray(0, end).toString("utf8"), consumed: end };
}

function utf8SequenceLength(b: number): number {
  if (b >= 0x20 && b < 0x7f) return 1;              // printable ASCII
  if (b >= 0xc2 && b <= 0xdf) return 2;
  if (b >= 0xe0 && b <= 0xef) return 3;
  if (b >= 0xf0 && b <= 0xf4) return 4;
  return 0;
}

function hasValidUtf8Continuation(bytes: Buffer, start: number, len: number): boolean {
  for (let i = 1; i < len; i++) {
    const b = bytes[start + i];
    if (b < 0x80 || b > 0xbf) return false;
  }
  return true;
}

function isLikelyIncompleteUtf8(bytes: Buffer): boolean {
  const len = utf8SequenceLength(bytes[0]);
  return len > 1 && bytes.length < len;
}

function isControlLike(s: string): boolean {
  if (s.length !== 1) return false;
  const code = s.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}
