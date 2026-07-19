import type { BrowserKey, InputEvent, KeyModifiers } from "../types";

export interface ParsedKey {
  key: BrowserKey;
  modifiers?: KeyModifiers;
}

export const KEY_MAP: Record<string, BrowserKey> = {
  "\r": "Enter",
  "\n": "Enter",
  "\x7f": "Backspace",
  "\b": "Backspace",
  "\t": "Tab",
  "\x1b[Z": "Tab",
  "\x1b": "Escape",
  "\x1b[A": "ArrowUp",
  "\x1b[B": "ArrowDown",
  "\x1b[C": "ArrowRight",
  "\x1b[D": "ArrowLeft",
  "\x1b[H": "Home",
  "\x1b[F": "End",
  "\x1b[1~": "Home",
  "\x1b[2~": "Insert",
  "\x1b[3~": "Delete",
  "\x1b[4~": "End",
  "\x1b[5~": "PageUp",
  "\x1b[6~": "PageDown",
  "\x1bOP": "F1",
  "\x1bOQ": "F2",
  "\x1bOR": "F3",
  "\x1bOS": "F4",
};

const CSI_MOD_KEY: Record<string, BrowserKey> = {
  A: "ArrowUp",
  B: "ArrowDown",
  C: "ArrowRight",
  D: "ArrowLeft",
  H: "Home",
  F: "End",
  P: "F1",
  Q: "F2",
  R: "F3",
  S: "F4",
};

const TILDE_KEY: Record<string, BrowserKey> = {
  "1": "Home",
  "2": "Insert",
  "3": "Delete",
  "4": "End",
  "5": "PageUp",
  "6": "PageDown",
  "7": "Home",
  "8": "End",
  "11": "F1",
  "12": "F2",
  "13": "F3",
  "14": "F4",
  "15": "F5",
  "17": "F6",
  "18": "F7",
  "19": "F8",
  "20": "F9",
  "21": "F10",
  "23": "F11",
  "24": "F12",
  "25": "F13",
  "26": "F14",
  "28": "F15",
  "29": "F16",
  "31": "F17",
  "32": "F18",
  "33": "F19",
  "34": "F20",
};

const CSI_U_SPECIAL: Record<number, BrowserKey> = {
  8: "Backspace",
  9: "Tab",
  13: "Enter",
  27: "Escape",
  32: "Space",
  127: "Backspace",
};

export function parseKey(s: string): ParsedKey | null {
  const direct = KEY_MAP[s];
  if (direct) return { key: direct, modifiers: s === "\x1b[Z" ? { shift: true } : undefined };

  const csi = s.match(/^\x1b\[1;(\d+)([ABCDHFPQRS])$/);
  if (csi) {
    const key = CSI_MOD_KEY[csi[2]];
    const modifiers = decodeXtermModifiers(Number(csi[1]));

    // Logitech MX Ergo S side buttons are commonly translated by macOS /
    // Logitech Options / Kitty into browser-style Alt/Meta + Left/Right
    // sequences instead of SGR mouse button 8/9. Treat those as dedicated
    // browser navigation commands so they work even when the terminal does not
    // expose physical side buttons.
    if (key === "ArrowLeft" && (modifiers.alt || modifiers.meta)) return { key: "BrowserBack" };
    if (key === "ArrowRight" && (modifiers.alt || modifiers.meta)) return { key: "BrowserForward" };
    return { key, modifiers };
  }

  // Some terminal/Logi Options combinations emit ESC + [ or ESC + ] for
  // browser back/forward. parseStream treats ESC + printable as Alt+key; keep
  // direct parser coverage here too for tests and CSI-u paths.
  if (s === "\x1b[") return { key: "BrowserBack" };
  if (s === "\x1b]") return { key: "BrowserForward" };

  const ss3 = s.match(/^\x1bO(\d+)([PQRS])$/);
  if (ss3) return { key: CSI_MOD_KEY[ss3[2]], modifiers: decodeXtermModifiers(Number(ss3[1])) };

  const tilde = s.match(/^\x1b\[(\d+)(?:;(\d+))?~$/);
  if (tilde && TILDE_KEY[tilde[1]]) {
    return { key: TILDE_KEY[tilde[1]], modifiers: tilde[2] ? decodeXtermModifiers(Number(tilde[2])) : undefined };
  }

  const csiU = parseCsiUKey(s);
  if (csiU?.type === "key") return { key: csiU.key, modifiers: csiU.modifiers };

  if (s.length === 1) {
    const code = s.charCodeAt(0);
    if (code >= 1 && code <= 26) return { key: String.fromCharCode(64 + code), modifiers: { ctrl: true } };
  }

  return null;
}

export function parseCsiUInput(s: string): InputEvent | null {
  const parsed = parseCsiUKey(s);
  if (!parsed) return null;
  return parsed;
}

function parseCsiUKey(s: string): InputEvent | null {
  const m = s.match(/^\x1b\[(\d+)(?:;(\d+))?(?:;(\d+))?u$/);
  if (!m) return null;

  const codepoint = Number(m[1]);
  const modifiers = decodeXtermModifiers(Number(m[2] ?? "1"));
  const eventType = Number(m[3] ?? "1");

  // Kitty keyboard protocol event type 3 means key release. CEF receives keyup
  // from the synthetic key event we send on press, so terminal release events
  // should be ignored to avoid duplicate keyup noise.
  if (eventType === 3) return { type: "noop" };

  const special = CSI_U_SPECIAL[codepoint];
  if (special) return { type: "key", key: special, modifiers: cleanModifiers(modifiers) };

  const text = String.fromCodePoint(codepoint);
  const hasCommandModifier = !!(modifiers.ctrl || modifiers.alt || modifiers.meta);
  if (!hasCommandModifier && isPrintableText(text)) return { type: "text", text };

  return { type: "key", key: text, modifiers: cleanModifiers(modifiers) };
}

function decodeXtermModifiers(value: number): KeyModifiers {
  const mask = value - 1;
  return {
    shift: (mask & 1) !== 0,
    alt: (mask & 2) !== 0,
    ctrl: (mask & 4) !== 0,
    meta: (mask & 8) !== 0,
  };
}

function cleanModifiers(modifiers: KeyModifiers): KeyModifiers | undefined {
  return modifiers.shift || modifiers.alt || modifiers.ctrl || modifiers.meta ? modifiers : undefined;
}

function isPrintableText(text: string): boolean {
  if (!text) return false;
  return !/^\p{Cc}$/u.test(text);
}
