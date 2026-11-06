// Higher-level DOM tools for the bridge.
//
// Two layers live here:
//  * `domRuntime` is serialized with Function.prototype.toString and evaluated
//    inside the tab through CDP Runtime.evaluate (same pattern as page.js). It
//    must stay fully self-contained: it may not reference module bindings.
//  * `createDomTools` is the service-worker side. It validates parameters,
//    serializes work per tab through the debugger session, bounds output and
//    never echoes field values.
//
// Actions implemented by both layers:
//   wait, read_region, read_table, read_form, fill_form, select, set_checked,
//   inspect.

import {
  asObject,
  requireTabId,
  normalizeSelector,
  normalizeBoolean,
} from "./validate.js";
import { buildPageExpression } from "./page.js";

const WAIT_DEFAULT_TIMEOUT_MS = 5000;
const WAIT_MAX_TIMEOUT_MS = 25000;
const WAIT_MIN_TIMEOUT_MS = 50;
const WAIT_DEFAULT_INTERVAL_MS = 120;
const WAIT_MIN_INTERVAL_MS = 25;
const WAIT_MAX_INTERVAL_MS = 2000;

const MAX_REGION_CHARS = 40000;
const DEFAULT_REGION_CHARS = 8000;
const MAX_REGION_ELEMENTS = 100;
const MAX_TABLE_ROWS = 200;
const DEFAULT_TABLE_ROWS = 50;
const MAX_TABLE_CELLS = 20;
const MAX_TABLE_CELL_CHARS = 500;
const MAX_FORMS = 10;
const MAX_FORM_FIELDS = 100;
const MAX_FORM_OPTIONS = 50;
const MAX_FILL_FIELDS = 50;
const MAX_FILL_VALUE_CHARS = 10000;
const MAX_FRAME_ID_CHARS = 512;
const MAX_SELECT_VALUES = 50;
const MAX_INSPECT_ELEMENTS = 50;
const MAX_SELECTOR_LENGTH = 10000;
const FILL_DEADLINE_MS = 20000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

function abortText(value) {
  const text = errorText(value);
  return text.length > 300 ? text.slice(0, 299) + "…" : text;
}

function isNavigationError(message) {
  return /navigat|execution context was destroyed|cannot find context|frame was detached|frame.*(?:removed|detached)|target.*navigated/i.test(
    message,
  );
}

function isDetachError(message) {
  return /not attached|no tab with given id|no tab with id|target closed|no target|debugger.*detach|browser (?:has )?disconnected/i.test(
    message,
  );
}

function normalizeFrameId(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error('Parameter "frameId" must be a string');
  if (value.length === 0 || value.length > MAX_FRAME_ID_CHARS) {
    throw new Error('Parameter "frameId" must contain 1 to ' + MAX_FRAME_ID_CHARS + " characters");
  }
  return value;
}

function clampInt(value, name, defaultValue, min, max) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error('Parameter "' + name + '" must be a finite number');
  }
  if (Math.floor(value) !== value) throw new Error('Parameter "' + name + '" must be an integer');
  if (value < min || value > max) {
    throw new Error('Parameter "' + name + '" must be between ' + min + " and " + max);
  }
  return value;
}

function normalizeFinite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error('Parameter "' + name + '" must be a finite number');
  }
  return value;
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeValue(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function sensitiveElement(item) {
  const tag = typeof item.tag === "string" ? item.tag : "";
  const type = typeof item.type === "string" ? item.type : "";
  return tag === "input" && (type === "password" || type === "hidden" || type === "file");
}

// Defense in depth: even a malformed page payload may not leak secret values.
function sanitizeElement(item) {
  if (!isObject(item) || typeof item.selector !== "string" || item.selector === "") return null;
  const summary = {
    selector: item.selector.slice(0, MAX_SELECTOR_LENGTH),
    tag: typeof item.tag === "string" ? item.tag : "",
    role: typeof item.role === "string" ? item.role : "",
    name: sanitizeValue(item.name, 200),
    type: typeof item.type === "string" ? item.type : "",
  };
  if (typeof item.id === "string" && item.id !== "") summary.id = item.id.slice(0, 200);
  if (sensitiveElement(item)) {
    summary.sensitive = true;
    return summary;
  }
  if (typeof item.value === "string" && item.value !== "") {
    summary.value = item.value.slice(0, 1000);
  }
  if (typeof item.checked === "boolean") summary.checked = item.checked;
  if (typeof item.disabled === "boolean" && item.disabled) summary.disabled = true;
  if (typeof item.required === "boolean" && item.required) summary.required = true;
  return summary;
}

function sanitizeElements(list, max) {
  if (!Array.isArray(list)) return [];
  const result = [];
  for (const item of list) {
    if (result.length >= max) break;
    const summary = sanitizeElement(item);
    if (summary) result.push(summary);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Page runtime (serialized into the tab)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Runs one DOM action inside a page (or frame).
 *
 * Actions and payloads:
 *  - wait {selector?,state?,text?,urlContains?,caseSensitive?}
 *      -> {ok,matched,url,title,count,visibleCount,matchedSelector,hasText,hasUrl}
 *  - read_region {selector?|x,y,width,height,maxChars?,maxElements?}
 *      -> {ok,url,title,resolvedBy,root,rect,text,elements,truncated}
 *  - read_table {selector?,index?,maxRows?,maxCellChars?,maxCols?}
 *      -> {ok,url,title,selector,caption,headers,rows,rowCount,rowsReturned,
 *          columnCount,hasHeader,truncated}
 *  - read_form {selector?,formIndex?,maxFields?,maxOptions?}
 *      -> {ok,url,title,forms,fieldCount,truncated}
 *  - fill_form {fields:[{selector?|name?,role?,value?,checked?}]}
 *      -> {ok,url,title,results:[{status,selector,name,tag,type,...}]}
 *  - select {selector,values?|labels?|indexes?,by?,append?}
 *      -> {ok,selector,multiple,selected,changed}
 *  - set_checked {selector,checked}
 *      -> {ok,selector,mode,checked,changed,verified}
 *  - inspect {selector?,maxElements?}
 *      -> {ok,mode,element|page,actionability,capabilities,associations,coverage}
 *
 * No action submits a form and no action returns password, hidden or file
 * input values. Expected failures are returned as `{ok:false,error}`.
 *
 * @param {{document: Document, window: Window, getComputedStyle: Function}} ctx
 * @param {string} action
 * @param {object} payload
 */
export function domRuntime(ctx, action, payload) {
  "use strict";
  var doc = ctx && ctx.document ? ctx.document : null;
  var win = ctx && ctx.window ? ctx.window : null;
  var getStyle = ctx && typeof ctx.getComputedStyle === "function" ? ctx.getComputedStyle : null;

  var MAX_TEXT = 40000;
  var MAX_NAME = 200;
  var MAX_VALUE = 1000;
  var MAX_SELECTOR = 5000;
  var MAX_ELEMENTS = 100;
  var MAX_ATTRS = 30;
  var MAX_OPTIONS = 50;
  var MAX_FORMS = 10;
  var MAX_FIELDS = 100;
  var MAX_ROWS = 200;
  var MAX_COLS = 20;
  var MAX_CELL = 500;
  var DEFAULT_REGION_CHARS = 8000;
  var DEFAULT_REGION_ELEMENTS = 60;
  var DEFAULT_TABLE_ROWS = 50;
  var DEFAULT_FORM_FIELDS = 60;
  var DEFAULT_FORM_OPTIONS = 30;
  var DEFAULT_INSPECT_ELEMENTS = 20;

  var CANDIDATE_SELECTOR = [
    "a[href]",
    "area[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "label",
    '[contenteditable=""]',
    '[contenteditable="true"]',
    "[onclick]",
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="searchbox"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="textbox"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  var FIELD_SELECTOR = [
    "input",
    "select",
    "textarea",
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="combobox"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="spinbutton"]',
    '[role="slider"]',
  ].join(",");

  var CHECKED_ROLES = { checkbox: true, radio: true, switch: true, menuitemcheckbox: true, menuitemradio: true };

  var COVERAGE = {
    mainDocument: true,
    frames: "Only the addressed frame is read; pass frameId to target another frame.",
    shadowDom: "Open shadow roots are not traversed.",
    passwordValues: "Password values are never read.",
    hiddenValues: "Hidden input values are never read.",
    fileValues: "File input values are never read.",
    virtualized: "Virtualized, canvas or offscreen content may be missing.",
  };

  function tagOf(el) {
    return el && typeof el.tagName === "string" ? el.tagName.toLowerCase() : "";
  }

  function attr(el, name) {
    try {
      if (!el || typeof el.getAttribute !== "function") return null;
      return el.getAttribute(name);
    } catch (error) {
      return null;
    }
  }

  function collapse(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/\s+/g, " ").trim();
  }

  function styleOf(el) {
    try {
      return getStyle ? getStyle(el) : null;
    } catch (error) {
      return null;
    }
  }

  function rectOf(el) {
    try {
      var rect = el.getBoundingClientRect();
      if (!rect) return null;
      return {
        x: Number(rect.left) || 0,
        y: Number(rect.top) || 0,
        width: Math.max(0, Number(rect.width) || 0),
        height: Math.max(0, Number(rect.height) || 0),
      };
    } catch (error) {
      return null;
    }
  }

  function viewportSize() {
    var width =
      win && typeof win.innerWidth === "number"
        ? win.innerWidth
        : doc && doc.documentElement
          ? doc.documentElement.clientWidth
          : 0;
    var height =
      win && typeof win.innerHeight === "number"
        ? win.innerHeight
        : doc && doc.documentElement
          ? doc.documentElement.clientHeight
          : 0;
    return { width: width || 0, height: height || 0 };
  }

  function clipRect(rect) {
    var viewport = viewportSize();
    var left = Math.max(0, rect.x);
    var top = Math.max(0, rect.y);
    var right = Math.min(viewport.width || rect.x + rect.width, rect.x + rect.width);
    var bottom = Math.min(viewport.height || rect.y + rect.height, rect.y + rect.height);
    if (!(right > left) || !(bottom > top)) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function inViewport(rect) {
    if (!rect) return false;
    var viewport = viewportSize();
    if (!(viewport.width > 0) || !(viewport.height > 0)) return true;
    return rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    if (attr(el, "aria-hidden") === "true") return false;
    try {
      if (el.closest && el.closest('[aria-hidden="true"]')) return false;
    } catch (error) {
      /* ignore */
    }
    var rect = rectOf(el);
    if (!rect) return false;
    if (!(rect.width > 0) || !(rect.height > 0)) return false;
    var style = styleOf(el);
    if (style) {
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (style.pointerEvents === "none") return false;
      var opacity = parseFloat(style.opacity);
      if (!isNaN(opacity) && opacity === 0) return false;
    }
    if (typeof el.checkVisibility === "function") {
      try {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch (error) {
        /* older engines do not support the options object */
      }
    }
    return true;
  }

  function inputType(el) {
    var tag = tagOf(el);
    if (tag !== "input") return "";
    return String(attr(el, "type") || "text").toLowerCase();
  }

  function sensitiveType(el) {
    var type = inputType(el);
    return type === "password" || type === "hidden" || type === "file";
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = tagOf(el);
    if (tag === "textarea") return el.readOnly !== true && el.disabled !== true;
    if (tag === "input") {
      var type = inputType(el);
      if (
        type === "button" ||
        type === "submit" ||
        type === "reset" ||
        type === "checkbox" ||
        type === "radio" ||
        type === "file" ||
        type === "image" ||
        type === "range" ||
        type === "color" ||
        type === "hidden"
      ) {
        return false;
      }
      return el.readOnly !== true && el.disabled !== true;
    }
    if (el.isContentEditable === true && el.nodeType === 1) return true;
    var role = String(attr(el, "role") || "").toLowerCase();
    return role === "textbox" || role === "searchbox" || role === "combobox" || role === "spinbutton";
  }

  function cssEscape(value) {
    var string = String(value);
    if (win && win.CSS && typeof win.CSS.escape === "function") {
      try {
        return win.CSS.escape(string);
      } catch (error) {
        /* fall through */
      }
    }
    var result = "";
    for (var index = 0; index < string.length; index += 1) {
      var code = string.charCodeAt(index);
      var character = string.charAt(index);
      if (code === 0) {
        result += "\uFFFD";
        continue;
      }
      if ((code >= 1 && code <= 31) || code === 127) {
        result += "\\" + code.toString(16) + " ";
        continue;
      }
      if (code >= 48 && code <= 57 && (index === 0 || (index === 1 && string.charAt(0) === "-"))) {
        result += "\\" + code.toString(16) + " ";
        continue;
      }
      if (index === 0 && character === "-" && string.length === 1) {
        result += "\\-";
        continue;
      }
      if (code >= 128 || character === "-" || character === "_" || /[0-9A-Za-z]/.test(character)) {
        result += character;
        continue;
      }
      result += "\\" + character;
    }
    return result;
  }

  function resolvesTo(selector, el) {
    if (!doc || typeof doc.querySelectorAll !== "function") return false;
    try {
      var found = doc.querySelectorAll(selector);
      return !!found && found.length === 1 && found[0] === el;
    } catch (error) {
      return false;
    }
  }

  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return null;
    if (typeof el.getRootNode === "function" && el.getRootNode() !== doc) return null;
    var id = attr(el, "id");
    if (id) {
      var idSelector = "#" + cssEscape(id);
      if (resolvesTo(idSelector, el)) return idSelector;
    }
    var path = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var tag = tagOf(node);
      if (!tag) return null;
      var segment = tag;
      if (node === doc.documentElement || !node.parentElement) {
        path.unshift(segment);
        break;
      }
      var parent = node.parentElement;
      var children = parent.children || [];
      var sameTag = 0;
      var position = 0;
      for (var index = 0; index < children.length; index += 1) {
        var sibling = children[index];
        if (sibling && sibling.tagName === node.tagName) {
          sameTag += 1;
          if (sibling === node) position = sameTag;
        }
      }
      if (sameTag > 1 && position > 0) segment += ":nth-of-type(" + position + ")";
      path.unshift(segment);
      node = parent;
    }
    var selector = path.join(" > ");
    if (!selector || selector.length > MAX_SELECTOR) return null;
    return resolvesTo(selector, el) ? selector : null;
  }

  function roleOf(el) {
    var explicit = collapse(attr(el, "role")).toLowerCase();
    if (explicit) return explicit.split(" ")[0];
    var tag = tagOf(el);
    var type = inputType(el);
    if (tag === "a") return attr(el, "href") ? "link" : "";
    if (tag === "button") return "button";
    if (tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "table") return "table";
    if (tag === "form") return "form";
    if (tag === "input") {
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "file") return "button";
      if (type === "hidden") return "";
      return "textbox";
    }
    return "";
  }

  function accessibleName(el) {
    var ariaLabel = collapse(attr(el, "aria-label"));
    if (ariaLabel) return ariaLabel.slice(0, MAX_NAME);
    var labelledBy = collapse(attr(el, "aria-labelledby"));
    if (labelledBy) {
      var parts = [];
      var ids = labelledBy.split(" ");
      for (var i = 0; i < ids.length; i += 1) {
        var target = null;
        try {
          target = doc && typeof doc.getElementById === "function" ? doc.getElementById(ids[i]) : null;
        } catch (error) {
          target = null;
        }
        var part = target ? collapse(target.textContent) : "";
        if (part) parts.push(part);
      }
      if (parts.length > 0) return parts.join(" ").slice(0, MAX_NAME);
    }
    var labels = el.labels;
    if (labels && labels.length) {
      var labelParts = [];
      for (var labelIndex = 0; labelIndex < labels.length; labelIndex += 1) {
        var labelText = collapse(labels[labelIndex].textContent);
        if (labelText) labelParts.push(labelText);
      }
      if (labelParts.length > 0) return labelParts.join(" ").slice(0, MAX_NAME);
    }
    var alt = collapse(attr(el, "alt"));
    if (alt) return alt.slice(0, MAX_NAME);
    var title = collapse(attr(el, "title"));
    if (title) return title.slice(0, MAX_NAME);
    var placeholder = collapse(attr(el, "placeholder"));
    if (placeholder) return placeholder.slice(0, MAX_NAME);
    var tag = tagOf(el);
    if (tag === "input") {
      var type = inputType(el);
      if (type === "submit" || type === "button" || type === "reset") {
        var inputValue = collapse(attr(el, "value"));
        if (inputValue) return inputValue.slice(0, MAX_NAME);
      }
    }
    var text = collapse(el.textContent);
    return text ? text.slice(0, MAX_NAME) : "";
  }

  // Returns null *before* touching a password/hidden/file value.
  function valueOf(el) {
    var tag = tagOf(el);
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return null;
    if (tag === "input" && sensitiveType(el)) return null;
    var value;
    try {
      value = el.value;
    } catch (error) {
      return null;
    }
    if (typeof value !== "string" || value.length === 0) return null;
    return value.slice(0, MAX_VALUE);
  }

  function selectedOptionsOf(el) {
    var options = optionList(el);
    var selected = [];
    for (var index = 0; index < options.length; index += 1) {
      if (options[index] && options[index].selected === true) selected.push(options[index]);
    }
    return selected;
  }

  function optionList(el) {
    var options = null;
    try {
      if (el && el.options && typeof el.options.length === "number") {
        options = Array.prototype.slice.call(el.options);
      }
    } catch (error) {
      options = null;
    }
    if (!options) options = queryAll(el, "option");
    return options || [];
  }

  function tryQuery(root, selector) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return { ok: false, error: "No document available" };
    }
    try {
      var nodes = root.querySelectorAll(selector);
      return { ok: true, nodes: nodes ? Array.prototype.slice.call(nodes) : [] };
    } catch (error) {
      return { ok: false, error: "Invalid CSS selector" };
    }
  }

  function queryAll(root, selector) {
    var result = tryQuery(root, selector);
    return result.ok ? result.nodes : [];
  }

  function uniqueMatch(selector) {
    if (!selector) return { ok: false, error: "Selector is required" };
    var result = tryQuery(doc, selector);
    if (!result.ok) return { ok: false, error: result.error };
    if (result.nodes.length === 0) return { ok: false, error: "No element matches selector" };
    if (result.nodes.length > 1) {
      return {
        ok: false,
        error: "Selector matches " + result.nodes.length + " elements; expected exactly one",
      };
    }
    return { ok: true, el: result.nodes[0] };
  }

  function urlOf() {
    var url = "";
    try {
      url = String((win && win.location && win.location.href) || (doc && doc.URL) || "");
    } catch (error) {
      url = "";
    }
    return url.slice(0, 2000);
  }

  function titleOf() {
    var title = "";
    try {
      title = String((doc && doc.title) || "");
    } catch (error) {
      title = "";
    }
    return title.slice(0, 1000);
  }

  function normalizeText(value) {
    return String(value == null ? "" : value)
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function textOf(root) {
    if (!root) return "";
    var text = "";
    try {
      text = typeof root.innerText === "string" ? root.innerText : String(root.textContent || "");
    } catch (error) {
      text = "";
    }
    return normalizeText(text);
  }

  function isActionableTag(el) {
    var tag = tagOf(el);
    if (
      tag === "a" ||
      tag === "area" ||
      tag === "button" ||
      tag === "input" ||
      tag === "select" ||
      tag === "textarea" ||
      tag === "summary" ||
      tag === "label"
    ) {
      return true;
    }
    if (el && el.isContentEditable === true) return true;
    if (attr(el, "onclick") !== null) return true;
    if (attr(el, "tabindex") !== null && attr(el, "tabindex") !== "-1") return true;
    return roleOf(el) !== "";
  }

  function elementSummary(el, withValue) {
    var tag = tagOf(el);
    var type = tag === "input" ? inputType(el) : String(attr(el, "type") || "").toLowerCase();
    var summary = {
      selector: selectorFor(el),
      tag: tag,
      role: roleOf(el),
      name: accessibleName(el),
      type: type,
    };
    if (!summary.selector) return null;
    if (tag === "input" && (type === "checkbox" || type === "radio")) {
      summary.checked = el.checked === true;
      return summary;
    }
    if (sensitiveType(el)) {
      summary.sensitive = true;
      return summary;
    }
    if (withValue) {
      var value = valueOf(el);
      if (value !== null) summary.value = value;
    }
    return summary;
  }

  function collectElements(root, options) {
    var opts = options || {};
    var max = Math.max(1, Math.min(MAX_ELEMENTS, Number(opts.max) || MAX_ELEMENTS));
    var withValue = opts.withValue === true;
    var nodes = queryAll(root, CANDIDATE_SELECTOR);
    if (nodes.length === 0 && root && root.nodeType === 1 && root !== (doc && doc.body) && isActionableTag(root)) {
      nodes = [root];
    }
    var elements = [];
    var truncated = false;
    for (var index = 0; index < nodes.length; index += 1) {
      var el = nodes[index];
      if (!el || el.nodeType !== 1) continue;
      if (el.disabled === true || attr(el, "aria-disabled") === "true") continue;
      if (tagOf(el) === "input" && inputType(el) === "hidden") continue;
      if (!isVisible(el)) continue;
      if (elements.length >= max) {
        truncated = true;
        break;
      }
      var summary = elementSummary(el, withValue);
      if (summary) elements.push(summary);
    }
    return { elements: elements, truncated: truncated };
  }

  function pointFor(rect) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }

  function elementFromPoint(x, y) {
    if (!doc || typeof doc.elementFromPoint !== "function") return null;
    try {
      return doc.elementFromPoint(x, y);
    } catch (error) {
      return null;
    }
  }

  function containingAncestor(el, predicate) {
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < 30; depth += 1) {
      if (predicate(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function isTable(el) {
    var tag = tagOf(el);
    return tag === "table" || roleOf(el) === "table" || roleOf(el) === "grid";
  }

  /* ---------------------------------------------------------------------- */
  /* Native value/event helpers (React compatible)                          */
  /* ---------------------------------------------------------------------- */

  function nativeDescriptor(el, property) {
    if (!win) return null;
    var tag = tagOf(el);
    var proto = null;
    if (tag === "input") proto = win.HTMLInputElement && win.HTMLInputElement.prototype;
    else if (tag === "textarea") proto = win.HTMLTextAreaElement && win.HTMLTextAreaElement.prototype;
    else if (tag === "select") proto = win.HTMLSelectElement && win.HTMLSelectElement.prototype;
    else if (tag === "option") proto = win.HTMLOptionElement && win.HTMLOptionElement.prototype;
    if (!proto) return null;
    try {
      return Object.getOwnPropertyDescriptor(proto, property) || null;
    } catch (error) {
      return null;
    }
  }

  function setNativeValue(el, value) {
    var descriptor = nativeDescriptor(el, "value");
    if (descriptor && typeof descriptor.set === "function") {
      try {
        descriptor.set.call(el, value);
        return;
      } catch (error) {
        /* fall through to direct assignment */
      }
    }
    try {
      el.value = value;
    } catch (error) {
      /* ignore */
    }
  }

  function setNativeChecked(el, checked) {
    var descriptor = nativeDescriptor(el, "checked");
    if (descriptor && typeof descriptor.set === "function") {
      try {
        descriptor.set.call(el, checked);
        return;
      } catch (error) {
        /* fall through */
      }
    }
    try {
      el.checked = checked;
    } catch (error) {
      /* ignore */
    }
  }

  function createEvent(type, data) {
    if (!win) return null;
    var Ctor = null;
    var init = { bubbles: true, cancelable: false, composed: true };
    if (type === "input") {
      init.inputType = "insertText";
      if (typeof data === "string") init.data = data;
    }
    if (type === "input" && typeof win.InputEvent === "function") Ctor = win.InputEvent;
    else if (typeof win.Event === "function") Ctor = win.Event;
    if (!Ctor) return null;
    try {
      return new Ctor(type, init);
    } catch (error) {
      try {
        return new win.Event(type, { bubbles: true });
      } catch (innerError) {
        return null;
      }
    }
  }

  function dispatchEventOn(el, type, data) {
    var event = createEvent(type, data);
    if (!event || typeof el.dispatchEvent !== "function") return;
    try {
      el.dispatchEvent(event);
    } catch (error) {
      /* page listeners must not break the tool */
    }
  }

  function notifyValueChange(el, data) {
    dispatchEventOn(el, "input", data);
    dispatchEventOn(el, "change", data);
  }

  function focusQuietly(el) {
    try {
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
    } catch (error) {
      try {
        el.focus();
      } catch (innerError) {
        /* ignore */
      }
    }
  }

  function applyChecked(el, want) {
    var before = el.checked === true;
    if (before !== want) {
      try {
        if (typeof el.click === "function") el.click();
      } catch (error) {
        /* fall through to the native setter */
      }
    }
    if ((el.checked === true) !== want) {
      setNativeChecked(el, want);
      notifyValueChange(el, null);
    }
    var after = el.checked === true;
    return { changed: before !== after, checked: after, verified: after === want };
  }

  function ariaChecked(el) {
    return attr(el, "aria-checked") === "true";
  }

  function applyAriaChecked(el, want) {
    var before = ariaChecked(el);
    if (before !== want) {
      try {
        if (typeof el.click === "function") el.click();
      } catch (error) {
        /* keep going */
      }
    }
    return { changed: before !== ariaChecked(el), checked: ariaChecked(el), verified: ariaChecked(el) === want };
  }

  /* ---------------------------------------------------------------------- */
  /* wait                                                                    */
  /* ---------------------------------------------------------------------- */

  function waitProbe(payload) {
    var options = payload || {};
    var selector = typeof options.selector === "string" && options.selector ? options.selector : "";
    var text = typeof options.text === "string" && options.text !== "" ? options.text : "";
    var urlContains =
      typeof options.urlContains === "string" && options.urlContains !== "" ? options.urlContains : "";
    if (!selector && !text && !urlContains) {
      return { ok: false, fatal: true, error: "wait requires a selector, text or urlContains condition" };
    }
    var state = options.state === undefined ? "visible" : String(options.state).toLowerCase();
    if (!["visible", "attached", "detached", "hidden", "enabled"].includes(state)) {
      return { ok: false, fatal: true, error: "Unknown selector wait state" };
    }
    var caseSensitive = options.caseSensitive === true;
    var url = urlOf();
    var result = {
      ok: true,
      matched: false,
      url: url,
      title: titleOf(),
      count: 0,
      visibleCount: 0,
      matchedSelector: null,
      hasText: null,
      hasUrl: null,
    };
    var nodes = null;
    if (selector) {
      var query = tryQuery(doc, selector);
      if (!query.ok) return { ok: false, fatal: true, error: query.error };
      nodes = query.nodes;
      result.count = nodes.length;
      var visibleCount = 0;
      for (var index = 0; index < nodes.length; index += 1) {
        if (isVisible(nodes[index])) visibleCount += 1;
      }
      result.visibleCount = visibleCount;
      if (state === "attached") result.matchedSelector = nodes.length > 0;
      else if (state === "detached") result.matchedSelector = nodes.length === 0;
      else if (state === "hidden") result.matchedSelector = visibleCount === 0;
      else if (state === "enabled") result.matchedSelector = Array.from(nodes).some(el =>
        isVisible(el) && !el.disabled && !el.matches?.(":disabled") && attr(el, "aria-disabled") !== "true");
      else result.matchedSelector = visibleCount > 0;
    }
    if (text) {
      var root = null;
      if (nodes && nodes.length > 0) {
        root = null;
        for (var visibleIndex = 0; visibleIndex < nodes.length; visibleIndex += 1) {
          if (isVisible(nodes[visibleIndex])) {
            root = nodes[visibleIndex];
            break;
          }
        }
        if (!root) root = nodes[0];
      } else {
        root = doc ? doc.body || doc.documentElement : null;
      }
      var haystack = normalizeText(textOf(root));
      var needle = normalizeText(text);
      if (!caseSensitive) {
        haystack = haystack.toLowerCase();
        needle = needle.toLowerCase();
      }
      result.hasText = needle.length > 0 && haystack.indexOf(needle) !== -1;
    }
    if (urlContains) {
      var haystackUrl = caseSensitive ? url : url.toLowerCase();
      var needleUrl = caseSensitive ? urlContains : urlContains.toLowerCase();
      result.hasUrl = needleUrl.length > 0 && haystackUrl.indexOf(needleUrl) !== -1;
    }
    var matched = true;
    if (selector) matched = matched && result.matchedSelector === true;
    if (text) matched = matched && result.hasText === true;
    if (urlContains) matched = matched && result.hasUrl === true;
    result.matched = matched;
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /* read_region                                                             */
  /* ---------------------------------------------------------------------- */

  function readRegion(payload) {
    var options = payload || {};
    var maxChars = Math.max(1, Math.min(MAX_TEXT, Number(options.maxChars) || DEFAULT_REGION_CHARS));
    var maxElements = Math.max(
      1,
      Math.min(MAX_ELEMENTS, Number(options.maxElements) || DEFAULT_REGION_ELEMENTS),
    );
    var root = null;
    var resolvedBy = "document";
    var rect = null;
    if (typeof options.selector === "string" && options.selector !== "") {
      var match = uniqueMatch(options.selector);
      if (!match.ok) return { ok: false, error: match.error };
      root = match.el;
      resolvedBy = "selector";
    } else if (
      options.x !== undefined ||
      options.y !== undefined ||
      options.width !== undefined ||
      options.height !== undefined
    ) {
      if (
        options.x === undefined ||
        options.y === undefined ||
        options.width === undefined ||
        options.height === undefined
      ) {
        return { ok: false, error: "Coordinates require x, y, width and height together" };
      }
      if (
        typeof options.x !== "number" ||
        typeof options.y !== "number" ||
        typeof options.width !== "number" ||
        typeof options.height !== "number" ||
        !isFinite(options.x) ||
        !isFinite(options.y) ||
        !isFinite(options.width) ||
        !isFinite(options.height) ||
        options.width <= 0 ||
        options.height <= 0
      ) {
        return { ok: false, error: "Region coordinates must be finite with positive width and height" };
      }
      rect = { x: options.x, y: options.y, width: options.width, height: options.height };
      var clipped = clipRect(rect);
      if (!clipped) return { ok: false, error: "Region is outside the viewport" };
      var point = pointFor(clipped);
      var hit = elementFromPoint(point.x, point.y);
      if (!hit || hit.nodeType !== 1) return { ok: false, error: "No element found in the region" };
      root = hit;
      resolvedBy = "point";
      rect = clipped;
    } else {
      root = doc ? doc.body || doc.documentElement : null;
    }
    if (!root) return { ok: false, error: "No document available" };
    if (resolvedBy === "selector") {
      if (!isVisible(root)) return { ok: false, error: "Element is not visible" };
      var rootRect = rectOf(root);
      rect = rootRect ? clipRect(rootRect) : null;
    }
    var text = textOf(root);
    var truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
    var collected = collectElements(root, { max: maxElements, withValue: true });
    if (collected.truncated) truncated = true;
    var summary = elementSummary(root, false);
    return {
      ok: true,
      url: urlOf(),
      title: titleOf(),
      resolvedBy: resolvedBy,
      root: summary
        ? {
            selector: summary.selector,
            tag: summary.tag,
            role: summary.role,
            name: summary.name,
            rect: rect,
          }
        : { selector: null, tag: tagOf(root), role: roleOf(root), name: accessibleName(root), rect: rect },
      rect: rect,
      text: text,
      elements: collected.elements,
      truncated: truncated,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* read_table                                                              */
  /* ---------------------------------------------------------------------- */

  function tableRows(root) {
    var rows = null;
    try {
      if (tagOf(root) === "table" && root.rows && typeof root.rows.length === "number") {
        rows = Array.prototype.slice.call(root.rows);
      }
    } catch (error) {
      rows = null;
    }
    if (!rows) rows = queryAll(root, "tr");
    if (rows.length === 0) rows = queryAll(root, '[role="row"]');
    return rows;
  }

  function tableCells(row) {
    var cells = null;
    try {
      if (row.cells && typeof row.cells.length === "number") cells = Array.prototype.slice.call(row.cells);
    } catch (error) {
      cells = null;
    }
    if (!cells) {
      cells = queryAll(row, '[role="gridcell"],[role="cell"],[role="columnheader"],[role="rowheader"]');
    }
    return cells;
  }

  function headerCell(cell) {
    var role = roleOf(cell);
    return tagOf(cell) === "th" || role === "columnheader" || role === "rowheader";
  }

  function cellText(cell, maxChars) {
    var text = collapse(cell.textContent);
    if (text.length > maxChars) return { text: text.slice(0, maxChars), truncated: true };
    return { text: text, truncated: false };
  }

  function readTable(payload) {
    var options = payload || {};
    var maxRows = Math.max(1, Math.min(MAX_ROWS, Number(options.maxRows) || DEFAULT_TABLE_ROWS));
    var maxCols = Math.max(1, Math.min(MAX_COLS, Number(options.maxCols) || MAX_COLS));
    var maxCellChars = Math.max(
      1,
      Math.min(MAX_CELL, Number(options.maxCellChars) || MAX_CELL),
    );
    var root = null;
    if (typeof options.selector === "string" && options.selector !== "") {
      var match = uniqueMatch(options.selector);
      if (!match.ok) return { ok: false, error: match.error };
      root = match.el;
      if (!isTable(root)) {
        var nested = queryAll(root, "table,[role=table],[role=grid]");
        if (nested.length === 0) return { ok: false, error: "Element is not a table or grid" };
        root = nested[0];
      }
    } else {
      var tables = queryAll(doc, "table,[role=table],[role=grid]");
      var visible = [];
      for (var index = 0; index < tables.length; index += 1) {
        if (isVisible(tables[index])) visible.push(tables[index]);
        else if (tables[index] && tagOf(tables[index]) === "table" && tables[index].tBodies) visible.push(tables[index]);
      }
      if (visible.length === 0) return { ok: false, error: "No table found" };
      var wanted = Number.isInteger(options.index) ? options.index : 0;
      if (wanted < 0 || wanted >= visible.length) {
        return { ok: false, error: "Table index " + wanted + " is out of range (" + visible.length + " found)" };
      }
      root = visible[wanted];
    }
    if (!isVisible(root) && !(tagOf(root) === "table" && root.rows)) {
      return { ok: false, error: "Table is not visible" };
    }
    var rows = tableRows(root);
    if (rows.length === 0) return { ok: false, error: "Table has no rows" };
    var firstCells = tableCells(rows[0]);
    var hasHeader =
      firstCells.length > 0 &&
      firstCells.every(function (cell) {
        return headerCell(cell);
      });
    var headerRow = hasHeader ? rows[0] : null;
    var dataRows = hasHeader ? rows.slice(1) : rows;
    var headers = [];
    if (headerRow) {
      var headCells = tableCells(headerRow);
      for (var headIndex = 0; headIndex < headCells.length && headIndex < maxCols; headIndex += 1) {
        headers.push(cellText(headCells[headIndex], maxCellChars).text);
      }
    }
    var grid = [];
    var truncated = false;
    var columnCount = headers.length;
    var produced = 0;
    for (var rowIndex = 0; rowIndex < dataRows.length; rowIndex += 1) {
      if (produced >= maxRows) {
        truncated = true;
        break;
      }
      var cells = tableCells(dataRows[rowIndex]);
      var line = [];
      var next = 0;
      for (var cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
        var cell = cells[cellIndex];
        var column;
        if (typeof cell.cellIndex === "number" && cell.cellIndex >= 0) column = cell.cellIndex;
        else {
          var ariaColumn = parseInt(attr(cell, "aria-colindex"), 10);
          if (!isNaN(ariaColumn) && ariaColumn > 0) column = ariaColumn - 1;
          else {
            column = next;
            while (line[column] !== undefined) column += 1;
          }
        }
        var span = 1;
        if (typeof cell.colSpan === "number" && cell.colSpan > 1) span = cell.colSpan;
        else {
          var attrSpan = parseInt(attr(cell, "colspan"), 10);
          if (!isNaN(attrSpan) && attrSpan > 1) span = attrSpan;
        }
        if (column >= maxCols) {
          truncated = true;
          continue;
        }
        var textResult = cellText(cell, maxCellChars);
        line[column] = textResult.text;
        if (textResult.truncated) truncated = true;
        var boundedSpan = Math.min(span, maxCols - column);
        for (var extra = 1; extra < boundedSpan; extra += 1) {
          if (line[column + extra] === undefined) line[column + extra] = "";
          else truncated = true;
        }
        next = column + boundedSpan;
      }
      var width = Math.min(maxCols, Math.max(line.length, headers.length));
      if (line.length > maxCols) truncated = true;
      if (width > columnCount) columnCount = width;
      var normalized = [];
      for (var columnIndex = 0; columnIndex < width; columnIndex += 1) {
        normalized.push(line[columnIndex] === undefined ? "" : String(line[columnIndex]));
      }
      grid.push(normalized);
      produced += 1;
    }
    for (var headerPad = 0; headerPad < columnCount; headerPad += 1) {
      if (headers[headerPad] === undefined) headers.push("");
    }
    for (var padRowIndex = 0; padRowIndex < grid.length; padRowIndex += 1) {
      while (grid[padRowIndex].length < columnCount) grid[padRowIndex].push("");
    }
    var caption = "";
    if (tagOf(root) === "table") {
      var captionNode = root.caption || queryAll(root, "caption")[0];
      if (captionNode) caption = collapse(captionNode.textContent).slice(0, MAX_NAME);
    }
    if (!caption) caption = collapse(attr(root, "aria-label")).slice(0, MAX_NAME);
    return {
      ok: true,
      url: urlOf(),
      title: titleOf(),
      selector: selectorFor(root),
      caption: caption,
      headers: headers,
      rows: grid,
      rowCount: dataRows.length,
      rowsReturned: grid.length,
      columnCount: columnCount,
      hasHeader: hasHeader,
      truncated: truncated,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* read_form                                                               */
  /* ---------------------------------------------------------------------- */

  function optionSummary(option, maxChars) {
    return {
      value: typeof option.value === "string" ? option.value.slice(0, maxChars) : collapse(option.value).slice(0, maxChars),
      label: collapse(option.textContent).slice(0, MAX_NAME),
      selected: option.selected === true,
      disabled: option.disabled === true,
    };
  }

  function optionValue(option) {
    if (!option) return "";
    if (typeof option.value === "string") return option.value.slice(0, MAX_VALUE);
    return collapse(option.value).slice(0, MAX_VALUE);
  }

  function fieldSummary(el, maxChars, maxOptions) {
    if (!el || el.nodeType !== 1) return null;
    var tag = tagOf(el);
    var type = tag === "input" ? inputType(el) : String(attr(el, "type") || "").toLowerCase();
    if (tag === "input" && type === "hidden") return null;
    var selector = selectorFor(el);
    if (!selector) return null;
    var field = {
      selector: selector,
      tag: tag,
      type: type,
      role: roleOf(el),
      name: (attr(el, "name") || "").slice(0, MAX_NAME),
      id: (attr(el, "id") || "").slice(0, MAX_NAME),
      label: accessibleName(el),
      required: el.required === true || attr(el, "required") !== null,
      disabled: el.disabled === true || attr(el, "aria-disabled") === "true",
      readOnly: el.readOnly === true || attr(el, "readonly") !== null,
      multiple: el.multiple === true,
    };
    field.invalid = el.validity?.valid === false || attr(el, "aria-invalid") === "true";
    if (field.invalid && !sensitiveType(el)) field.validationMessage = String(el.validationMessage || "").slice(0, MAX_NAME);
    var placeholder = attr(el, "placeholder");
    if (placeholder) field.placeholder = collapse(placeholder).slice(0, MAX_NAME);
    var autocomplete = attr(el, "autocomplete");
    if (autocomplete) field.autocomplete = collapse(autocomplete).slice(0, 100);
    if (tag === "input" && (type === "checkbox" || type === "radio")) {
      field.checked = el.checked === true;
      return field;
    }
    if (sensitiveType(el)) {
      field.sensitive = true;
      if (type === "file") field.file = true;
      return field;
    }
    if (tag === "select") {
      var selected = selectedOptionsOf(el);
      field.selectedCount = selected.length;
      if (selected.length > 0 && selected.length <= 5) {
        var selectedValues = [];
        for (var selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
          var selectedValue = optionValue(selected[selectedIndex]);
          if (selectedValue !== "") selectedValues.push(selectedValue);
        }
        if (selectedValues.length > 0) field.selectedValues = selectedValues;
      }
      var options = optionList(el);
      field.options = [];
      for (var optionIndex = 0; optionIndex < options.length && optionIndex < maxOptions; optionIndex += 1) {
        field.options.push(optionSummary(options[optionIndex], maxChars));
      }
      field.optionsTruncated = options.length > field.options.length;
      return field;
    }
    var value = valueOf(el);
    if (value !== null) field.value = value;
    return field;
  }

  function formSummary(form, synthetic, maxFields, maxOptions, maxChars) {
    var summary = {
      selector: synthetic ? null : selectorFor(form),
      synthetic: synthetic === true,
      name: (attr(form, "name") || "").slice(0, MAX_NAME),
      id: (attr(form, "id") || "").slice(0, MAX_NAME),
      action: (attr(form, "action") || "").slice(0, 1000),
      method: (attr(form, "method") || "").toLowerCase().slice(0, 20),
      fields: [],
    };
    var nodes = queryAll(form, FIELD_SELECTOR);
    var elements = null;
    try {
      if (tagOf(form) === "form" && form.elements && typeof form.elements.length === "number") {
        elements = Array.prototype.slice.call(form.elements);
      }
    } catch (error) {
      elements = null;
    }
    if (elements) {
      for (var index = 0; index < elements.length; index += 1) {
        if (nodes.indexOf(elements[index]) === -1) nodes.push(elements[index]);
      }
    }
    var truncated = false;
    for (var nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      var node = nodes[nodeIndex];
      if (node === form || !node || node.nodeType !== 1) continue;
      if (tagOf(node) === "input" && inputType(node) === "hidden") continue;
      if (!isVisible(node)) continue;
      if (summary.fields.length >= maxFields) {
        truncated = true;
        break;
      }
      var field = fieldSummary(node, maxChars, maxOptions);
      if (field) summary.fields.push(field);
    }
    return { form: summary, truncated: truncated };
  }

  function readForm(payload) {
    var options = payload || {};
    var maxFields = Math.max(1, Math.min(MAX_FIELDS, Number(options.maxFields) || DEFAULT_FORM_FIELDS));
    var maxOptions = Math.max(
      1,
      Math.min(MAX_OPTIONS, Number(options.maxOptions) || DEFAULT_FORM_OPTIONS),
    );
    var maxChars = Math.max(1, Math.min(MAX_VALUE, Number(options.maxChars) || MAX_VALUE));
    var forms = [];
    var synthetic = false;
    if (typeof options.selector === "string" && options.selector !== "") {
      var match = uniqueMatch(options.selector);
      if (!match.ok) return { ok: false, error: match.error };
      if (tagOf(match.el) === "form") forms = [match.el];
      else {
        forms = queryAll(match.el, "form");
        if (forms.length === 0) {
          var owner = containingAncestor(match.el, function (node) {
            return tagOf(node) === "form";
          });
          if (owner) {
            forms = [owner];
          } else {
            forms = [match.el];
            synthetic = true;
          }
        }
      }
    } else {
      forms = queryAll(doc, "form");
      var visibleForms = [];
      for (var index = 0; index < forms.length; index += 1) {
        if (isVisible(forms[index])) visibleForms.push(forms[index]);
      }
      forms = visibleForms;
      if (forms.length === 0) {
        forms = [doc ? doc.body || doc.documentElement : null];
        synthetic = true;
      }
    }
    var formIndex = Number.isInteger(options.formIndex) ? options.formIndex : null;
    if (formIndex !== null) {
      if (formIndex < 0 || formIndex >= forms.length) {
        return { ok: false, error: "Form index " + formIndex + " is out of range (" + forms.length + " found)" };
      }
      forms = [forms[formIndex]];
    }
    var result = [];
    var truncated = false;
    var fieldCount = 0;
    for (var formIndex2 = 0; formIndex2 < forms.length; formIndex2 += 1) {
      if (formIndex === null && result.length >= MAX_FORMS) {
        truncated = true;
        break;
      }
      var form = forms[formIndex2];
      if (!form) continue;
      var summary = formSummary(form, synthetic, maxFields, maxOptions, maxChars);
      if (summary.truncated) truncated = true;
      fieldCount += summary.form.fields.length;
      if (summary.form.fields.length > 0 || formIndex !== null || synthetic) result.push(summary.form);
    }
    return {
      ok: true,
      url: urlOf(),
      title: titleOf(),
      forms: result,
      fieldCount: fieldCount,
      truncated: truncated,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* fill_form                                                               */
  /* ---------------------------------------------------------------------- */

  function findFieldByName(name, role) {
    var wanted = collapse(name).toLowerCase();
    if (!wanted) return { ok: false, status: "not_found", error: "Field name is empty" };
    var nodes = queryAll(doc, FIELD_SELECTOR);
    var exact = [];
    var partial = [];
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      if (!node || node.nodeType !== 1) continue;
      if (role && roleOf(node) !== role) continue;
      if (tagOf(node) === "input" && inputType(node) === "hidden") continue;
      var candidates = [accessibleName(node), attr(node, "name"), attr(node, "id")];
      var matchedExact = false;
      var matchedPartial = false;
      for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        var candidate = collapse(candidates[candidateIndex]).toLowerCase();
        if (!candidate) continue;
        if (candidate === wanted) matchedExact = true;
        else if (candidate.indexOf(wanted) !== -1) matchedPartial = true;
      }
      if (matchedExact) exact.push(node);
      else if (matchedPartial) partial.push(node);
    }
    var found = exact.length > 0 ? exact : partial;
    if (found.length === 0) return { ok: false, status: "not_found", error: 'No field matches "' + name + '"' };
    if (found.length > 1) {
      return {
        ok: false,
        status: "ambiguous",
        error: "Field name matches " + found.length + " elements; use a selector",
        matches: found.slice(0, 10).map(function (el) {
          return { selector: selectorFor(el), label: accessibleName(el), tag: tagOf(el) };
        }),
      };
    }
    return { ok: true, el: found[0] };
  }

  function resolveFillTarget(spec) {
    if (!spec || typeof spec !== "object") return { ok: false, status: "failed", error: "Field must be an object" };
    if (typeof spec.selector === "string" && spec.selector !== "") {
      var match = uniqueMatch(spec.selector);
      if (!match.ok) {
        return {
          ok: false,
          status: /matches .* elements/.test(match.error) ? "ambiguous" : "not_found",
          error: match.error,
        };
      }
      return { ok: true, el: match.el };
    }
    if (typeof spec.name === "string") return findFieldByName(spec.name, spec.role);
    return { ok: false, status: "failed", error: "Field requires a selector or name" };
  }

  function fillOne(spec) {
    var resolved = resolveFillTarget(spec);
    if (!resolved.ok) {
      return {
        status: resolved.status || "not_found",
        selector: typeof spec.selector === "string" ? spec.selector.slice(0, MAX_SELECTOR) : null,
        name: typeof spec.name === "string" ? spec.name.slice(0, MAX_NAME) : "",
        error: resolved.error,
        matches: resolved.matches,
      };
    }
    var el = resolved.el;
    var selector = selectorFor(el);
    var base = {
      selector: selector,
      name: (attr(el, "name") || "").slice(0, MAX_NAME),
      tag: tagOf(el),
      type: tagOf(el) === "input" ? inputType(el) : String(attr(el, "type") || "").toLowerCase(),
    };
    function outcome(status, extra) {
      var result = { status: status };
      for (var key in base) if (Object.prototype.hasOwnProperty.call(base, key)) result[key] = base[key];
      if (extra) for (var extraKey in extra) if (Object.prototype.hasOwnProperty.call(extra, extraKey)) result[extraKey] = extra[extraKey];
      return result;
    }
    if (el.disabled === true || attr(el, "aria-disabled") === "true") {
      return outcome("disabled", { error: "Element is disabled" });
    }
    var tag = tagOf(el);
    var type = inputType(el);
    if (tag === "input" && (type === "hidden" || type === "file")) {
      return outcome("sensitive", { error: "Refusing to fill a " + type + " input" });
    }
    if ((tag === "input" || tag === "textarea") && el.readOnly === true) {
      return outcome("read_only", { error: "Element is read-only" });
    }
    if (tag === "select") {
      if (typeof spec.value !== "string") {
        return outcome("unsupported", { error: "A select field requires a value" });
      }
      var selected = applySelection(el, { values: [spec.value], by: "auto", append: false });
      if (!selected.ok) return outcome(selected.status || "failed", { error: selected.error });
      return outcome("filled", { changed: selected.changed, selectedCount: selected.selected.length });
    }
    if (tag === "input" && (type === "checkbox" || type === "radio")) {
      if (typeof spec.checked !== "boolean") {
        return outcome("unsupported", { error: "Checkbox and radio fields require checked:true|false" });
      }
      var checked = applyChecked(el, spec.checked);
      return outcome("filled", {
        changed: checked.changed,
        checked: checked.checked,
        verified: checked.verified,
      });
    }
    if (tag === "input" || tag === "textarea") {
      if (typeof spec.value !== "string") {
        return outcome("unsupported", { error: "A text field requires a value:string" });
      }
      var secretField = sensitiveType(el);
      var beforeValue = secretField ? null : valueOf(el);
      setNativeValue(el, spec.value);
      notifyValueChange(el, spec.value);
      var extra = { valueLength: spec.value.length };
      if (!secretField) extra.changed = beforeValue !== valueOf(el);
      return outcome("filled", extra);
    }
    if (el.isContentEditable === true || roleOf(el) === "textbox" || roleOf(el) === "searchbox") {
      if (typeof spec.value !== "string") {
        return outcome("unsupported", { error: "An editable field requires a value:string" });
      }
      focusQuietly(el);
      try {
        el.textContent = spec.value;
      } catch (error) {
        return outcome("failed", { error: "Could not set editable content" });
      }
      notifyValueChange(el, spec.value);
      return outcome("filled", { changed: true, valueLength: spec.value.length });
    }
    return outcome("unsupported", { error: "Element type is not supported by fill_form" });
  }

  function fillForm(payload) {
    var options = payload || {};
    var documentTime = win?.performance?.timeOrigin;
    if ((options.expectedUrl && options.expectedUrl !== urlOf()) ||
        (options.documentTime !== undefined && options.documentTime !== documentTime)) {
      return { ok: false, url: urlOf(), title: titleOf(), navigated: true };
    }
    var fields = Array.isArray(options.fields) ? options.fields : [];
    if (fields.length === 0) return { ok: false, fatal: true, error: "fill_form requires at least one field" };
    var results = [];
    var ok = true;
    for (var index = 0; index < fields.length; index += 1) {
      var result = fillOne(fields[index] || {});
      results.push(result);
      if (result.status !== "filled") ok = false;
    }
    return { ok: ok, url: urlOf(), title: titleOf(), documentTime: documentTime, results: results };
  }

  /* ---------------------------------------------------------------------- */
  /* select                                                                  */
  /* ---------------------------------------------------------------------- */

  function matchOptionSet(el, wanted, mode) {
    var options = optionList(el);
    var indexes = [];
    for (var index = 0; index < options.length; index += 1) {
      var option = options[index];
      if (!option) continue;
      var value = typeof option.value === "string" ? option.value : collapse(option.value);
      var label = collapse(option.textContent);
      var hit = false;
      for (var wantedIndex = 0; wantedIndex < wanted.length; wantedIndex += 1) {
        var needle = wanted[wantedIndex];
        if (mode === "index") {
          if (index === Number(needle)) hit = true;
        } else if (mode === "value") {
          if (value === String(needle)) hit = true;
        } else if (mode === "label") {
          if (label === String(needle) || label.toLowerCase() === String(needle).toLowerCase()) hit = true;
        } else {
          if (value === String(needle)) hit = true;
          else if (label === String(needle) || label.toLowerCase() === String(needle).toLowerCase()) hit = true;
        }
      }
      if (hit) indexes.push(index);
    }
    return { options: options, indexes: indexes };
  }

  function applySelection(el, options) {
    var multiple = el.multiple === true;
    var mode = options.by === undefined ? "auto" : String(options.by).toLowerCase();
    if (mode !== "auto" && mode !== "value" && mode !== "label" && mode !== "index") {
      return { ok: false, error: "by must be auto, value, label or index" };
    }
    var sets = [];
    if (Array.isArray(options.values) && options.values.length > 0) {
      sets.push(matchOptionSet(el, options.values, mode === "auto" ? "auto" : "value"));
    }
    if (Array.isArray(options.labels) && options.labels.length > 0) {
      sets.push(matchOptionSet(el, options.labels, "label"));
    }
    if (Array.isArray(options.indexes) && options.indexes.length > 0) {
      sets.push(matchOptionSet(el, options.indexes, "index"));
    }
    if (sets.length === 0) return { ok: false, error: "select requires values, labels or indexes" };
    var indexes = [];
    var allOptions = sets[0].options;
    for (var setIndex = 0; setIndex < sets.length; setIndex += 1) {
      for (var indexIndex = 0; indexIndex < sets[setIndex].indexes.length; indexIndex += 1) {
        var wantedIndex = sets[setIndex].indexes[indexIndex];
        if (indexes.indexOf(wantedIndex) === -1) indexes.push(wantedIndex);
      }
    }
    if (indexes.length === 0) {
      var available = [];
      for (var availableIndex = 0; availableIndex < allOptions.length && availableIndex < 10; availableIndex += 1) {
        available.push(optionSummary(allOptions[availableIndex], MAX_NAME));
      }
      return { ok: false, status: "not_found", error: "No option matches the requested value", options: available };
    }
    if (!multiple && indexes.length > 1) {
      return {
        ok: false,
        status: "ambiguous",
        error: "Selection matches " + indexes.length + " options but the select does not allow multiple",
      };
    }
    for (var disabledIndex = 0; disabledIndex < indexes.length; disabledIndex += 1) {
      if (allOptions[indexes[disabledIndex]] && allOptions[indexes[disabledIndex]].disabled === true) {
        return { ok: false, status: "disabled", error: "The matching option is disabled" };
      }
    }
    var beforeSelected = [];
    for (var beforeIndex = 0; beforeIndex < allOptions.length; beforeIndex += 1) {
      if (allOptions[beforeIndex] && allOptions[beforeIndex].selected === true) beforeSelected.push(beforeIndex);
    }
    for (var optionIndex = 0; optionIndex < allOptions.length; optionIndex += 1) {
      if (!allOptions[optionIndex]) continue;
      var want = indexes.indexOf(optionIndex) !== -1;
      if (want) allOptions[optionIndex].selected = true;
      else if (!multiple || options.append !== true) allOptions[optionIndex].selected = false;
      else if (!multiple) allOptions[optionIndex].selected = false;
    }
    if (multiple && options.append === true) {
      for (var keepIndex = 0; keepIndex < beforeSelected.length; keepIndex += 1) {
        if (allOptions[beforeSelected[keepIndex]]) allOptions[beforeSelected[keepIndex]].selected = true;
      }
    }
    notifyValueChange(el, null);
    var selected = [];
    var selectedIndexes = [];
    for (var selectedOptionIndex = 0; selectedOptionIndex < allOptions.length; selectedOptionIndex += 1) {
      if (allOptions[selectedOptionIndex] && allOptions[selectedOptionIndex].selected === true) {
        selected.push(allOptions[selectedOptionIndex]);
        selectedIndexes.push(selectedOptionIndex);
      }
    }
    if (!multiple && selected.length === 0) {
      return { ok: false, status: "failed", error: "The select did not accept the selection" };
    }
    var changed = beforeSelected.length !== selectedIndexes.length;
    if (!changed) {
      for (var compareIndex = 0; compareIndex < selectedIndexes.length; compareIndex += 1) {
        if (beforeSelected.indexOf(selectedIndexes[compareIndex]) === -1) changed = true;
      }
    }
    var summary = [];
    for (var summaryIndex = 0; summaryIndex < selected.length && summaryIndex < MAX_OPTIONS; summaryIndex += 1) {
      var option = optionSummary(selected[summaryIndex], MAX_NAME);
      option.index = selectedIndexes[summaryIndex];
      summary.push(option);
    }
    return { ok: true, multiple: multiple, selected: summary, changed: changed };
  }

  /* ---------------------------------------------------------------------- */
  /* set_checked                                                             */
  /* ---------------------------------------------------------------------- */

  function setChecked(payload) {
    var options = payload || {};
    if (typeof options.selector !== "string" || options.selector === "") {
      return { ok: false, error: "Selector is required" };
    }
    if (typeof options.checked !== "boolean") {
      return { ok: false, error: "checked must be a boolean" };
    }
    var match = uniqueMatch(options.selector);
    if (!match.ok) return { ok: false, error: match.error };
    var el = match.el;
    var selector = selectorFor(el);
    if (el.disabled === true || attr(el, "aria-disabled") === "true") {
      return { ok: false, selector: selector, error: "Element is disabled" };
    }
    var tag = tagOf(el);
    var type = inputType(el);
    if (tag === "input" && (type === "checkbox" || type === "radio")) {
      var result = applyChecked(el, options.checked);
      return {
        ok: result.verified,
        selector: selector,
        mode: "native",
        checked: result.checked,
        changed: result.changed,
        verified: result.verified,
      };
    }
    var role = roleOf(el);
    if (CHECKED_ROLES[role] === true) {
      var aria = applyAriaChecked(el, options.checked);
      return {
        ok: aria.verified,
        selector: selector,
        mode: "aria",
        checked: aria.checked,
        changed: aria.changed,
        verified: aria.verified,
      };
    }
    return {
      ok: false,
      selector: selector,
      error: "Element is not a native checkbox/radio or an ARIA checkbox/switch",
    };
  }

  /* ---------------------------------------------------------------------- */
  /* inspect                                                                 */
  /* ---------------------------------------------------------------------- */

  function attributeSummary(el) {
    var result = {};
    var count = 0;
    var attributes = null;
    try {
      attributes = el.attributes;
    } catch (error) {
      attributes = null;
    }
    if (attributes && typeof attributes.length === "number") {
      for (var index = 0; index < attributes.length && count < MAX_ATTRS; index += 1) {
        var node = attributes.item ? attributes.item(index) : attributes[index];
        if (!node || typeof node.name !== "string") continue;
        var name = node.name.toLowerCase();
        if (name.indexOf("on") === 0) continue;
        if (name === "style") continue;
        if (name === "value" && sensitiveType(el)) continue;
        if (name === "value" && (tagOf(el) === "input" || tagOf(el) === "textarea")) continue;
        result[name] = String(node.value == null ? "" : node.value).slice(0, MAX_VALUE);
        count += 1;
      }
      return result;
    }
    var names = [
      "id", "name", "type", "role", "href", "src", "alt", "title", "placeholder",
      "autocomplete", "inputmode", "action", "method", "aria-label", "aria-labelledby",
      "aria-describedby", "aria-checked", "aria-disabled", "aria-expanded", "aria-hidden",
      "required", "disabled", "readonly", "multiple", "min", "max", "step", "pattern",
    ];
    for (var nameIndex = 0; nameIndex < names.length && count < MAX_ATTRS; nameIndex += 1) {
      var value = attr(el, names[nameIndex]);
      if (value === null) continue;
      if (names[nameIndex] === "value" && sensitiveType(el)) continue;
      result[names[nameIndex]] = String(value).slice(0, MAX_VALUE);
      count += 1;
    }
    return result;
  }

  function obstructionFor(el, rect) {
    if (!rect) return null;
    var point = pointFor(rect);
    var hit = elementFromPoint(point.x, point.y);
    if (!hit || hit === el) return null;
    try {
      if (el.contains && el.contains(hit)) return null;
    } catch (error) {
      /* ignore */
    }
    return {
      selector: selectorFor(hit),
      tag: tagOf(hit),
      role: roleOf(hit),
    };
  }

  function inspectElement(el) {
    var selector = selectorFor(el);
    var tag = tagOf(el);
    var type = tag === "input" ? inputType(el) : String(attr(el, "type") || "").toLowerCase();
    var rect = rectOf(el);
    var visible = isVisible(el);
    var enabled = !(el.disabled === true || attr(el, "aria-disabled") === "true");
    var editable = isEditable(el);
    var checked = el.checked === true || ariaChecked(el);
    var element = {
      selector: selector,
      tag: tag,
      role: roleOf(el),
      name: accessibleName(el),
      type: type,
      id: (attr(el, "id") || "").slice(0, MAX_NAME),
      classes: collapse(attr(el, "class")).split(" ").filter(Boolean).slice(0, 20),
      attributes: attributeSummary(el),
      rect: rect,
    };
    if (tag === "input" && (type === "checkbox" || type === "radio")) element.checked = el.checked === true;
    if (sensitiveType(el)) element.sensitive = true;
    else {
      var value = valueOf(el);
      if (value !== null) element.value = value;
    }
    if (tag === "select") {
      element.multiple = el.multiple === true;
      element.selectedCount = selectedOptionsOf(el).length;
      element.optionsCount = optionList(el).length;
    }
    var form = null;
    try {
      if (el.form && el.form.nodeType === 1) form = el.form;
    } catch (error) {
      form = null;
    }
    if (!form) form = containingAncestor(el, function (node) { return tagOf(node) === "form"; });
    var table = containingAncestor(el, function (node) { return isTable(node); });
    var actionability = {
      visible: visible,
      inViewport: inViewport(rect),
      enabled: enabled,
      editable: editable,
      focusable: enabled && visible,
      obstructedBy: obstructionFor(el, rect),
    };
    var capabilities = {
      click: visible && enabled,
      type: editable,
      fill:
        (tag === "input" && type !== "hidden" && type !== "file") ||
        tag === "textarea" ||
        tag === "select" ||
        el.isContentEditable === true,
      select: tag === "select",
      set_checked:
        (tag === "input" && (type === "checkbox" || type === "radio")) || CHECKED_ROLES[roleOf(el)] === true,
      read_table: isTable(el) || !!table,
      read_form: !!form || tag === "form" || isEditable(el),
    };
    return {
      ok: true,
      mode: "element",
      element: element,
      actionability: actionability,
      capabilities: capabilities,
      associations: {
        formSelector: form ? selectorFor(form) : null,
        tableSelector: table ? selectorFor(table) : null,
        label: accessibleName(el) || null,
        checked: checked,
      },
      coverage: COVERAGE,
    };
  }

  function inspectPage(payload) {
    var options = payload || {};
    var maxElements = Math.max(
      1,
      Math.min(100, Number(options.maxElements) || DEFAULT_INSPECT_ELEMENTS),
    );
    var body = doc ? doc.body || doc.documentElement : null;
    var allCandidates = queryAll(body, CANDIDATE_SELECTOR);
    var visibleCandidates = 0;
    for (var index = 0; index < allCandidates.length; index += 1) {
      if (isVisible(allCandidates[index])) visibleCandidates += 1;
    }
    var tables = queryAll(doc, "table,[role=table],[role=grid]");
    var forms = queryAll(doc, "form");
    var iframes = queryAll(doc, "iframe,frame");
    var collected = collectElements(body, { max: maxElements, withValue: false });
    var hints = [];
    if (iframes.length > 0) hints.push("Frames are not merged; pass frameId to inspect a frame.");
    if (tables.length > 0) hints.push("Use read_table with a selector for exact rows and headers.");
    if (forms.length > 0) hints.push("Use read_form for labels, values and options without submitting.");
    hints.push("Use inspect with a selector for actionability, associations and capability details.");
    return {
      ok: true,
      mode: "page",
      page: {
        url: urlOf(),
        title: titleOf(),
        readyState: doc && typeof doc.readyState === "string" ? doc.readyState : "",
        counts: {
          interactive: allCandidates.length,
          visibleInteractive: visibleCandidates,
          forms: forms.length,
          tables: tables.length,
          iframes: iframes.length,
        },
      },
      elements: collected.elements,
      truncated: collected.truncated,
      coverage: COVERAGE,
      hints: hints,
    };
  }

  function inspect(payload) {
    var options = payload || {};
    if (typeof options.selector === "string" && options.selector !== "") {
      var match = uniqueMatch(options.selector);
      if (!match.ok) return { ok: false, error: match.error };
      return inspectElement(match.el);
    }
    return inspectPage(options);
  }

  /* ---------------------------------------------------------------------- */
  /* Dispatch                                                                */
  /* ---------------------------------------------------------------------- */

  switch (action) {
    case "wait":
      return waitProbe(payload || {});
    case "read_region":
      return readRegion(payload || {});
    case "read_table":
      return readTable(payload || {});
    case "read_form":
      return readForm(payload || {});
    case "fill_form":
      return fillForm(payload || {});
    case "select":
      return (function () {
        var options = payload || {};
        if (typeof options.selector !== "string" || options.selector === "") {
          return { ok: false, error: "Selector is required" };
        }
        var match = uniqueMatch(options.selector);
        if (!match.ok) return { ok: false, error: match.error };
        var el = match.el;
        if (tagOf(el) !== "select") {
          return {
            ok: false,
            selector: selectorFor(el),
            error: "Element is not a native select; use click/type for custom comboboxes",
          };
        }
        if (el.disabled === true || attr(el, "aria-disabled") === "true") {
          return { ok: false, selector: selectorFor(el), error: "Element is disabled" };
        }
        var selection = applySelection(el, options);
        if (!selection.ok) {
          selection.selector = selectorFor(el);
          return selection;
        }
        return {
          ok: true,
          selector: selectorFor(el),
          multiple: selection.multiple,
          selected: selection.selected,
          changed: selection.changed,
        };
      })();
    case "set_checked":
      return setChecked(payload || {});
    case "inspect":
      return inspect(payload || {});
    default:
      return { ok: false, error: "Unknown DOM action: " + String(action) };
  }
}

/**
 * Builds a self-contained expression for Runtime.evaluate. The routed
 * `pageEval(tabId, action, payload, frameId)` in commands.js uses this.
 *
 * @param {string} action
 * @param {object} [payload]
 * @returns {string}
 */
export function buildDomExpression(action, payload) {
  return buildPageExpression(action, payload, domRuntime);
}

export const DOM_TOOL_ACTIONS = Object.freeze([
  "wait",
  "read_region",
  "read_table",
  "read_form",
  "fill_form",
  "select",
  "set_checked",
  "inspect",
]);

/* -------------------------------------------------------------------------- */
/* Service-worker command layer                                               */
/* -------------------------------------------------------------------------- */

function readResult(raw, action) {
  if (!isObject(raw)) throw new Error("DOM action " + action + " returned no data");
  if (raw.ok !== true) throw new Error(typeof raw.error === "string" ? raw.error : "DOM action " + action + " failed");
  return raw;
}

function normalizeFillFields(value) {
  if (!Array.isArray(value)) throw new Error('Parameter "fields" must be an array');
  if (value.length === 0) throw new Error('Parameter "fields" must contain at least one field');
  if (value.length > MAX_FILL_FIELDS) {
    throw new Error('Parameter "fields" must contain at most ' + MAX_FILL_FIELDS + " fields");
  }
  return value.map((item, index) => {
    if (!isObject(item)) throw new Error("Field " + index + " must be an object");
    const hasSelector = item.selector !== undefined && item.selector !== null;
    const hasName = item.name !== undefined && item.name !== null;
    if (!hasSelector && !hasName) throw new Error("Field " + index + ' requires a "selector" or "name"');
    if (hasSelector && hasName) throw new Error("Field " + index + ' must use either "selector" or "name"');
    const field = {};
    if (hasSelector) field.selector = normalizeSelector(item.selector);
    if (hasName) {
      if (typeof item.name !== "string" || item.name.trim() === "") {
        throw new Error("Field " + index + ' has an empty "name"');
      }
      if (item.name.trim().length > 200) throw new Error("Field " + index + ' has a "name" that is too long');
      field.name = item.name.trim();
    }
    if (item.role !== undefined && item.role !== null) {
      if (typeof item.role !== "string" || !/^[a-z]+$/.test(item.role)) {
        throw new Error("Field " + index + ' has an invalid "role"');
      }
      field.role = item.role;
    }
    const hasValue = item.value !== undefined && item.value !== null;
    const hasChecked = item.checked !== undefined && item.checked !== null;
    if (!hasValue && !hasChecked) {
      throw new Error("Field " + index + ' requires "value" or "checked"');
    }
    if (hasValue) {
      if (typeof item.value !== "string") throw new Error("Field " + index + ' has a non-string "value"');
      if (item.value.length > MAX_FILL_VALUE_CHARS) {
        throw new Error("Field " + index + ' has a "value" that is too long');
      }
      field.value = item.value;
    }
    if (hasChecked) {
      field.checked = normalizeBoolean(item.checked, "checked");
    }
    return field;
  });
}

function normalizeWait(options) {
  const selector = options.selector === undefined || options.selector === null
    ? undefined
    : normalizeSelector(options.selector);
  const text = options.text;
  const urlContains = options.urlContains;
  if (text !== undefined && (typeof text !== "string" || text === "")) {
    throw new Error('Parameter "text" must be a non-empty string');
  }
  if (text !== undefined && text.length > 1000) throw new Error('Parameter "text" is too long');
  if (urlContains !== undefined && (typeof urlContains !== "string" || urlContains === "")) {
    throw new Error('Parameter "urlContains" must be a non-empty string');
  }
  if (urlContains !== undefined && urlContains.length > 2000) {
    throw new Error('Parameter "urlContains" is too long');
  }
  const state = options.state === undefined ? undefined : String(options.state).toLowerCase();
  if (state !== undefined && !["visible", "attached", "detached", "hidden", "enabled"].includes(state)) {
    throw new Error('Parameter "state" must be visible, attached, detached, hidden or enabled');
  }
  if (state !== undefined && selector === undefined) {
    throw new Error('Parameter "state" requires a "selector"');
  }
  if (selector === undefined && text === undefined && urlContains === undefined) {
    throw new Error('wait requires "selector", "text" or "urlContains"');
  }
  return {
    selector,
    state,
    text: text === undefined ? undefined : String(text),
    urlContains: urlContains === undefined ? undefined : String(urlContains),
    caseSensitive: normalizeBoolean(options.caseSensitive, "caseSensitive", false),
  };
}

function normalizeRegion(options) {
  const selector = options.selector === undefined || options.selector === null
    ? undefined
    : normalizeSelector(options.selector);
  const hasX = options.x !== undefined && options.x !== null;
  const hasY = options.y !== undefined && options.y !== null;
  const hasWidth = options.width !== undefined && options.width !== null;
  const hasHeight = options.height !== undefined && options.height !== null;
  const anyCoordinate = hasX || hasY || hasWidth || hasHeight;
  if (selector !== undefined && anyCoordinate) {
    throw new Error('read_region accepts either "selector" or coordinates, not both');
  }
  if (anyCoordinate && !(hasX && hasY && hasWidth && hasHeight)) {
    throw new Error('read_region coordinates require "x", "y", "width" and "height" together');
  }
  const payload = {
    selector,
    maxChars: clampInt(options.maxChars, "maxChars", DEFAULT_REGION_CHARS, 1, MAX_REGION_CHARS),
    maxElements: clampInt(options.maxElements, "maxElements", 60, 1, MAX_REGION_ELEMENTS),
  };
  if (anyCoordinate) {
    payload.x = normalizeFinite(options.x, "x");
    payload.y = normalizeFinite(options.y, "y");
    payload.width = normalizeFinite(options.width, "width");
    payload.height = normalizeFinite(options.height, "height");
    if (payload.width <= 0 || payload.height <= 0) {
      throw new Error('Parameters "width" and "height" must be positive');
    }
  }
  return payload;
}

/**
 * Builds the DOM command handlers used by the dispatcher.
 *
 * `pageEval(tabId, action, payload, frameId)` must be the *low-level* evaluator
 * (the one commands.js routes to `buildDomExpression`/`domRuntime`). It must
 * not wrap itself in `session.exclusive`, because these commands serialize
 * their own work per tab. `frameId` is passed through untouched (possibly
 * undefined) on every evaluation.
 *
 * Command contracts:
 *  - wait {tabId,frameId?,selector?,state?,text?,urlContains?,caseSensitive?,
 *      timeoutMs?,intervalMs?}
 *      -> {ok,matched,timedOut,waitedMs,url,title,count,visibleCount,
 *          matchedSelector,hasText,hasUrl,lastError?}
 *      Sleeps outside the tab queue. Fatal selector/condition errors throw.
 *  - read_region -> {url,title,resolvedBy,root,rect,text,elements,truncated}
 *  - read_table  -> {url,title,selector,caption,headers,rows,rowCount,
 *                     rowsReturned,columnCount,hasHeader,truncated}
 *  - read_form   -> {url,title,forms,fieldCount,truncated}
 *  - fill_form   -> {ok,filled,failed,skipped,stopped?,error?,url,title,
 *                     results:[{index,status,selector,name,tag?,type?,
 *                     error?,changed?,checked?,verified?,valueLength?,
 *                     selectedCount?,matches?}]}
 *      Stops with stopped="navigation"|"detached"|"timeout"|"error"; later
 *      fields are reported as skipped. Values are never echoed.
 *  - select      -> {selector,multiple,selected:[{value,label,index}],changed}
 *  - set_checked -> {selector,mode,checked,changed,verified}
 *  - inspect     -> element mode {mode,element,actionability,capabilities,
 *                     associations,coverage} or page mode {mode,page,
 *                     elements,truncated,coverage,hints}
 *
 * Expected page-level failures from read/select/checkbox commands throw an
 * Error with the page error text. fill_form reports them per field instead.
 *
 * @param {{
 *   pageEval: (tabId: number, action: string, payload: object, frameId?: string) => Promise<unknown>,
 *   session: {exclusive: (tabId: number, task: () => Promise<unknown>) => Promise<unknown>},
 * }} options
 */
export function createDomTools({ pageEval, session } = {}) {
  if (typeof pageEval !== "function") throw new Error("createDomTools requires pageEval");
  if (!session || typeof session.exclusive !== "function") {
    throw new Error("createDomTools requires a debugger session");
  }

  async function runDom(tabId, action, payload, frameId) {
    const raw = await pageEval(tabId, action, payload, frameId);
    if (raw === undefined || raw === null) {
      throw new Error("DOM action " + action + " returned no data");
    }
    return raw;
  }

  function exclusive(tabId, task) {
    return session.exclusive(tabId, task);
  }

  async function wait(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const frameId = normalizeFrameId(p.frameId);
    const probe = normalizeWait(p);
    const timeoutMs = clampInt(
      p.timeoutMs,
      "timeoutMs",
      WAIT_DEFAULT_TIMEOUT_MS,
      WAIT_MIN_TIMEOUT_MS,
      WAIT_MAX_TIMEOUT_MS,
    );
    const intervalMs = clampInt(
      p.intervalMs,
      "intervalMs",
      WAIT_DEFAULT_INTERVAL_MS,
      WAIT_MIN_INTERVAL_MS,
      WAIT_MAX_INTERVAL_MS,
    );
    const started = Date.now();
    let last = null;
    let lastError = null;
    for (;;) {
      try {
        last = await exclusive(tabId, () => runDom(tabId, "wait", probe, frameId));
      } catch (error) {
        lastError = abortText(error);
        if (isNavigationError(lastError)) lastError = "Page navigated while waiting: " + lastError;
        else if (isDetachError(lastError)) {
          return {
            ok: false,
            matched: false,
            timedOut: false,
            waitedMs: Date.now() - started,
            error: lastError,
          };
        }
      }
      if (isObject(last)) {
        if (last.ok === false && last.fatal === true) {
          throw new Error(typeof last.error === "string" ? last.error : "wait failed");
        }
        if (last.ok === true && last.matched === true) {
          return {
            ok: true,
            matched: true,
            timedOut: false,
            waitedMs: Date.now() - started,
            url: typeof last.url === "string" ? last.url : "",
            title: typeof last.title === "string" ? last.title : "",
            count: typeof last.count === "number" ? last.count : 0,
            visibleCount: typeof last.visibleCount === "number" ? last.visibleCount : 0,
            matchedSelector: last.matchedSelector === true,
            hasText: last.hasText === true,
            hasUrl: last.hasUrl === true,
          };
        }
      }
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) {
        return {
          ok: false,
          matched: false,
          timedOut: true,
          waitedMs: elapsed,
          url: isObject(last) && typeof last.url === "string" ? last.url : "",
          title: isObject(last) && typeof last.title === "string" ? last.title : "",
          lastError: lastError || undefined,
        };
      }
      // The sleep happens outside `session.exclusive` so waits never starve
      // queued mutations for the same tab.
      await sleep(Math.min(intervalMs, timeoutMs - elapsed));
    }
  }

  async function read_region(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const frameId = normalizeFrameId(p.frameId);
    const payload = normalizeRegion(p);
    const raw = readResult(
      await exclusive(tabId, () => runDom(tabId, "read_region", payload, frameId)),
      "read_region",
    );
    return {
      url: typeof raw.url === "string" ? raw.url : "",
      title: typeof raw.title === "string" ? raw.title : "",
      resolvedBy: typeof raw.resolvedBy === "string" ? raw.resolvedBy : "document",
      root: isObject(raw.root)
        ? {
            selector: typeof raw.root.selector === "string" ? raw.root.selector : null,
            tag: typeof raw.root.tag === "string" ? raw.root.tag : "",
            role: typeof raw.root.role === "string" ? raw.root.role : "",
            name: sanitizeValue(raw.root.name, 200),
            rect: isObject(raw.root.rect) ? raw.root.rect : null,
          }
        : null,
      rect: isObject(raw.rect) ? raw.rect : null,
      text: sanitizeValue(raw.text, MAX_REGION_CHARS),
      elements: sanitizeElements(raw.elements, MAX_REGION_ELEMENTS),
      truncated: raw.truncated === true,
    };
  }

  async function read_table(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const frameId = normalizeFrameId(p.frameId);
    const payload = {
      selector: p.selector === undefined || p.selector === null ? undefined : normalizeSelector(p.selector),
      index: p.index === undefined || p.index === null ? undefined : clampInt(p.index, "index", 0, 0, 10000),
      maxRows: clampInt(p.maxRows, "maxRows", DEFAULT_TABLE_ROWS, 1, MAX_TABLE_ROWS),
      maxCols: clampInt(p.maxCols, "maxCols", MAX_TABLE_CELLS, 1, MAX_TABLE_CELLS),
      maxCellChars: clampInt(p.maxCellChars, "maxCellChars", MAX_TABLE_CELL_CHARS, 1, MAX_TABLE_CELL_CHARS),
    };
    const raw = readResult(
      await exclusive(tabId, () => runDom(tabId, "read_table", payload, frameId)),
      "read_table",
    );
    const headers = Array.isArray(raw.headers)
      ? raw.headers.slice(0, MAX_TABLE_CELLS).map((cell) => sanitizeValue(cell, MAX_TABLE_CELL_CHARS))
      : [];
    const rows = Array.isArray(raw.rows)
      ? raw.rows.slice(0, MAX_TABLE_ROWS).map((row) =>
          Array.isArray(row)
            ? row.slice(0, MAX_TABLE_CELLS).map((cell) => sanitizeValue(cell, MAX_TABLE_CELL_CHARS))
            : [],
        )
      : [];
    return {
      url: typeof raw.url === "string" ? raw.url : "",
      title: typeof raw.title === "string" ? raw.title : "",
      selector: typeof raw.selector === "string" ? raw.selector : null,
      caption: sanitizeValue(raw.caption, 200),
      headers,
      rows,
      rowCount: typeof raw.rowCount === "number" ? raw.rowCount : rows.length,
      rowsReturned: typeof raw.rowsReturned === "number" ? raw.rowsReturned : rows.length,
      columnCount: typeof raw.columnCount === "number" ? raw.columnCount : headers.length,
      hasHeader: raw.hasHeader === true,
      truncated: raw.truncated === true,
    };
  }

  async function read_form(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const frameId = normalizeFrameId(p.frameId);
    const payload = {
      selector: p.selector === undefined || p.selector === null ? undefined : normalizeSelector(p.selector),
      formIndex: p.formIndex === undefined || p.formIndex === null
        ? undefined
        : clampInt(p.formIndex, "formIndex", 0, 0, 10000),
      maxFields: clampInt(p.maxFields, "maxFields", 60, 1, MAX_FORM_FIELDS),
      maxOptions: clampInt(p.maxOptions, "maxOptions", 30, 1, MAX_FORM_OPTIONS),
    };
    const raw = readResult(
      await exclusive(tabId, () => runDom(tabId, "read_form", payload, frameId)),
      "read_form",
    );
    const forms = Array.isArray(raw.forms)
      ? raw.forms.slice(0, MAX_FORMS).map((form) => {
          if (!isObject(form)) return null;
          const fields = Array.isArray(form.fields)
            ? form.fields.slice(0, MAX_FORM_FIELDS).map((field) => sanitizeField(field)).filter(Boolean)
            : [];
          return {
            selector: typeof form.selector === "string" ? form.selector : null,
            synthetic: form.synthetic === true,
            name: sanitizeValue(form.name, 200),
            id: sanitizeValue(form.id, 200),
            action: sanitizeValue(form.action, 1000),
            method: sanitizeValue(form.method, 20),
            fields,
          };
        }).filter(Boolean)
      : [];
    return {
      url: typeof raw.url === "string" ? raw.url : "",
      title: typeof raw.title === "string" ? raw.title : "",
      forms,
      fieldCount: typeof raw.fieldCount === "number" ? raw.fieldCount : 0,
      truncated: raw.truncated === true,
    };
  }

  function sanitizeField(field) {
    if (!isObject(field) || typeof field.selector !== "string" || field.selector === "") return null;
    const type = typeof field.type === "string" ? field.type : "";
    const tag = typeof field.tag === "string" ? field.tag : "";
    const sensitive = tag === "input" && (type === "password" || type === "hidden" || type === "file");
    const result = {
      selector: field.selector,
      tag,
      type,
      role: typeof field.role === "string" ? field.role : "",
      name: sanitizeValue(field.name, 200),
      id: sanitizeValue(field.id, 200),
      label: sanitizeValue(field.label, 200),
      required: field.required === true,
      invalid: field.invalid === true,
      disabled: field.disabled === true,
      readOnly: field.readOnly === true,
      multiple: field.multiple === true,
    };
    if (typeof field.placeholder === "string" && field.placeholder !== "") {
      result.placeholder = sanitizeValue(field.placeholder, 200);
    }
    if (field.invalid && !sensitive && field.validationMessage) result.validationMessage = sanitizeValue(field.validationMessage, 200);
    if (typeof field.autocomplete === "string" && field.autocomplete !== "") {
      result.autocomplete = sanitizeValue(field.autocomplete, 100);
    }
    if (typeof field.checked === "boolean") result.checked = field.checked;
    if (sensitive) {
      result.sensitive = true;
      if (type === "file") result.file = true;
      return result;
    }
    if (Array.isArray(field.selectedValues)) {
      result.selectedValues = field.selectedValues
        .slice(0, 5)
        .map((value) => sanitizeValue(value, 1000));
    }
    if (typeof field.selectedCount === "number") result.selectedCount = field.selectedCount;
    if (Array.isArray(field.options)) {
      result.options = field.options.slice(0, MAX_FORM_OPTIONS).map((option) => ({
        value: sanitizeValue(option && option.value, 1000),
        label: sanitizeValue(option && option.label, 200),
        selected: !!(option && option.selected === true),
        disabled: !!(option && option.disabled === true),
      }));
    }
    if (typeof field.optionsTruncated === "boolean") result.optionsTruncated = field.optionsTruncated;
    if (typeof field.value === "string" && field.value !== "") {
      result.value = field.value.slice(0, 1000);
    }
    return result;
  }

  async function fill_form(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const frameId = normalizeFrameId(p.frameId);
    const fields = normalizeFillFields(p.fields);
    return exclusive(tabId, async () => {
      const started = Date.now();
      const results = [];
      let stopped = null;
      let stopError = null;
      let baselineUrl = null;
      let documentTime;
      let lastUrl = "";
      let lastTitle = "";
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (stopped) {
          results.push({
            index,
            status: "skipped",
            selector: field.selector || null,
            name: field.name || "",
            reason: stopped,
          });
          continue;
        }
        if (Date.now() - started > FILL_DEADLINE_MS) {
          stopped = "timeout";
          stopError = "fill_form exceeded its bounded time budget";
          results.push({
            index,
            status: "skipped",
            selector: field.selector || null,
            name: field.name || "",
            reason: "timeout",
          });
          continue;
        }
        let raw = null;
        try {
          raw = await runDom(tabId, "fill_form", { fields: [field], expectedUrl: baselineUrl, documentTime }, frameId);
        } catch (error) {
          const message = abortText(error);
          if (isNavigationError(message)) {
            stopped = "navigation";
            stopError = message;
            results.push({
              index,
              status: "unknown",
              selector: field.selector || null,
              name: field.name || "",
              error: "Page navigated or its context was replaced; the field may already have run",
            });
          } else if (isDetachError(message)) {
            stopped = "detached";
            stopError = message;
            results.push({
              index,
              status: "unknown",
              selector: field.selector || null,
              name: field.name || "",
              error: "Tab or debugger detached; the field may already have run",
            });
          } else {
            stopped = "error";
            stopError = message;
            results.push({
              index,
              status: "failed",
              selector: field.selector || null,
              name: field.name || "",
              error: message,
            });
          }
          continue;
        }
        if (!isObject(raw)) {
          stopped = "error";
          stopError = "fill_form returned no data";
          results.push({
            index,
            status: "failed",
            selector: field.selector || null,
            name: field.name || "",
            error: stopError,
          });
          continue;
        }
        if (raw.navigated) {
          stopped = "navigation";
          stopError = "Page changed while filling";
          results.push({ index, status: "skipped", selector: field.selector || null, reason: stopped });
          continue;
        }
        if (documentTime === undefined) documentTime = raw.documentTime;
        if (typeof raw.url === "string" && raw.url !== "") {
          lastUrl = raw.url;
          if (baselineUrl === null) baselineUrl = raw.url;
          else if (raw.url !== baselineUrl) {
            stopped = "navigation";
            stopError = "Page URL changed while filling";
          }
        }
        if (typeof raw.title === "string") lastTitle = raw.title;
        if (raw.ok === false && raw.fatal === true) throw new Error(raw.error || "fill_form failed");
        const fieldResult = Array.isArray(raw.results) && isObject(raw.results[0]) ? raw.results[0] : null;
        if (!fieldResult) {
          results.push({
            index,
            status: "failed",
            selector: field.selector || null,
            name: field.name || "",
            error: "No per-field result returned",
          });
          continue;
        }
        const entry = {
          index,
          status: typeof fieldResult.status === "string" ? fieldResult.status : "failed",
          selector: fieldResult.selector || field.selector || null,
          name: fieldResult.name || field.name || "",
        };
        if (typeof fieldResult.tag === "string") entry.tag = fieldResult.tag;
        if (typeof fieldResult.type === "string") entry.type = fieldResult.type;
        if (typeof fieldResult.error === "string") entry.error = abortText(fieldResult.error);
        if (typeof fieldResult.changed === "boolean") entry.changed = fieldResult.changed;
        if (typeof fieldResult.checked === "boolean") entry.checked = fieldResult.checked;
        if (typeof fieldResult.verified === "boolean") entry.verified = fieldResult.verified;
        if (typeof fieldResult.valueLength === "number") entry.valueLength = fieldResult.valueLength;
        if (typeof fieldResult.selectedCount === "number") entry.selectedCount = fieldResult.selectedCount;
        if (Array.isArray(fieldResult.matches)) {
          entry.matches = fieldResult.matches.slice(0, 10).map((match) => ({
            selector: sanitizeValue(match && match.selector, MAX_SELECTOR_LENGTH),
            label: sanitizeValue(match && match.label, 200),
            tag: sanitizeValue(match && match.tag, 40),
          }));
        }
        results.push(entry);
        if (stopped === "navigation") {
          // The field itself still produced a result; remaining fields are skipped.
          continue;
        }
      }
      const filled = results.filter((item) => item.status === "filled").length;
      const failed = results.filter((item) =>
        ["failed", "not_found", "ambiguous", "unsupported", "disabled", "read_only", "sensitive", "unknown"].includes(
          item.status,
        ),
      ).length;
      return {
        ok: stopped === null && filled === results.length,
        filled,
        failed,
        skipped: results.filter((item) => item.status === "skipped").length,
        stopped: stopped || undefined,
        error: stopError ? abortText(stopError) : undefined,
        url: lastUrl,
        title: lastTitle,
        results,
      };
    });
  }

  async function select(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const frameId = normalizeFrameId(p.frameId);
    const selector = normalizeSelector(p.selector);
    const payload = { selector };
    const hasValues = p.values !== undefined && p.values !== null;
    const hasLabels = p.labels !== undefined && p.labels !== null;
    const hasIndexes = p.indexes !== undefined && p.indexes !== null;
    const provided = [hasValues, hasLabels, hasIndexes].filter(Boolean).length;
    if (provided === 0) throw new Error('select requires "values", "labels" or "indexes"');
    if (provided > 1) throw new Error('select accepts only one of "values", "labels" or "indexes"');
    if (hasValues) {
      if (!Array.isArray(p.values) || p.values.length === 0) throw new Error('Parameter "values" must be a non-empty array');
      if (p.values.length > MAX_SELECT_VALUES) throw new Error('Parameter "values" has too many entries');
      payload.values = p.values.map((value) => {
        if (typeof value !== "string") throw new Error('Parameter "values" must contain strings');
        if (value.length > 1000) throw new Error('Parameter "values" contains an overlong entry');
        return value;
      });
    }
    if (hasLabels) {
      if (!Array.isArray(p.labels) || p.labels.length === 0) throw new Error('Parameter "labels" must be a non-empty array');
      if (p.labels.length > MAX_SELECT_VALUES) throw new Error('Parameter "labels" has too many entries');
      payload.labels = p.labels.map((label) => {
        if (typeof label !== "string" || label === "") throw new Error('Parameter "labels" must contain non-empty strings');
        if (label.length > 1000) throw new Error('Parameter "labels" contains an overlong entry');
        return label;
      });
    }
    if (hasIndexes) {
      if (!Array.isArray(p.indexes) || p.indexes.length === 0) throw new Error('Parameter "indexes" must be a non-empty array');
      if (p.indexes.length > MAX_SELECT_VALUES) throw new Error('Parameter "indexes" has too many entries');
      payload.indexes = p.indexes.map((index) => {
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
          throw new Error('Parameter "indexes" must contain non-negative integers');
        }
        return index;
      });
    }
    if (p.by !== undefined && p.by !== null) {
      if (typeof p.by !== "string" || !["auto", "value", "label", "index"].includes(p.by)) {
        throw new Error('Parameter "by" must be auto, value, label or index');
      }
      payload.by = p.by;
      const matching = { value: hasValues, label: hasLabels, index: hasIndexes };
      if (p.by !== "auto" && matching[p.by] !== true) {
        throw new Error('Parameter "by" does not match the provided match list');
      }
    }
    if (p.append !== undefined && p.append !== null) {
      payload.append = normalizeBoolean(p.append, "append", false);
    }
    const raw = readResult(
      await exclusive(tabId, () => runDom(tabId, "select", payload, frameId)),
      "select",
    );
    return {
      selector: typeof raw.selector === "string" ? raw.selector : selector,
      multiple: raw.multiple === true,
      selected: Array.isArray(raw.selected)
        ? raw.selected.slice(0, MAX_SELECT_VALUES).map((option) => ({
            value: sanitizeValue(option && option.value, 1000),
            label: sanitizeValue(option && option.label, 200),
            index: typeof (option && option.index) === "number" ? option.index : undefined,
            selected: true,
          }))
        : [],
      changed: raw.changed === true,
    };
  }

  async function set_checked(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const frameId = normalizeFrameId(p.frameId);
    const selector = normalizeSelector(p.selector);
    if (typeof p.checked !== "boolean") throw new Error('Parameter "checked" must be a boolean');
    const checked = p.checked;
    const raw = readResult(
      await exclusive(tabId, () =>
        runDom(tabId, "set_checked", { selector, checked }, frameId),
      ),
      "set_checked",
    );
    return {
      selector: typeof raw.selector === "string" ? raw.selector : selector,
      mode: raw.mode === "aria" ? "aria" : "native",
      checked: raw.checked === true,
      changed: raw.changed === true,
      verified: raw.verified === true,
    };
  }

  async function inspect(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const frameId = normalizeFrameId(p.frameId);
    const payload = {
      selector: p.selector === undefined || p.selector === null ? undefined : normalizeSelector(p.selector),
      maxElements: clampInt(p.maxElements, "maxElements", 20, 1, MAX_INSPECT_ELEMENTS),
    };
    const raw = readResult(
      await exclusive(tabId, () => runDom(tabId, "inspect", payload, frameId)),
      "inspect",
    );
    if (raw.mode === "page") {
      return {
        mode: "page",
        page: isObject(raw.page) ? raw.page : {},
        elements: sanitizeElements(raw.elements, MAX_INSPECT_ELEMENTS),
        truncated: raw.truncated === true,
        coverage: isObject(raw.coverage) ? raw.coverage : {},
        hints: Array.isArray(raw.hints) ? raw.hints.slice(0, 10).map((hint) => sanitizeValue(hint, 300)) : [],
      };
    }
    return {
      mode: "element",
      element: isObject(raw.element) ? sanitizeInspectElement(raw.element) : null,
      actionability: isObject(raw.actionability) ? raw.actionability : {},
      capabilities: isObject(raw.capabilities) ? raw.capabilities : {},
      associations: isObject(raw.associations) ? raw.associations : {},
      coverage: isObject(raw.coverage) ? raw.coverage : {},
    };
  }

  function sanitizeInspectElement(element) {
    const tag = typeof element.tag === "string" ? element.tag : "";
    const type = typeof element.type === "string" ? element.type : "";
    const sensitive = tag === "input" && (type === "password" || type === "hidden" || type === "file");
    const result = {
      selector: typeof element.selector === "string" ? element.selector : null,
      tag,
      role: typeof element.role === "string" ? element.role : "",
      name: sanitizeValue(element.name, 200),
      type,
      id: sanitizeValue(element.id, 200),
      classes: Array.isArray(element.classes)
        ? element.classes.slice(0, 20).map((value) => sanitizeValue(value, 100))
        : [],
      attributes: sanitizeAttributes(element.attributes, sensitive),
      rect: isObject(element.rect) ? element.rect : null,
    };
    if (sensitive) result.sensitive = true;
    else if (typeof element.value === "string" && element.value !== "") {
      result.value = element.value.slice(0, 1000);
    }
    if (typeof element.checked === "boolean") result.checked = element.checked;
    if (typeof element.multiple === "boolean") result.multiple = element.multiple;
    if (typeof element.selectedCount === "number") result.selectedCount = element.selectedCount;
    if (typeof element.optionsCount === "number") result.optionsCount = element.optionsCount;
    return result;
  }

  function sanitizeAttributes(attributes, sensitive) {
    if (!isObject(attributes)) return {};
    const result = {};
    const names = Object.keys(attributes).slice(0, 30);
    for (const name of names) {
      if (typeof name !== "string") continue;
      const lower = name.toLowerCase();
      if (lower === "value" && sensitive) continue;
      if (lower.startsWith("on")) continue;
      const value = attributes[name];
      result[lower] = sanitizeValue(value == null ? "" : String(value), 1000);
    }
    return result;
  }

  return {
    wait,
    read_region,
    read_table,
    read_form,
    fill_form,
    select,
    set_checked,
    inspect,
  };
}
