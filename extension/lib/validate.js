// Defensive parameter validation for bridge commands.

import { canonicalKeyName, MODIFIER_BITS } from "./keys.js";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const BUTTON_VALUES = new Set(["left", "right", "middle"]);
const BUTTON_INDEX = { 0: "left", 1: "middle", 2: "right" };
const MODIFIER_NAMES = Object.keys(MODIFIER_BITS);

export const DEFAULT_SNAPSHOT_CHARS = 20000;
export const MAX_SNAPSHOT_CHARS = 100000;

const MAX_SELECTOR_LENGTH = 10000;
const MAX_TEXT_LENGTH = 200000;
const MAX_EXPRESSION_LENGTH = 1000000;
const MAX_CDP_PARAMS_LENGTH = 5000000;

function abbreviate(value) {
  const text = String(value);
  return text.length > 120 ? text.slice(0, 119) + "…" : text;
}

/**
 * @param {unknown} params
 * @returns {Record<string, unknown>}
 */
export function asObject(params) {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Request params must be an object");
  }
  return /** @type {Record<string, unknown>} */ (params);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function requireTabId(value) {
  const numeric =
    typeof value === "string" && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof numeric !== "number" || !Number.isInteger(numeric) || numeric <= 0) {
    throw new Error('Parameter "tabId" must be a positive integer');
  }
  return numeric;
}

/**
 * Only http(s) URLs are accepted for open/navigate.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeHttpUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error('Parameter "url" must be a non-empty string');
  }
  const trimmed = value.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error("Invalid URL: " + abbreviate(trimmed));
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('Only http(s) URLs are supported');
  }
  return parsed.href;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeMaxChars(value) {
  if (value === undefined || value === null) return DEFAULT_SNAPSHOT_CHARS;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error('Parameter "maxChars" must be a number');
  }
  return Math.max(1, Math.min(MAX_SNAPSHOT_CHARS, Math.floor(value)));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSelector(value) {
  if (typeof value !== "string") throw new Error('Parameter "selector" must be a string');
  const selector = value.trim();
  if (selector === "") throw new Error('Parameter "selector" must not be empty');
  if (selector.length > MAX_SELECTOR_LENGTH) {
    throw new Error('Parameter "selector" is too long');
  }
  if (selector.includes("\u0000")) {
    throw new Error('Parameter "selector" contains invalid characters');
  }
  return selector;
}

/**
 * @param {unknown} value
 * @returns {"left"|"right"|"middle"}
 */
export function normalizeButton(value) {
  if (value === undefined || value === null) return "left";
  if (typeof value === "number" && Object.prototype.hasOwnProperty.call(BUTTON_INDEX, value)) {
    return BUTTON_INDEX[value];
  }
  if (typeof value === "string" && BUTTON_VALUES.has(value.toLowerCase())) {
    return /** @type {"left"|"right"|"middle"} */ (value.toLowerCase());
  }
  throw new Error('Parameter "button" must be one of left, right, middle');
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeClickCount(value) {
  if (value === undefined || value === null) return 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error('Parameter "clickCount" must be an integer between 1 and 3');
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
export function normalizeCoordinate(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error('Parameter "' + name + '" must be a finite number');
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {{mask: number, names: string[]}}
 */
export function normalizeModifiers(value) {
  if (value === undefined || value === null) return { mask: 0, names: [] };
  if (!Array.isArray(value)) throw new Error('Parameter "modifiers" must be an array of strings');
  const seen = new Set();
  let mask = 0;
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error('Parameter "modifiers" must be an array of strings');
    }
    const wanted = item.trim().toLowerCase();
    const match = MODIFIER_NAMES.find((name) => name.toLowerCase() === wanted);
    if (!match) {
      throw new Error('Unsupported modifier "' + item + '". Allowed: Alt, Control, Meta, Shift');
    }
    if (seen.has(match)) continue;
    seen.add(match);
    mask |= MODIFIER_BITS[match];
  }
  return { mask, names: MODIFIER_NAMES.filter((name) => seen.has(name)) };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeKey(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error('Parameter "key" must be a non-empty string');
  }
  const canonical = canonicalKeyName(value);
  if (canonical === null) {
    throw new Error(
      "Unsupported key. Use Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space or a single character",
    );
  }
  return canonical;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {{required?: boolean}} [options]
 * @returns {number}
 */
export function normalizeScrollDelta(value, name, options = {}) {
  if (value === undefined || value === null) {
    if (options.required) throw new Error('Parameter "' + name + '" is required');
    return 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error('Parameter "' + name + '" must be a finite number');
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeDeltaY(value) {
  return normalizeScrollDelta(value, "deltaY", { required: true });
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeDeltaX(value) {
  return normalizeScrollDelta(value, "deltaX");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  if (typeof value !== "string") throw new Error('Parameter "text" must be a string');
  if (value.length > MAX_TEXT_LENGTH) throw new Error('Parameter "text" is too long');
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {boolean} [defaultValue]
 * @returns {boolean}
 */
export function normalizeBoolean(value, name, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "boolean") throw new Error('Parameter "' + name + '" must be a boolean');
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeExpression(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error('Parameter "expression" must be a non-empty string');
  }
  if (value.length > MAX_EXPRESSION_LENGTH) {
    throw new Error('Parameter "expression" is too long');
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCdpMethod(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(value.trim())
  ) {
    throw new Error('Parameter "method" must be a CDP method name such as Page.navigate');
  }
  return value.trim();
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function normalizeCdpParams(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error('Parameter "params" must be an object');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error('Parameter "params" must be JSON-serializable');
  }
  if (typeof serialized !== "string") {
    throw new Error('Parameter "params" must be JSON-serializable');
  }
  if (serialized.length > MAX_CDP_PARAMS_LENGTH) {
    throw new Error('Parameter "params" is too large');
  }
  return /** @type {Record<string, unknown>} */ (value);
}
