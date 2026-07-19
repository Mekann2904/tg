import type { InputEvent, KeyModifiers, MouseButton } from "../types";

export function parseSgrMouse(s: string): InputEvent | null {
  const m = s.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!m) return null;

  const code = Number(m[1]);
  const col = Number(m[2]);
  const row = Number(m[3]);
  const final = m[4];

  const button = decodeButton(code);
  const modifiers = decodeMouseModifiers(code, button);

  const wheelCode = code & ~(4 | 8 | 16 | 32);
  if (wheelCode === 64 || wheelCode === 65) {
    return { type: "mouse", action: "wheel", col, row, deltaX: 0, deltaY: wheelCode === 64 ? 120 : -120, modifiers };
  }
  if (wheelCode === 66 || wheelCode === 67) {
    return { type: "mouse", action: "wheel", col, row, deltaX: wheelCode === 66 ? 120 : -120, deltaY: 0, modifiers };
  }

  if ((code & 32) !== 0) return { type: "mouse", action: "move", button, col, row, modifiers };
  return { type: "mouse", action: final === "M" ? "press" : "release", button, col, row, modifiers };
}

function decodeButton(code: number): MouseButton {
  // Extended mouse buttons are the important case for Logitech MX Ergo S.
  //
  // Terminals are inconsistent:
  //   - some report side buttons as 8/9
  //   - Kitty/xterm-style extended buttons are often 128/129
  //   - modifier bits may be present on top of 128/129
  //
  // Handle 128/129 first with all modifier bits removed.
  const extended128 = code & ~(4 | 8 | 16 | 32);
  switch (extended128) {
    case 128:
      return "back";
    case 129:
      return "forward";
  }

  // Handle terminals that expose side buttons as 8/9. Here bit 8 is part of
  // the button encoding, not Alt.
  const extended8 = code & ~(4 | 16 | 32);
  switch (extended8) {
    case 8:
      return "back";
    case 9:
      return "forward";
  }

  const base = code & ~(4 | 8 | 16 | 32);
  switch (base) {
    case 0: return "left";
    case 1: return "middle";
    case 2: return "right";
    default:
      return "none";
  }
}

function decodeMouseModifiers(code: number, button: MouseButton): KeyModifiers | undefined {
  // For side buttons, bit 8 is part of the button encoding, not Alt.
  const alt = button === "back" || button === "forward" ? false : (code & 8) !== 0;
  const modifiers: KeyModifiers = {
    shift: (code & 4) !== 0,
    alt,
    ctrl: (code & 16) !== 0,
  };
  return modifiers.shift || modifiers.alt || modifiers.ctrl ? modifiers : undefined;
}
