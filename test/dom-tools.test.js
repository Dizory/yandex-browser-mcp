// Tests for the higher-level DOM tools. No browser and no network are
// required: a small fake DOM exercises the serialized page runtime, and a
// guarded "real DOM" test runs only when a DOM implementation is already
// available (a browser context or an installed jsdom/happy-dom/linkedom).
//
// No new dependencies are introduced by this file.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  DOM_TOOL_ACTIONS,
  buildDomExpression,
  createDomTools,
  domRuntime,
} from "../extension/lib/dom-tools.js";
import { domDefinitions } from "../server/dom-tools.js";

/* -------------------------------------------------------------------------- */
/* Minimal fake DOM                                                           */
/* -------------------------------------------------------------------------- */

class FakeEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = init.bubbles !== false;
    this.cancelable = init.cancelable === true;
    this.composed = init.composed === true;
    this.inputType = init.inputType;
    this.data = init.data;
    this.defaultPrevented = false;
    this.target = null;
    this._stopped = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this._stopped = true;
  }
}

class FakeInputEvent extends FakeEvent {}

function makeElement(tag, options = {}) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    parentElement: null,
    children: [],
    hidden: false,
    disabled: options.disabled === true,
    readOnly: options.readOnly === true,
    required: options.required === true,
    multiple: options.multiple === true,
    checked: options.checked === true,
    selected: options.selected === true,
    value: options.value === undefined ? "" : options.value,
    textContent: options.text === undefined ? "" : options.text,
    innerText: options.innerText === undefined ? options.text || "" : options.innerText,
    isContentEditable: options.contentEditable === true,
    labels: options.labels || [],
    _attrs: {},
    _style: Object.assign(
      { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" },
      options.style || {},
    ),
    _rect: Object.assign({ left: 0, top: 0, width: 20, height: 10 }, options.rect || {}),
    _candidate: options.candidate === true,
    _events: [],
    _listeners: new Map(),
    _doc: null,
    _scrolled: false,
    _nativeSets: 0,
    _directSets: 0,
    _onclick: null,

    getAttribute(name) {
      const wanted = String(name).toLowerCase();
      for (const key of Object.keys(this._attrs)) {
        if (key.toLowerCase() === wanted) return this._attrs[key];
      }
      return null;
    },
    setAttribute(name, value) {
      this._attrs[String(name)] = String(value);
    },
    hasAttribute(name) {
      return this.getAttribute(name) !== null;
    },
    removeAttribute(name) {
      delete this._attrs[String(name)];
    },
    get attributes() {
      const list = Object.keys(this._attrs).map((name) => ({ name, value: this._attrs[name] }));
      list.item = (index) => list[index] || null;
      return list;
    },
    getBoundingClientRect() {
      return { ...this._rect };
    },
    getRootNode() {
      return this._doc;
    },
    scrollIntoView() {
      this._scrolled = true;
    },
    focus() {
      if (this._doc) this._doc.activeElement = this;
    },
    contains(other) {
      if (!other) return false;
      if (other === this) return true;
      for (const child of this.children) {
        if (child === other || (child.contains && child.contains(other))) return true;
      }
      return false;
    },
    closest(selector) {
      let current = this;
      while (current && current.nodeType === 1) {
        if (matchesSelector(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    matches(selector) {
      return matchesSelector(this, selector);
    },
    addEventListener(type, listener) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      this._events.push(event.type);
      event.target = this;
      const listeners = this._listeners.get(event.type);
      if (listeners) for (const listener of listeners) listener.call(this, event);
      if (event.bubbles && this.parentElement && typeof this.parentElement.dispatchEvent === "function") {
        this.parentElement.dispatchEvent(event);
      }
      return event.defaultPrevented !== true;
    },
    click() {
      this.dispatchEvent(new FakeEvent("click", { bubbles: true }));
      const type = String(this.getAttribute("type") || "").toLowerCase();
      if (this.tagName === "INPUT" && (type === "checkbox" || type === "radio")) {
        if (type === "radio") {
          if (this._doc) {
            for (const other of this._doc.querySelectorAll('input[type="radio"]')) {
              if (other !== this && other.getAttribute("name") === this.getAttribute("name")) other.checked = false;
            }
          }
          this.checked = true;
        } else {
          this.checked = !this.checked;
        }
        this.dispatchEvent(new FakeEvent("input", { bubbles: true }));
        this.dispatchEvent(new FakeEvent("change", { bubbles: true }));
      }
      if (typeof this._onclick === "function") this._onclick(this);
    },
  };

  if (options.id) node._attrs.id = options.id;
  if (options.attrs) {
    for (const key of Object.keys(options.attrs)) node._attrs[key] = options.attrs[key];
  }
  if (options.children) {
    for (const child of options.children) {
      child.parentElement = node;
      node.children.push(child);
    }
  }
  return node;
}

function pathOf(node) {
  const documentElement = node._doc ? node._doc.documentElement : null;
  const parts = [];
  let current = node;
  while (current && current.nodeType === 1) {
    let segment = current.tagName.toLowerCase();
    if (current === documentElement || !current.parentElement) {
      parts.unshift(segment);
      break;
    }
    const siblings = current.parentElement.children.filter((child) => child.tagName === current.tagName);
    if (siblings.length > 1) segment += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
    parts.unshift(segment);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function matchesPart(node, part) {
  if (!part) return false;
  const negated = [];
  let value = part.replace(/:not\(([^)]*)\)/g, (match, inner) => {
    negated.push(inner);
    return "";
  });
  if (!value) return false;
  const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(value);
  if (tagMatch) {
    if (node.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    value = value.slice(tagMatch[0].length);
  }
  if (value.startsWith("#")) {
    if (node.getAttribute("id") !== value.slice(1)) return false;
    value = "";
  }
  if (value.startsWith(".")) {
    const classNames = String(node.getAttribute("class") || "").split(/\s+/);
    if (!classNames.includes(value.slice(1))) return false;
    value = "";
  }
  const attributePattern = /\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let match;
  while ((match = attributePattern.exec(value)) !== null) {
    const name = match[1];
    const wanted = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4];
    const actual = node.getAttribute(name);
    if (actual === null) return false;
    if (wanted !== undefined && String(actual) !== String(wanted)) return false;
  }
  for (const inner of negated) {
    if (matchesPart(node, inner)) return false;
  }
  return true;
}

function matchesSelector(node, selector) {
  if (selector.includes(" > ")) return pathOf(node) === selector;
  return String(selector)
    .split(",")
    .some((part) => matchesPart(node, part.trim()));
}

function isDescendant(root, node) {
  let current = node.parentElement;
  while (current) {
    if (current === root) return true;
    current = current.parentElement;
  }
  return false;
}

function makeDom(root, options = {}) {
  const nodes = [];
  (function walk(node) {
    nodes.push(node);
    for (const child of node.children || []) walk(child);
  })(root);

  const byId = new Map();
  for (const node of nodes) {
    const id = node.getAttribute("id");
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(node);
  }

  const body = root.children.find((child) => child.tagName === "BODY") || null;
  const doc = {
    nodeType: 9,
    title: options.title === undefined ? "Test page" : options.title,
    URL: options.url === undefined ? "https://example.test/page" : options.url,
    readyState: "complete",
    documentElement: root,
    body,
    activeElement: body,
    querySelectorAll(selector) {
      if (selector === "::bad") throw new SyntaxError("bad selector");
      return nodes.filter((node) => node !== root && matchesSelector(node, selector));
    },
    getElementById(id) {
      const list = byId.get(id);
      return list && list.length > 0 ? list[0] : null;
    },
    elementFromPoint(x, y) {
      if (typeof options.elementFromPoint === "function") return options.elementFromPoint(x, y);
      let hit = null;
      for (const node of nodes) {
        if (node === root) continue;
        const rect = node._rect;
        if (!(rect.width > 0) || !(rect.height > 0)) continue;
        if (x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height) {
          hit = node;
        }
      }
      return hit || body;
    },
  };
  for (const node of nodes) {
    node._doc = doc;
    node.ownerDocument = doc;
    node.querySelectorAll = function querySelectorAll(selector) {
      if (selector === "::bad") throw new SyntaxError("bad selector");
      return nodes.filter(
        (candidate) => candidate !== this && isDescendant(this, candidate) && matchesSelector(candidate, selector),
      );
    };
    node.querySelector = function query(selector) {
      return this.querySelectorAll(selector)[0] || null;
    };
  }
  doc.activeElement = body;
  return doc;
}

function makeWindow(doc, options = {}) {
  return {
    innerWidth: options.width === undefined ? 800 : options.width,
    innerHeight: options.height === undefined ? 600 : options.height,
    location: { href: doc.URL },
    Event: FakeEvent,
    InputEvent: FakeInputEvent,
    getComputedStyle(element) {
      return Object.assign(
        { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" },
        element && element._style ? element._style : {},
      );
    },
    getComputedStyleBound() {
      return this.getComputedStyle;
    },
    ...options.window,
  };
}

function contextFor(doc, options = {}) {
  const win = makeWindow(doc, options);
  return { document: doc, window: win, getComputedStyle: win.getComputedStyle };
}

function attach(parent, children) {
  for (const child of children) {
    child.parentElement = parent;
    parent.children.push(child);
  }
  return parent;
}

function tree(rootTag, build) {
  const root = makeElement(rootTag, { rect: { left: 0, top: 0, width: 800, height: 600 } });
  const body = makeElement("body", { rect: { left: 0, top: 0, width: 800, height: 600 } });
  attach(root, [body]);
  build(body);
  return makeDom(root);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function buildFormFixture(options = {}) {
  const form = makeElement("form", {
    id: "profile",
    attrs: { name: "profileForm", action: "/save", method: "post" },
  });
  const name = makeElement("input", {
    id: "name",
    candidate: true,
    value: "Alice",
    attrs: { type: "text", name: "full_name", "aria-label": "Full name" },
  });
  const password = makeElement("input", {
    id: "pw",
    candidate: true,
    value: "hunter2",
    attrs: { type: "password", name: "password", "aria-label": "Password" },
  });
  const file = makeElement("input", {
    id: "file",
    candidate: true,
    value: "C:\\secret.txt",
    attrs: { type: "file", name: "upload", "aria-label": "Upload" },
  });
  const hidden = makeElement("input", {
    id: "hidden",
    candidate: true,
    value: "csrf-token",
    attrs: { type: "hidden", name: "csrf" },
  });
  const bio = makeElement("textarea", {
    id: "bio",
    candidate: true,
    value: "old bio",
    attrs: { name: "bio", "aria-label": "Biography" },
  });
  const note = makeElement("div", {
    id: "note",
    candidate: true,
    contentEditable: true,
    text: "old note",
    attrs: { contenteditable: "", role: "textbox", "aria-label": "Note" },
  });
  const agree = makeElement("input", {
    id: "agree",
    candidate: true,
    checked: false,
    attrs: { type: "checkbox", name: "agree", "aria-label": "Agree" },
  });
  const radio = makeElement("input", {
    id: "radio",
    candidate: true,
    checked: true,
    attrs: { type: "radio", name: "choice", "aria-label": "Choice" },
  });
  const red = makeElement("option", { text: "Red", selected: true, attrs: { value: "r" } });
  const blue = makeElement("option", { text: "Blue", selected: false, attrs: { value: "b" } });
  red.value = "r";
  blue.value = "b";
  const color = makeElement("select", {
    id: "color",
    candidate: true,
    attrs: { name: "color", "aria-label": "Color" },
  });
  color.options = [red, blue];
  attach(color, [red, blue]);
  const save = makeElement("button", { id: "save", text: "Save", candidate: true });
  const disabled = makeElement("input", {
    id: "disabled",
    candidate: true,
    disabled: true,
    value: "",
    attrs: { type: "text", "aria-label": "Disabled" },
  });
  attach(form, [name, password, file, hidden, bio, note, agree, radio, color, save, disabled]);
  const doc = tree("html", (body) => {
    body.innerText = "Form region";
    attach(body, [form]);
  });
  if (options.url) doc.URL = options.url;
  return { doc, form, name, password, file, hidden, bio, note, agree, radio, color, red, blue, save, disabled };
}

function buildTableFixture(options = {}) {
  const table = makeElement("table", { id: "prices", candidate: false });
  const caption = makeElement("caption", { text: "Prices" });
  const headerRow = makeElement("tr");
  const th1 = makeElement("th", { text: "Name" });
  const th2 = makeElement("th", { text: "Value" });
  th1.cellIndex = 0;
  th2.cellIndex = 1;
  headerRow.cells = [th1, th2];
  attach(headerRow, [th1, th2]);

  const dataRows = [];
  for (const [name, value] of [["Alpha", "1"], ["Beta", "2"], ["Gamma", "3"]]) {
    const row = makeElement("tr");
    const td1 = makeElement("td", { text: name });
    const td2 = makeElement("td", { text: value });
    td1.cellIndex = 0;
    td2.cellIndex = 1;
    row.cells = [td1, td2];
    attach(row, [td1, td2]);
    dataRows.push(row);
  }
  table.rows = [headerRow, ...dataRows];
  table.caption = caption;
  attach(table, [caption, headerRow, ...dataRows]);
  const doc = tree("html", (body) => {
    body.innerText = "Table region";
    attach(body, [table]);
  });
  return { doc, table, headerRow, dataRows, caption };
}

function buildRegionFixture() {
  const panel = makeElement("div", {
    id: "panel",
    candidate: false,
    rect: { left: 0, top: 0, width: 400, height: 300 },
  });
  panel.innerText = "Hello region text";
  const link = makeElement("a", { id: "link", candidate: true, text: "Open", attrs: { href: "/open" } });
  const password = makeElement("input", {
    id: "pw",
    candidate: true,
    value: "hunter2",
    attrs: { type: "password", "aria-label": "Secret" },
  });
  const file = makeElement("input", {
    id: "file",
    candidate: true,
    value: "C:\\secret.txt",
    attrs: { type: "file", "aria-label": "File" },
  });
  const hidden = makeElement("input", {
    id: "hidden",
    candidate: true,
    value: "csrf-token",
    attrs: { type: "hidden" },
  });
  attach(panel, [link, password, file, hidden]);
  const doc = tree("html", (body) => {
    body.innerText = "Body text";
    attach(body, [panel]);
  });
  return { doc, panel, link, password, file, hidden };
}

/* -------------------------------------------------------------------------- */
/* Command helpers                                                            */
/* -------------------------------------------------------------------------- */

function makeSession() {
  const calls = [];
  const session = {
    exclusive(tabId, task) {
      calls.push(tabId);
      return Promise.resolve().then(task);
    },
  };
  return { session, calls };
}

function makePageEval(ctx, calls = []) {
  return async (tabId, action, payload, frameId) => {
    calls.push({ tabId, action, payload, frameId });
    return domRuntime(ctx, action, payload);
  };
}

/* -------------------------------------------------------------------------- */
/* Contract surface                                                           */
/* -------------------------------------------------------------------------- */

test("exports the eight DOM actions and a self-contained page expression", () => {
  assert.deepEqual(DOM_TOOL_ACTIONS, [
    "wait",
    "read_region",
    "read_table",
    "read_form",
    "fill_form",
    "select",
    "set_checked",
    "inspect",
  ]);

  const fixture = buildFormFixture();
  const expression = buildDomExpression("wait", { selector: "#name" });
  const run = new Function("document", "window", "getComputedStyle", "return " + expression);
  const result = run(fixture.doc, makeWindow(fixture.doc), makeWindow(fixture.doc).getComputedStyle);
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.count, 1);
});

test("serialized domRuntime covers reads and mutations through new Function", () => {
  const formFixture = buildFormFixture();
  const formWindow = makeWindow(formFixture.doc);
  const runForm = (action, payload) =>
    new Function("document", "window", "getComputedStyle", "return " + buildDomExpression(action, payload))(
      formFixture.doc,
      formWindow,
      formWindow.getComputedStyle,
    );
  const filled = runForm("fill_form", { fields: [{ selector: "#name", value: "Zed" }] });
  assert.equal(filled.ok, true);
  assert.equal(formFixture.name.value, "Zed");

  const tableFixture = buildTableFixture();
  const tableWindow = makeWindow(tableFixture.doc);
  const runTable = new Function(
    "document",
    "window",
    "getComputedStyle",
    "return " + buildDomExpression("read_table", { selector: "#prices" }),
  );
  const table = runTable(tableFixture.doc, tableWindow, tableWindow.getComputedStyle);
  assert.deepEqual(table.headers, ["Name", "Value"]);
  assert.equal(table.rows.length, 3);
});

test("unknown actions and missing selectors fail with readable errors", () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);
  assert.match(domRuntime(ctx, "nope", {}).error, /Unknown DOM action/);
  assert.match(domRuntime(ctx, "read_region", { selector: "#missing" }).error, /No element matches/);
  assert.match(domRuntime(ctx, "read_table", { selector: "#name" }).error, /not a table/);
  assert.match(domRuntime(ctx, "inspect", { selector: "::bad" }).error, /Invalid CSS selector/);
  assert.match(domRuntime(ctx, "select", { selector: "#nope", values: ["x"] }).error, /No element matches/);
  assert.match(domRuntime(ctx, "set_checked", { selector: "#nope", checked: true }).error, /No element matches/);
});

/* -------------------------------------------------------------------------- */
/* wait                                                                       */
/* -------------------------------------------------------------------------- */

test("wait probes selector states, text and URL without returning page text", () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);

  assert.equal(domRuntime(ctx, "wait", { selector: "#name" }).matched, true);
  assert.equal(domRuntime(ctx, "wait", { selector: "#missing", state: "attached" }).matched, false);
  assert.equal(domRuntime(ctx, "wait", { selector: "#missing", state: "detached" }).matched, true);
  assert.equal(domRuntime(ctx, "wait", { selector: "#missing", state: "hidden" }).matched, true);

  const text = domRuntime(ctx, "wait", { text: "form REGION" });
  assert.equal(text.matched, true);
  assert.equal(text.hasText, true);
  assert.equal("text" in text, false, "wait must not echo page text");

  assert.equal(domRuntime(ctx, "wait", { text: "form region", caseSensitive: true }).matched, false);
  assert.equal(domRuntime(ctx, "wait", { urlContains: "example.test" }).matched, true);
  assert.equal(domRuntime(ctx, "wait", { urlContains: "EXAMPLE.test", caseSensitive: true }).matched, false);

  const fatal = domRuntime(ctx, "wait", {});
  assert.equal(fatal.ok, false);
  assert.equal(fatal.fatal, true);
  assert.match(fatal.error, /requires/);
  assert.equal(domRuntime(ctx, "wait", { selector: "::bad" }).fatal, true);
});

test("wait polls without holding the per-tab queue during sleeps and passes frameId", async () => {
  const calls = [];
  const { session } = makeSession();
  let active = 0;
  let maxActive = 0;
  const tracked = {
    exclusive(tabId, task) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push({ tabId });
      return Promise.resolve()
        .then(task)
        .finally(() => {
          active -= 1;
        });
    },
  };
  let probes = 0;
  const pageEval = async (tabId, action, payload, frameId) => {
    probes += 1;
    assert.equal(action, "wait");
    assert.equal(frameId, "FRAME_1");
    assert.equal(payload.selector, "#ready");
    if (probes < 3) return { ok: true, matched: false, url: "https://example.test/", title: "T" };
    return {
      ok: true,
      matched: true,
      url: "https://example.test/",
      title: "T",
      count: 1,
      visibleCount: 1,
      matchedSelector: true,
    };
  };
  const tools = createDomTools({ pageEval, session: tracked });
  const result = await tools.wait({
    tabId: 7,
    frameId: "FRAME_1",
    selector: "#ready",
    timeoutMs: 500,
    intervalMs: 25,
  });
  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.equal(probes, 3);
  assert.equal(maxActive, 1, "probes must not overlap");
  assert.ok(calls.every((call) => call.tabId === 7));

  // A mutation queued while wait sleeps must run before wait reports a timeout.
  let mutationRan = false;
  let infiniteProbes = 0;
  const tools2 = createDomTools({
    session: tracked,
    async pageEval() {
      infiniteProbes += 1;
      return { ok: true, matched: false, url: "", title: "" };
    },
  });
  const waiting = tools2.wait({ tabId: 8, selector: "#never", timeoutMs: 160, intervalMs: 25 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const mutation = tracked.exclusive(8, async () => {
    mutationRan = true;
  });
  const timedOut = await waiting;
  await mutation;
  assert.equal(mutationRan, true);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.timedOut, true);
  assert.ok(infiniteProbes >= 2);
});

test("wait reports detachment and validates conditions", async () => {
  const { session } = makeSession();
  const tools = createDomTools({
    session,
    async pageEval() {
      throw new Error("Not attached to tab");
    },
  });
  const result = await tools.wait({ tabId: 1, selector: "#x", timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.match(result.error, /attached/i);

  await assert.rejects(tools.wait({ tabId: 1 }), /requires/);
  await assert.rejects(tools.wait({ tabId: 1, state: "visible" }), /requires a "selector"/);
  await assert.rejects(tools.wait({ tabId: 1, selector: "#x", timeoutMs: 10 }), /timeoutMs/);
  await assert.rejects(tools.wait({ tabId: 1, selector: "#x", intervalMs: 5000 }), /intervalMs/);
  await assert.rejects(tools.wait({ tabId: 1, frameId: "" }), /frameId/);
});

/* -------------------------------------------------------------------------- */
/* read_region                                                                */
/* -------------------------------------------------------------------------- */

test("read_region returns bounded text and actionable elements without secret values", () => {
  const fixture = buildRegionFixture();
  const ctx = contextFor(fixture.doc);
  const result = domRuntime(ctx, "read_region", {
    selector: "#panel",
    maxChars: 5,
    maxElements: 10,
  });
  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, "selector");
  assert.equal(result.text, "Hello");
  assert.equal(result.truncated, true);
  assert.ok(result.elements.some((el) => el.selector === "#link"));
  assert.ok(result.elements.some((el) => el.selector === "#pw"));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("hunter2"), false, "password value leaked");
  assert.equal(serialized.includes("C:\\\\secret.txt"), false, "file value leaked");
  assert.equal(serialized.includes("csrf-token"), false, "hidden value leaked");
  assert.equal(result.elements.some((el) => el.selector === "#hidden"), false);
  assert.equal(
    result.elements.some((el) => el.selector === "#pw" && "value" in el),
    false,
  );
});

test("read_region can resolve a viewport point and rejects bad regions", () => {
  const fixture = buildRegionFixture();
  const ctx = contextFor(fixture.doc);
  const result = domRuntime(ctx, "read_region", {
    x: 10,
    y: 10,
    width: 50,
    height: 30,
    maxChars: 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, "point");
  assert.ok(result.root.selector === "#panel" || result.root.tag === "div");

  assert.match(domRuntime(ctx, "read_region", { x: 10 }).error, /together/);
  assert.match(
    domRuntime(ctx, "read_region", { x: 5000, y: 5000, width: 10, height: 10 }).error,
    /outside the viewport/,
  );
  assert.match(domRuntime(ctx, "read_region", { selector: "::bad" }).error, /Invalid CSS selector/);
});

test("read_region command validates coordinates and passes frameId", async () => {
  const fixture = buildRegionFixture();
  const ctx = contextFor(fixture.doc);
  const calls = [];
  const { session } = makeSession();
  const tools = createDomTools({ pageEval: makePageEval(ctx, calls), session });
  const result = await tools.read_region({ tabId: 3, frameId: "FRAME", selector: "#panel", maxChars: 10 });
  assert.equal(result.resolvedBy, "selector");
  assert.equal(calls[0].action, "read_region");
  assert.equal(calls[0].frameId, "FRAME");
  assert.equal(calls[0].tabId, 3);

  await assert.rejects(tools.read_region({ tabId: 1, x: 1 }), /together/);
  await assert.rejects(tools.read_region({ tabId: 1, selector: "#panel", x: 1, y: 1, width: 1, height: 1 }), /not both/);
  await assert.rejects(tools.read_region({ tabId: 1, x: 1, y: 1, width: 0, height: 1 }), /positive/);
});

/* -------------------------------------------------------------------------- */
/* read_table                                                                 */
/* -------------------------------------------------------------------------- */

test("read_table returns headers, rows and truncation bounds", () => {
  const fixture = buildTableFixture();
  const ctx = contextFor(fixture.doc);
  const result = domRuntime(ctx, "read_table", { selector: "#prices" });
  assert.equal(result.ok, true);
  assert.equal(result.caption, "Prices");
  assert.deepEqual(result.headers, ["Name", "Value"]);
  assert.deepEqual(result.rows, [
    ["Alpha", "1"],
    ["Beta", "2"],
    ["Gamma", "3"],
  ]);
  assert.equal(result.rowCount, 3);
  assert.equal(result.rowsReturned, 3);
  assert.equal(result.columnCount, 2);
  assert.equal(result.hasHeader, true);
  assert.equal(result.truncated, false);

  const capped = domRuntime(ctx, "read_table", { selector: "#prices", maxRows: 1, maxCellChars: 2 });
  assert.equal(capped.rows.length, 1);
  assert.deepEqual(capped.rows[0], ["Al", "1"]);
  assert.equal(capped.rowCount, 3);
  assert.equal(capped.truncated, true);

  const empty = tree("html", (body) => {
    body.innerText = "No tables here";
  });
  assert.match(domRuntime(contextFor(empty), "read_table", {}).error, /No table/);
  assert.match(domRuntime(ctx, "read_table", { selector: "#table-missing" }).error, /No element matches/);
});

test("read_table reads ARIA grids and keeps colspan gaps", () => {
  const headerRow = makeElement("div", { attrs: { role: "row" } });
  const key = makeElement("div", { attrs: { role: "columnheader" }, text: "Key" });
  const value = makeElement("div", { attrs: { role: "columnheader" }, text: "Value" });
  attach(headerRow, [key, value]);
  const dataRow = makeElement("div", { attrs: { role: "row" } });
  const wide = makeElement("div", { attrs: { role: "gridcell" }, text: "wide" });
  const tail = makeElement("div", { attrs: { role: "gridcell" }, text: "tail" });
  attach(dataRow, [wide, tail]);
  const grid = makeElement("div", {
    id: "grid",
    candidate: false,
    attrs: { role: "grid", "aria-label": "Grid" },
  });
  attach(grid, [headerRow, dataRow]);

  const wideCell = makeElement("td", { text: "wide" });
  wideCell.cellIndex = 0;
  wideCell.colSpan = 2;
  const tailCell = makeElement("td", { text: "tail" });
  tailCell.cellIndex = 2;
  const spanRow = makeElement("tr");
  spanRow.cells = [wideCell, tailCell];
  attach(spanRow, [wideCell, tailCell]);
  const spanTable = makeElement("table", { id: "span-table" });
  spanTable.rows = [spanRow];
  attach(spanTable, [spanRow]);

  const doc = tree("html", (body) => {
    body.innerText = "";
    attach(body, [grid, spanTable]);
  });
  const ctx = contextFor(doc);

  const aria = domRuntime(ctx, "read_table", { selector: "#grid" });
  assert.equal(aria.ok, true);
  assert.deepEqual(aria.headers, ["Key", "Value"]);
  assert.deepEqual(aria.rows, [["wide", "tail"]]);
  assert.equal(aria.hasHeader, true);

  const span = domRuntime(ctx, "read_table", { selector: "#span-table" });
  assert.equal(span.ok, true);
  assert.equal(span.hasHeader, false);
  assert.deepEqual(span.rows, [["wide", "", "tail"]]);
  assert.equal(span.columnCount, 3);

  const capped = domRuntime(ctx, "read_table", { selector: "#span-table", maxCols: 1 });
  assert.equal(capped.rows[0].length, 1);
  assert.equal(capped.truncated, true);
});

test("read_region default mode reads the document body", () => {
  const fixture = buildRegionFixture();
  const result = domRuntime(contextFor(fixture.doc), "read_region", { maxChars: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, "document");
  assert.equal(result.text, "Body text");
});

test("read_table command bounds rows/cells and passes frameId", async () => {
  const fixture = buildTableFixture();
  const ctx = contextFor(fixture.doc);
  const calls = [];
  const { session } = makeSession();
  const tools = createDomTools({ pageEval: makePageEval(ctx, calls), session });
  const result = await tools.read_table({ tabId: 2, frameId: "F", selector: "#prices", maxRows: 2 });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rowCount, 3);
  assert.equal(calls[0].frameId, "F");
  await assert.rejects(tools.read_table({ tabId: 1, maxRows: 500 }), /maxRows/);
  await assert.rejects(tools.read_table({ tabId: 1, maxCellChars: 5000 }), /maxCellChars/);
});

/* -------------------------------------------------------------------------- */
/* read_form                                                                  */
/* -------------------------------------------------------------------------- */

test("read_form exposes structure but never password, file or hidden values", () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);
  const result = domRuntime(ctx, "read_form", { selector: "#profile", maxFields: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.forms.length, 1);
  const form = result.forms[0];
  assert.equal(form.selector, "#profile");
  assert.equal(form.method, "post");
  const byId = new Map(form.fields.map((field) => [field.id, field]));
  assert.equal(byId.get("name").value, "Alice");
  assert.equal(byId.get("name").label, "Full name");
  assert.equal(byId.get("pw").sensitive, true);
  assert.equal("value" in byId.get("pw"), false);
  assert.equal(byId.get("file").sensitive, true);
  assert.equal(byId.get("file").file, true);
  assert.equal("value" in byId.get("file"), false);
  assert.equal(byId.has("hidden"), false);
  assert.equal(byId.get("agree").checked, false);
  assert.equal(byId.get("radio").checked, true);
  assert.deepEqual(byId.get("color").selectedValues, ["r"]);
  assert.ok(byId.get("color").options.some((option) => option.label === "Blue"));
  assert.equal(byId.get("note").readOnly, false);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes("C:\\\\secret.txt"), false);
  assert.equal(serialized.includes("csrf-token"), false);

  const capped = domRuntime(ctx, "read_form", { selector: "#profile", maxFields: 2 });
  assert.equal(capped.forms[0].fields.length, 2);
  assert.equal(capped.truncated, true);
});

test("read_form falls back to a synthetic container when no form exists", () => {
  const input = makeElement("input", {
    id: "loose",
    candidate: true,
    value: "x",
    attrs: { type: "text", "aria-label": "Loose" },
  });
  const doc = tree("html", (body) => {
    body.innerText = "";
    attach(body, [input]);
  });
  const result = domRuntime(contextFor(doc), "read_form", {});
  assert.equal(result.ok, true);
  assert.equal(result.forms.length, 1);
  assert.equal(result.forms[0].synthetic, true);
  assert.equal(result.forms[0].fields[0].selector, "#loose");
});

test("read_form command passes frameId and bounds fields", async () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);
  const calls = [];
  const { session } = makeSession();
  const tools = createDomTools({ pageEval: makePageEval(ctx, calls), session });
  const result = await tools.read_form({ tabId: 4, frameId: "F", selector: "#profile", maxFields: 3 });
  assert.equal(result.forms[0].fields.length, 3);
  assert.equal(calls[0].frameId, "F");
  await assert.rejects(tools.read_form({ tabId: 1, maxFields: 0 }), /maxFields/);
  await assert.rejects(tools.read_form({ tabId: 1, formIndex: -1 }), /formIndex/);
});

/* -------------------------------------------------------------------------- */
/* fill_form                                                                  */
/* -------------------------------------------------------------------------- */

function makeReactInput(options) {
  const prototype = {};
  Object.defineProperty(prototype, "value", {
    configurable: true,
    get() {
      return this._nativeValue;
    },
    set(value) {
      this._nativeValue = String(value);
      this._nativeSets = (this._nativeSets || 0) + 1;
    },
  });
  const element = makeElement("input", {
    id: options.id,
    candidate: true,
    value: "",
    attrs: { type: "text", "aria-label": options.label || "Field" },
  });
  element._nativeValue = "";
  Object.defineProperty(element, "value", {
    configurable: true,
    enumerable: true,
    get() {
      return this._nativeValue;
    },
    set(value) {
      this._directSets = (this._directSets || 0) + 1;
      this._trackerValue = String(value);
    },
  });
  const body = makeElement("body", { rect: { left: 0, top: 0, width: 800, height: 600 } });
  attach(body, [element]);
  const html = makeElement("html", { rect: { left: 0, top: 0, width: 800, height: 600 } });
  attach(html, [body]);
  const doc = makeDom(html);
  const ctx = contextFor(doc, { window: { HTMLInputElement: { prototype } } });
  return { doc, ctx, element };
}

test("fill_form updates native controls and is React compatible", () => {
  const react = makeReactInput({ id: "reactive", label: "Reactive" });
  const result = domRuntime(react.ctx, "fill_form", {
    fields: [{ selector: "#reactive", value: "tracked" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].status, "filled");
  assert.equal(react.element.value, "tracked");
  assert.equal(react.element._nativeSets, 1, "must use the native prototype setter");
  assert.equal(react.element._directSets, 0, "must not assign through the React tracker");
  assert.ok(react.element._events.includes("input"));
  assert.ok(react.element._events.includes("change"));
  assert.equal(JSON.stringify(result).includes("tracked"), false, "value must not be echoed");
  assert.equal(result.results[0].valueLength, 7);
});

test("fill_form handles textarea, contenteditable, select and checkbox controls", () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);
  const result = domRuntime(ctx, "fill_form", {
    fields: [
      { selector: "#bio", value: "new bio" },
      { selector: "#note", value: "new note" },
      { selector: "#agree", checked: true },
      { selector: "#color", value: "b" },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((item) => item.status), ["filled", "filled", "filled", "filled"]);
  assert.equal(fixture.bio.value, "new bio");
  assert.equal(fixture.note.textContent, "new note");
  assert.equal(fixture.agree.checked, true);
  assert.equal(fixture.red.selected, false);
  assert.equal(fixture.blue.selected, true);
  for (const element of [fixture.bio, fixture.note, fixture.agree, fixture.color]) {
    assert.ok(element._events.includes("input"), "missing input event");
    assert.ok(element._events.includes("change"), "missing change event");
  }
  assert.equal(JSON.stringify(result).includes("new bio"), false);
});

test("fill_form reports partial per-field outcomes and keeps going", () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);
  const result = domRuntime(ctx, "fill_form", {
    fields: [
      { selector: "#name", value: "first" },
      { selector: "#missing", value: "second" },
      { selector: "#disabled", value: "third" },
      { selector: "#pw", value: "fourth" },
      { selector: "#file", value: "fifth" },
      { selector: "#hidden", value: "sixth" },
      { selector: "#save", value: "seventh" },
      { selector: "#bio", value: "eighth" },
    ],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.map((item) => item.status), [
    "filled",
    "not_found",
    "disabled",
    "filled",
    "sensitive",
    "sensitive",
    "unsupported",
    "filled",
  ]);
  assert.equal(fixture.name.value, "first");
  assert.equal(fixture.bio.value, "eighth");
  assert.equal(fixture.password.value, "fourth");
  // No command result may echo entered values.
  const serialized = JSON.stringify(result);
  for (const secret of ["first", "fourth", "seventh", "eighth"]) {
    assert.equal(serialized.includes(secret), false, "leaked " + secret);
  }
});

test("fill_form resolves fields by accessible name and honours read-only controls", () => {
  const fixture = buildFormFixture();
  fixture.bio.readOnly = true;
  const ctx = contextFor(fixture.doc);
  const result = domRuntime(ctx, "fill_form", {
    fields: [
      { name: "Full name", value: "Named" },
      { selector: "#bio", value: "blocked" },
    ],
  });
  assert.equal(result.results[0].status, "filled");
  assert.equal(fixture.name.value, "Named");
  assert.equal(result.results[1].status, "read_only");
  assert.equal(fixture.bio.value, "old bio");
});

test("fill_form reports ambiguous field names", () => {
  const doc = tree("html", (body) => {
    body.innerText = "";
    attach(body, [
      makeElement("input", {
        id: "one",
        candidate: true,
        attrs: { type: "text", name: "same", "aria-label": "Same" },
      }),
      makeElement("input", {
        id: "two",
        candidate: true,
        attrs: { type: "text", name: "same", "aria-label": "Same" },
      }),
    ]);
  });
  const result = domRuntime(contextFor(doc), "fill_form", {
    fields: [{ name: "Same", value: "x" }],
  });
  assert.equal(result.results[0].status, "ambiguous");
  assert.ok(result.results[0].matches.length >= 2);
});

test("fill_form command stops on navigation, detachment and bad input", async () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);
  const { session } = makeSession();
  const calls = [];
  let urlIndex = 0;
  const urls = ["https://example.test/start", "https://example.test/next"];
  const tools = createDomTools({
    session,
    async pageEval(tabId, action, payload, frameId) {
      calls.push({ tabId, action, payload, frameId });
      const url = urls[Math.min(urlIndex, urls.length - 1)];
      urlIndex += 1;
      ctx.window.location.href = url;
      return domRuntime(ctx, action, payload);
    },
  });
  const navigated = await tools.fill_form({
    tabId: 9,
    frameId: "FRAME",
    fields: [
      { selector: "#name", value: "a" },
      { selector: "#bio", value: "b" },
      { selector: "#note", value: "c" },
    ],
  });
  assert.equal(navigated.ok, false);
  assert.equal(navigated.stopped, "navigation");
  assert.equal(navigated.results[0].status, "filled");
  assert.equal(navigated.results[1].status, "skipped");
  assert.notEqual(fixture.doc.querySelectorAll("#bio")[0].value, "b");
  assert.equal(navigated.results[2].status, "skipped");
  assert.equal(navigated.results[2].reason, "navigation");
  assert.equal(calls[0].frameId, "FRAME");

  let detachCalls = 0;
  const detachedTools = createDomTools({
    session,
    async pageEval() {
      detachCalls += 1;
      if (detachCalls === 1) return domRuntime(ctx, "fill_form", { fields: [{ selector: "#name", value: "x" }] });
      throw new Error("Inspected target navigated or closed");
    },
  });
  const detached = await detachedTools.fill_form({
    tabId: 9,
    fields: [
      { selector: "#name", value: "x" },
      { selector: "#bio", value: "y" },
    ],
  });
  assert.equal(detached.stopped, "navigation");
  assert.equal(detached.results[1].status, "unknown");
  assert.equal(detached.results.length, 2);

  await assert.rejects(tools.fill_form({ tabId: 1, fields: [] }), /at least one/);
  await assert.rejects(
    tools.fill_form({ tabId: 1, fields: [{ selector: "#name" }] }),
    /requires "value" or "checked"/,
  );
  await assert.rejects(
    tools.fill_form({ tabId: 1, fields: [{ selector: "#name", name: "n", value: "x" }] }),
    /either/,
  );
  await assert.rejects(
    tools.fill_form({ tabId: 1, fields: Array.from({ length: 51 }, (_, index) => ({ selector: "#f" + index, value: "x" })) }),
    /at most/,
  );
  await assert.rejects(tools.fill_form({ tabId: 1, fields: [{ selector: "#name", value: 5 }] }), /non-string/);
});

/* -------------------------------------------------------------------------- */
/* select                                                                     */
/* -------------------------------------------------------------------------- */

test("select matches by value, label and index and emits events", () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);
  const byValue = domRuntime(ctx, "select", { selector: "#color", values: ["b"] });
  assert.equal(byValue.ok, true);
  assert.equal(byValue.selected.length, 1);
  assert.equal(byValue.selected[0].value, "b");
  assert.equal(byValue.selected[0].index, 1);
  assert.equal(fixture.blue.selected, true);
  assert.equal(fixture.red.selected, false);
  assert.ok(fixture.color._events.includes("input"));
  assert.ok(fixture.color._events.includes("change"));

  const byLabel = domRuntime(ctx, "select", { selector: "#color", labels: ["Red"] });
  assert.equal(byLabel.ok, true);
  assert.equal(byLabel.selected[0].value, "r");

  const byIndex = domRuntime(ctx, "select", { selector: "#color", indexes: [1] });
  assert.equal(byIndex.ok, true);
  assert.equal(byIndex.selected[0].value, "b");

  const missing = domRuntime(ctx, "select", { selector: "#color", values: ["zzz"] });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, "not_found");
  assert.ok(missing.options.length >= 2);
  assert.match(domRuntime(ctx, "select", { selector: "#name", values: ["x"] }).error, /native select/);
});

test("select supports multiple selects and reject multiple matches on single select", () => {
  const one = makeElement("option", { text: "One", selected: true, attrs: { value: "1" } });
  const two = makeElement("option", { text: "Two", selected: false, attrs: { value: "2" } });
  const three = makeElement("option", { text: "Three", selected: false, attrs: { value: "3" } });
  one.value = "1";
  two.value = "2";
  three.value = "3";
  const multi = makeElement("select", { id: "multi", candidate: true, multiple: true });
  multi.options = [one, two, three];
  attach(multi, [one, two, three]);
  const single = makeElement("select", { id: "single", candidate: true });
  const s1 = makeElement("option", { text: "Same", attrs: { value: "a" } });
  const s2 = makeElement("option", { text: "Same", attrs: { value: "b" } });
  s1.value = "a";
  s2.value = "b";
  single.options = [s1, s2];
  attach(single, [s1, s2]);
  const doc = tree("html", (body) => {
    body.innerText = "";
    attach(body, [multi, single]);
  });
  const ctx = contextFor(doc);

  const appended = domRuntime(ctx, "select", {
    selector: "#multi",
    values: ["2"],
    append: true,
  });
  assert.equal(appended.ok, true);
  assert.deepEqual(appended.selected.map((option) => option.value).sort(), ["1", "2"]);

  const ambiguous = domRuntime(ctx, "select", { selector: "#single", labels: ["Same"] });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.status, "ambiguous");
});

test("select refuses a disabled matching option", () => {
  const fixture = buildFormFixture();
  fixture.blue.disabled = true;
  const result = domRuntime(contextFor(fixture.doc), "select", {
    selector: "#color",
    values: ["b"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "disabled");
  assert.match(result.error, /disabled/);
});

test("select command validates its argument groups and passes frameId", async () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);
  const calls = [];
  const { session } = makeSession();
  const tools = createDomTools({ pageEval: makePageEval(ctx, calls), session });
  const result = await tools.select({ tabId: 5, frameId: "FRAME", selector: "#color", values: ["b"] });
  assert.equal(result.selected[0].value, "b");
  assert.equal(result.selected[0].index, 1);
  assert.equal(calls[0].frameId, "FRAME");

  await assert.rejects(tools.select({ tabId: 1, selector: "#color" }), /requires/);
  await assert.rejects(
    tools.select({ tabId: 1, selector: "#color", values: ["r"], labels: ["Red"] }),
    /only one/,
  );
  await assert.rejects(tools.select({ tabId: 1, selector: "#color", values: [5] }), /strings/);
  await assert.rejects(tools.select({ tabId: 1, selector: "#color", indexes: [-1] }), /non-negative/);
});

/* -------------------------------------------------------------------------- */
/* set_checked                                                                */
/* -------------------------------------------------------------------------- */

test("set_checked updates native checkbox and radio controls", () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);
  const checked = domRuntime(ctx, "set_checked", { selector: "#agree", checked: true });
  assert.equal(checked.ok, true);
  assert.equal(checked.mode, "native");
  assert.equal(checked.checked, true);
  assert.equal(checked.changed, true);
  assert.equal(checked.verified, true);
  assert.equal(fixture.agree.checked, true);
  assert.ok(fixture.agree._events.includes("input"));
  assert.ok(fixture.agree._events.includes("change"));

  const unchecked = domRuntime(ctx, "set_checked", { selector: "#agree", checked: false });
  assert.equal(unchecked.checked, false);
  assert.equal(fixture.agree.checked, false);

  const radio = domRuntime(ctx, "set_checked", { selector: "#radio", checked: false });
  assert.equal(radio.ok, true);
  assert.equal(fixture.radio.checked, false);
});

test("set_checked supports ARIA switches and rejects other elements", () => {
  const toggle = makeElement("div", {
    id: "switch",
    candidate: true,
    attrs: { role: "switch", "aria-checked": "false", "aria-label": "Toggle" },
  });
  toggle._onclick = (element) => {
    element.setAttribute("aria-checked", element.getAttribute("aria-checked") === "true" ? "false" : "true");
  };
  const plain = makeElement("div", { id: "plain", candidate: true, attrs: { role: "button" } });
  const doc = tree("html", (body) => {
    body.innerText = "";
    attach(body, [toggle, plain]);
  });
  const ctx = contextFor(doc);
  const result = domRuntime(ctx, "set_checked", { selector: "#switch", checked: true });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "aria");
  assert.equal(result.checked, true);
  assert.equal(result.verified, true);

  const fallback = domRuntime(ctx, "set_checked", { selector: "#switch", checked: false });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.checked, false);

  const rejected = domRuntime(ctx, "set_checked", { selector: "#plain", checked: true });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /not a native/);
});

test("set_checked command requires a boolean and passes frameId", async () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);
  const calls = [];
  const { session } = makeSession();
  const tools = createDomTools({ pageEval: makePageEval(ctx, calls), session });
  const result = await tools.set_checked({
    tabId: 6,
    frameId: "FRAME",
    selector: "#agree",
    checked: true,
  });
  assert.equal(result.verified, true);
  assert.equal(calls[0].frameId, "FRAME");
  await assert.rejects(tools.set_checked({ tabId: 1, selector: "#agree" }), /checked/);
  await assert.rejects(tools.set_checked({ tabId: 1, selector: "#agree", checked: "yes" }), /boolean/);
});

/* -------------------------------------------------------------------------- */
/* inspect                                                                    */
/* -------------------------------------------------------------------------- */

test("inspect returns actionable details and never reads password values", () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);
  const password = domRuntime(ctx, "inspect", { selector: "#pw" });
  assert.equal(password.mode, "element");
  assert.equal(password.element.sensitive, true);
  assert.equal("value" in password.element, false);
  assert.equal(password.element.attributes.value, undefined);
  assert.equal(password.actionability.visible, true);
  assert.equal(password.actionability.enabled, true);
  assert.equal(password.capabilities.type, true);
  assert.equal(password.capabilities.fill, true);
  assert.equal(password.capabilities.set_checked, false);
  assert.equal(password.associations.formSelector, "#profile");
  assert.equal(password.coverage.passwordValues, "Password values are never read.");

  const name = domRuntime(ctx, "inspect", { selector: "#name" });
  assert.equal(name.element.value, "Alice");
  assert.equal(name.capabilities.fill, true);
  assert.equal(name.capabilities.read_form, true);

  const cell = makeElement("div", {
    id: "cell",
    candidate: true,
    contentEditable: true,
    attrs: { role: "textbox", contenteditable: "" },
  });
  const row = makeElement("tr");
  const td = makeElement("td");
  attach(td, [cell]);
  row.cells = [td];
  attach(row, [td]);
  const table = makeElement("table", { id: "t" });
  table.rows = [row];
  attach(table, [row]);
  const doc = tree("html", (body) => {
    body.innerText = "";
    attach(body, [table]);
  });
  const inspected = domRuntime(contextFor(doc), "inspect", { selector: "#cell" });
  assert.equal(inspected.associations.tableSelector, "#t");
  assert.equal(inspected.capabilities.read_table, true);

  const missing = domRuntime(ctx, "inspect", { selector: "#missing" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No element matches/);
});

test("inspect page mode reports coverage and a bounded element sample", () => {
  const fixture = buildFormFixture();
  const ctx = contextFor(fixture.doc);
  const result = domRuntime(ctx, "inspect", { maxElements: 5 });
  assert.equal(result.mode, "page");
  assert.equal(result.page.counts.forms, 1);
  assert.equal(result.page.counts.iframes, 0);
  assert.equal(result.elements.length, 5);
  assert.equal(result.truncated, true);
  assert.ok(result.hints.length > 0);
  assert.equal(result.coverage.mainDocument, true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes("C:\\\\secret.txt"), false);
});

test("inspect command sanitizes attributes and passes frameId", async () => {
  const fixture = buildFormFixture();
  fixture.name._attrs.onclick = "alert(1)";
  fixture.name._attrs.title = "T";
  const ctx = contextFor(fixture.doc);
  const calls = [];
  const { session } = makeSession();
  const tools = createDomTools({ pageEval: makePageEval(ctx, calls), session });
  const result = await tools.inspect({ tabId: 2, frameId: "FRAME", selector: "#name" });
  assert.equal(result.mode, "element");
  assert.equal(result.element.attributes.onclick, undefined);
  assert.equal(result.element.attributes.title, "T");
  assert.equal(calls[0].frameId, "FRAME");
  await assert.rejects(tools.inspect({ tabId: 1, maxElements: 500 }), /maxElements/);
});

/* -------------------------------------------------------------------------- */
/* Server definitions                                                         */
/* -------------------------------------------------------------------------- */

test("domDefinitions exposes eight zod-backed method tuples", () => {
  assert.equal(domDefinitions.length, 8);
  assert.deepEqual(
    domDefinitions.map((definition) => definition[0]),
    DOM_TOOL_ACTIONS,
  );
  for (const definition of domDefinitions) {
    assert.equal(definition.length, 3);
    const [method, description, shape] = definition;
    assert.equal(typeof method, "string");
    assert.equal(typeof description, "string");
    assert.ok(description.length > 20);
    assert.equal(typeof shape, "object");
    assert.doesNotThrow(() => z.strictObject(shape));
  }
});

test("domDefinitions schemas enforce positive tab ids, frame ids and bounded waits", () => {
  const shapes = new Map(domDefinitions.map(([method, , shape]) => [method, z.strictObject(shape)]));
  const wait = shapes.get("wait");
  assert.doesNotThrow(() => wait.parse({ tabId: 1, selector: "#a", timeoutMs: 1000, intervalMs: 50 }));
  assert.doesNotThrow(() => wait.parse({ tabId: 1, frameId: "FRAME_ID", text: "hello" }));
  assert.throws(() => wait.parse({ tabId: 0, selector: "#a" }), /Too small|too_small/);
  assert.throws(() => wait.parse({ tabId: -1, selector: "#a" }));
  assert.throws(() => wait.parse({ tabId: 1.5, selector: "#a" }));
  assert.throws(() => wait.parse({ tabId: "1", selector: "#a" }));
  assert.throws(() => wait.parse({ tabId: 1, selector: "#a", frameId: "" }));
  assert.throws(() => wait.parse({ tabId: 1, selector: "#a", timeoutMs: 30000 }));
  assert.throws(() => wait.parse({ tabId: 1, selector: "#a", intervalMs: 5000 }));
  assert.throws(() => wait.parse({ tabId: 1, selector: "#a", extra: true }));

  const region = shapes.get("read_region");
  assert.doesNotThrow(() => region.parse({ tabId: 1, x: 0, y: 0, width: 10, height: 10 }));
  assert.doesNotThrow(() => region.parse({ tabId: 1, selector: "#a", maxChars: 100 }));
  assert.throws(() => region.parse({ tabId: 1, width: -1 }));
  assert.throws(() => region.parse({ tabId: 1, maxChars: 50000 }));

  const table = shapes.get("read_table");
  assert.doesNotThrow(() => table.parse({ tabId: 1, maxRows: 10, maxCellChars: 10 }));
  assert.throws(() => table.parse({ tabId: 1, maxRows: 500 }));

  const form = shapes.get("read_form");
  assert.doesNotThrow(() => form.parse({ tabId: 1, formIndex: 0, maxFields: 10 }));
  assert.throws(() => form.parse({ tabId: 1, maxFields: 500 }));

  const fill = shapes.get("fill_form");
  assert.doesNotThrow(() =>
    fill.parse({ tabId: 1, fields: [{ selector: "#a", value: "x" }, { name: "Email", checked: true }] }),
  );
  assert.throws(() => fill.parse({ tabId: 1, fields: [] }));
  assert.throws(() => fill.parse({ tabId: 1, fields: [{ selector: "#a", value: "x", extra: 1 }] }));
  assert.throws(() =>
    fill.parse({
      tabId: 1,
      fields: Array.from({ length: 51 }, (_, index) => ({ selector: "#f" + index, value: "x" })),
    }),
  );
  assert.throws(() => fill.parse({ tabId: 1, fields: [{ selector: "#a", value: 5 }] }));

  const choose = shapes.get("select");
  assert.doesNotThrow(() => choose.parse({ tabId: 1, selector: "#s", values: ["a"] }));
  assert.doesNotThrow(() => choose.parse({ tabId: 1, selector: "#s", indexes: [0], by: "index" }));
  assert.throws(() => choose.parse({ tabId: 1, selector: "#s", values: [] }));
  assert.throws(() => choose.parse({ tabId: 1, selector: "#s", values: ["a"], by: "bogus" }));

  const check = shapes.get("set_checked");
  assert.doesNotThrow(() => check.parse({ tabId: 1, selector: "#c", checked: false }));
  assert.throws(() => check.parse({ tabId: 1, selector: "#c" }));

  const page = shapes.get("inspect");
  assert.doesNotThrow(() => page.parse({ tabId: 1 }));
  assert.doesNotThrow(() => page.parse({ tabId: 1, selector: "#a", maxElements: 10 }));
  assert.throws(() => page.parse({ tabId: 1, maxElements: 500 }));

  for (const shape of shapes.values()) {
    assert.throws(() => shape.parse({ tabId: 0 }));
  }
});

/* -------------------------------------------------------------------------- */
/* Optional real DOM                                                          */
/* -------------------------------------------------------------------------- */

async function loadRealDom() {
  if (globalThis.document && globalThis.window) {
    return { document: globalThis.document, window: globalThis.window };
  }
  for (const name of ["jsdom", "happy-dom", "linkedom"]) {
    try {
      if (name === "jsdom") {
        const module = await import("jsdom");
        const dom = new module.JSDOM("<!doctype html><html><body></body></html>");
        return { document: dom.window.document, window: dom.window };
      }
      if (name === "happy-dom") {
        const module = await import("happy-dom");
        const window = new module.Window();
        return { document: window.document, window };
      }
      if (name === "linkedom") {
        const module = await import("linkedom");
        const parsed = module.parseHTML("<!doctype html><html><body></body></html>");
        return { document: parsed.document, window: parsed.window };
      }
    } catch (error) {
      /* not installed: try the next locally available DOM */
    }
  }
  return null;
}

test("real DOM (optional): native controls update through fill/select/set_checked", async (t) => {
  const real = await loadRealDom();
  if (!real) {
    t.skip("No local DOM implementation (global document or jsdom/happy-dom/linkedom) is available");
    return;
  }
  const { document, window } = real;
  document.body.innerHTML = [
    '<form id="f">',
    '<input id="n" type="text" aria-label="Name">',
    '<textarea id="t" aria-label="Bio"></textarea>',
    '<select id="s" aria-label="Color"><option value="a">A</option><option value="b">B</option></select>',
    '<input id="c" type="checkbox" aria-label="Check">',
    "</form>",
  ].join("");
  let events = 0;
  document.querySelector("#n").addEventListener("input", () => {
    events += 1;
  });
  const ctx = {
    document,
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
  };

  const filled = domRuntime(ctx, "fill_form", {
    fields: [
      { selector: "#n", value: "hello" },
      { selector: "#t", value: "text" },
      { selector: "#c", checked: true },
      { selector: "#s", value: "b" },
    ],
  });
  assert.equal(filled.ok, true);
  assert.equal(document.querySelector("#n").value, "hello");
  assert.equal(document.querySelector("#t").value, "text");
  assert.equal(document.querySelector("#c").checked, true);
  assert.equal(document.querySelector("#s").value, "b");
  assert.ok(events >= 1, "native input event was not observed");

  const selected = domRuntime(ctx, "select", { selector: "#s", values: ["a"] });
  assert.equal(selected.ok, true);
  assert.equal(document.querySelector("#s").value, "a");

  const unchecked = domRuntime(ctx, "set_checked", { selector: "#c", checked: false });
  assert.equal(unchecked.ok, true);
  assert.equal(document.querySelector("#c").checked, false);
});
