// Trusted keyboard event construction for CDP Input.dispatchKeyEvent.

export const MODIFIER_BITS = Object.freeze({
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
});

const NAMED_KEY_SPECS = Object.freeze({
  Enter: {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    text: "\r",
  },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Backspace: {
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowDown: {
    key: "ArrowDown",
    code: "ArrowDown",
    windowsVirtualKeyCode: 40,
    nativeVirtualKeyCode: 40,
  },
  ArrowLeft: {
    key: "ArrowLeft",
    code: "ArrowLeft",
    windowsVirtualKeyCode: 37,
    nativeVirtualKeyCode: 37,
  },
  ArrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
    nativeVirtualKeyCode: 39,
  },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33, nativeVirtualKeyCode: 33 },
  PageDown: {
    key: "PageDown",
    code: "PageDown",
    windowsVirtualKeyCode: 34,
    nativeVirtualKeyCode: 34,
  },
  Space: {
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32,
    text: " ",
  },
});

const PUNCTUATION_KEYS = Object.freeze({
  " ": { code: "Space", keyCode: 32 },
  "-": { code: "Minus", keyCode: 189 },
  "=": { code: "Equal", keyCode: 187 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  ";": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
  "`": { code: "Backquote", keyCode: 192 },
});

const SHIFTED_DIGITS = Object.freeze({
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
});

/**
 * Resolves a user-supplied key name to a canonical named key or a single
 * character. Returns null when the value is not supported.
 *
 * @param {unknown} input
 * @returns {string|null}
 */
export function canonicalKeyName(input) {
  if (typeof input !== "string" || input.length === 0) return null;
  if (Object.prototype.hasOwnProperty.call(NAMED_KEY_SPECS, input)) return input;
  const lower = input.toLowerCase();
  for (const name of Object.keys(NAMED_KEY_SPECS)) {
    if (name.toLowerCase() === lower) return name;
  }
  if (Array.from(input).length === 1) return input;
  return null;
}

function physicalKeyFor(character) {
  if (/^[A-Za-z]$/.test(character)) {
    const upper = character.toUpperCase();
    return { code: "Key" + upper, keyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/.test(character)) {
    return { code: "Digit" + character, keyCode: character.charCodeAt(0) };
  }
  const punctuation = PUNCTUATION_KEYS[character];
  if (punctuation) return { code: punctuation.code, keyCode: punctuation.keyCode };
  return { code: "", keyCode: undefined };
}

function applyShift(character, shift) {
  if (!shift) return character;
  if (/^[a-z]$/.test(character)) return character.toUpperCase();
  if (/^[0-9]$/.test(character)) return SHIFTED_DIGITS[character] || character;
  return character;
}

/**
 * Builds the CDP keyDown/keyUp pair for a canonical key and modifier mask.
 *
 * @param {string} key
 * @param {number} [modifierMask]
 * @returns {object[]}
 */
export function buildKeyEvents(key, modifierMask = 0) {
  const mask = Number.isInteger(modifierMask) ? modifierMask : 0;
  const named = NAMED_KEY_SPECS[key];
  if (named) {
    const base = {
      modifiers: mask,
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.windowsVirtualKeyCode,
      nativeVirtualKeyCode: named.nativeVirtualKeyCode,
    };
    const down = { type: "keyDown", ...base };
    const hasCommandModifier =
      (mask & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) !== 0;
    if (named.text && !hasCommandModifier) down.text = named.text;
    return [down, { type: "keyUp", ...base }];
  }

  const shift = (mask & MODIFIER_BITS.Shift) !== 0;
  const physical = physicalKeyFor(key);
  const effective = applyShift(key, shift);
  const down = { type: "keyDown", modifiers: mask, key: effective };
  if (physical.code) down.code = physical.code;
  if (physical.keyCode !== undefined) {
    down.windowsVirtualKeyCode = physical.keyCode;
    down.nativeVirtualKeyCode = physical.keyCode;
  }
  const hasCommandModifier =
    (mask & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) !== 0;
  if (!hasCommandModifier) down.text = effective;

  const up = { type: "keyUp", modifiers: mask, key: effective };
  if (physical.code) up.code = physical.code;
  if (physical.keyCode !== undefined) {
    up.windowsVirtualKeyCode = physical.keyCode;
    up.nativeVirtualKeyCode = physical.keyCode;
  }
  return [down, up];
}
