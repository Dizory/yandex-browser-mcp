// Page-context routines for the bridge.
//
// `pageRuntime` is serialized with Function.prototype.toString and evaluated
// inside the tab through CDP Runtime.evaluate. Keep it fully self-contained: it
// must not reference module-scope bindings, because those do not exist in the
// page. `buildPageExpression` wraps it with the page globals and JSON arguments.

/**
 * CSS selector used to discover candidate interactive elements. Passed to the
 * page runtime explicitly so the runtime itself stays free of outer bindings.
 */
export const SNAPSHOT_CANDIDATE_SELECTOR = [
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

/**
 * Runs one page action. Serialized into the tab; do not call directly from the
 * service worker except in tests with a fake DOM context.
 *
 * Actions:
 *  - snapshot: {maxChars, candidates} -> {url,title,text,elements,truncated}
 *  - locate:   {selector} -> {ok, x, y} | {ok:false, error}
 *  - focus:    {selector} -> {ok, editable} | {ok:false, error}
 *  - focused:  {} -> {ok, editable} | {ok:false, error}
 *  - viewport: {} -> {width, height}
 *
 * @param {{document: Document, window: Window, getComputedStyle: Function}} ctx
 * @param {string} action
 * @param {object} payload
 */
export function pageRuntime(ctx, action, payload) {
  "use strict";
  var doc = ctx && ctx.document ? ctx.document : null;
  var win = ctx && ctx.window ? ctx.window : null;
  var getStyle = ctx && typeof ctx.getComputedStyle === "function" ? ctx.getComputedStyle : null;
  var MAX_ELEMENTS = 300;
  var MAX_NAME = 200;
  var MAX_VALUE = 300;
  var MAX_SELECTOR = 5000;
  var MAX_TEXT = 100000;
  var NON_TEXT_INPUT_TYPES = [
    "button",
    "submit",
    "reset",
    "checkbox",
    "radio",
    "file",
    "image",
    "range",
    "color",
    "hidden",
  ];
  var DEFAULT_CANDIDATES =
    'a[href],button,input,select,textarea,[role="button"],[role="link"],[contenteditable="true"]';

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

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    if (attr(el, "aria-hidden") === "true") return false;
    try {
      if (el.closest && el.closest('[aria-hidden="true"]')) return false;
    } catch (error) {
      /* ignore */
    }
    var rect = null;
    try {
      rect = el.getBoundingClientRect();
    } catch (error) {
      rect = null;
    }
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

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = tagOf(el);
    if (tag === "textarea") return el.readOnly !== true && el.disabled !== true;
    if (tag === "input") {
      var type = String(attr(el, "type") || "text").toLowerCase();
      if (NON_TEXT_INPUT_TYPES.indexOf(type) !== -1) return false;
      return el.readOnly !== true && el.disabled !== true;
    }
    if (el.isContentEditable === true) return true;
    var role = String(attr(el, "role") || "").toLowerCase();
    return role === "textbox" || role === "searchbox" || role === "combobox";
  }

  // Minimal CSS.escape fallback so selector generation works in every context.
  function cssEscape(value) {
    var string = String(value);
    if (win && win.CSS && typeof win.CSS.escape === "function") {
      try {
        return win.CSS.escape(string);
      } catch (error) {
        /* fall through to the manual implementation */
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

  // Builds a selector that resolves back to exactly this element without
  // touching the DOM. Returns null for shadow-DOM content (not reachable from
  // the main document) and for exotic SVG tag names.
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
    var type = String(attr(el, "type") || "text").toLowerCase();
    if (tag === "a") return attr(el, "href") ? "link" : "";
    if (tag === "button") return "button";
    if (tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
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
    var type = String(attr(el, "type") || "").toLowerCase();
    if (tag === "input" && (type === "submit" || type === "button" || type === "reset")) {
      var inputValue = collapse(attr(el, "value"));
      if (inputValue) return inputValue.slice(0, MAX_NAME);
    }
    var text = collapse(el.textContent);
    return text ? text.slice(0, MAX_NAME) : "";
  }

  // Password, hidden and file input values are never read:
  // the check happens before the `value` property is touched.
  function valueOf(el) {
    var tag = tagOf(el);
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return null;
    var type = String(attr(el, "type") || "").toLowerCase();
    if (tag === "input" && (type === "password" || type === "hidden" || type === "file")) return null;
    var value;
    try {
      value = el.value;
    } catch (error) {
      return null;
    }
    if (typeof value !== "string" || value.length === 0) return null;
    return value.slice(0, MAX_VALUE);
  }

  function queryCandidates(options) {
    var custom =
      options && typeof options.candidates === "string" && options.candidates.length > 0
        ? options.candidates
        : "";
    if (!doc || typeof doc.querySelectorAll !== "function") return [];
    try {
      return doc.querySelectorAll(custom || DEFAULT_CANDIDATES) || [];
    } catch (error) {
      return [];
    }
  }

  function collectElements(options, finding) {
    var query = finding ? collapse(options.name).toLowerCase() : "";
    var elements = [];
    var truncated = false;
    var nodes = queryCandidates(options || {});
    for (var index = 0; index < nodes.length; index += 1) {
      var el = nodes[index];
      if (!el || el.nodeType !== 1) continue;
      if (el.disabled === true) continue;
      if (attr(el, "aria-disabled") === "true") continue;
      if (tagOf(el) === "input" && String(attr(el, "type") || "").toLowerCase() === "hidden") continue;
      if (!isVisible(el)) continue;
      var role = roleOf(el);
      if (finding && options.role && role !== options.role) continue;
      var name = accessibleName(el);
      if (finding && !name.toLowerCase().includes(query)) continue;
      var selector = selectorFor(el);
      if (!selector) continue;
      if (elements.length >= (finding ? 10 : MAX_ELEMENTS)) {
        truncated = true;
        break;
      }
      var tag = tagOf(el);
      var summary = {
        selector: selector,
        tag: tag,
        role: role,
        name: name,
        type: String(attr(el, "type") || (tag === "input" ? "text" : "")).toLowerCase(),
      };
      var value = finding ? null : valueOf(el);
      if (value !== null) summary.value = value;
      elements.push(summary);
    }

    return { elements: elements, truncated: truncated };
  }

  function snapshot(options) {
    var requested = options.maxChars == null ? 20000 : Number(options.maxChars);
    var maxChars = Math.max(1, Math.min(MAX_TEXT, isFinite(requested) ? Math.floor(requested) : 20000));
    var matches = collectElements(options, false);
    var truncated = matches.truncated;
    var text = "";
    var root = doc ? doc.body || doc.documentElement : null;
    if (root) {
      try {
        text = typeof root.innerText === "string" ? root.innerText : String(root.textContent || "");
      } catch (error) {
        text = "";
      }
    }
    text = String(text)
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }

    var url = "";
    try {
      url = String((win && win.location && win.location.href) || (doc && doc.URL) || "");
    } catch (error) {
      url = "";
    }
    var title = "";
    try {
      title = String((doc && doc.title) || "");
    } catch (error) {
      title = "";
    }
    return { url: url, title: title, text: text, elements: matches.elements, truncated: truncated, documentTime: win?.performance?.timeOrigin };
  }

  function uniqueMatch(selector) {
    if (!doc || typeof doc.querySelectorAll !== "function") {
      return { ok: false, error: "No document available" };
    }
    var nodes;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch (error) {
      return { ok: false, error: "Invalid CSS selector" };
    }
    if (!nodes || nodes.length === 0) return { ok: false, error: "No element matches selector" };
    if (nodes.length > 1) {
      return {
        ok: false,
        error: "Selector matches " + nodes.length + " elements; expected exactly one",
      };
    }
    return { ok: true, el: nodes[0] };
  }

  function scrollIntoView(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch (error) {
      try {
        el.scrollIntoView();
      } catch (innerError) {
        /* ignore */
      }
    }
  }

  function locate(selector, scroll) {
    if (!selector) return { ok: false, error: "Selector is required" };
    var match = uniqueMatch(selector);
    if (!match.ok) return { ok: false, error: match.error };
    var el = match.el;
    if (scroll !== false) scrollIntoView(el);
    if (!isVisible(el)) return { ok: false, error: "Element is not visible" };
    if (el.disabled === true || attr(el, "aria-disabled") === "true") {
      return { ok: false, error: "Element is disabled" };
    }
    var rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (error) {
      rect = null;
    }
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
      return { ok: false, error: "Element is not visible" };
    }
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
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
    if (!(x >= 0) || !(y >= 0) || (width > 0 && x > width) || (height > 0 && y > height)) {
      return { ok: false, error: "Element is outside the viewport" };
    }
    if (typeof doc.elementFromPoint === "function") {
      var hit = doc.elementFromPoint(x, y);
      if (!hit || (hit !== el && !el.contains(hit))) {
        return { ok: false, error: "Element is covered by another element" };
      }
    }
    return { ok: true, x: x, y: y };
  }

  function focusElement(selector) {
    if (!selector) return { ok: false, error: "Selector is required" };
    var match = uniqueMatch(selector);
    if (!match.ok) return { ok: false, error: match.error };
    var el = match.el;
    scrollIntoView(el);
    if (!isVisible(el)) return { ok: false, error: "Element is not visible" };
    if (!isEditable(el)) return { ok: false, error: "Element is not editable" };
    var focused = false;
    try {
      if (typeof el.focus === "function") {
        el.focus({ preventScroll: true });
        focused = true;
      }
    } catch (error) {
      try {
        el.focus();
        focused = true;
      } catch (innerError) {
        focused = false;
      }
    }
    if (!focused) return { ok: false, error: "Could not focus element" };
    if (
      doc.activeElement &&
      doc.activeElement !== el &&
      !(typeof el.contains === "function" && el.contains(doc.activeElement))
    ) {
      return { ok: false, error: "Could not focus element" };
    }
    return { ok: true, editable: true };
  }

  function focusedElement() {
    var active = doc ? doc.activeElement : null;
    if (!active || active === doc.body || active === doc.documentElement) {
      return { ok: false, error: "No focused element" };
    }
    if (!isEditable(active)) return { ok: false, error: "Focused element is not editable" };
    return { ok: true, editable: true };
  }

  function viewport() {
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
    return { width: width, height: height };
  }

  switch (action) {
    case "snapshot":
      return snapshot(payload || {});
    case "find":
      return collectElements(payload, true);
    case "locate":
      return locate(String((payload && payload.selector) || ""), payload?.scroll);
    case "focus":
      return focusElement(String((payload && payload.selector) || ""));
    case "focused":
      return focusedElement();
    case "viewport":
      return viewport();
    default:
      return { ok: false, error: "Unknown page action: " + String(action) };
  }
}

/**
 * Builds a self-contained expression for Runtime.evaluate.
 *
 * @param {string} action
 * @param {object} [payload]
 * @returns {string}
 */
export function buildPageExpression(action, payload, runtime = pageRuntime) {
  var safeAction = JSON.stringify(String(action));
  var safePayload = JSON.stringify(payload == null ? {} : payload);
  return (
    "(" +
    runtime.toString() +
    ')({ document: document, window: window, getComputedStyle: window.getComputedStyle.bind(window) }, ' +
    safeAction +
    ", " +
    safePayload +
    ")"
  );
}
