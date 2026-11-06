// Extension unit tests. No browser, no network: page DOM, chrome.* APIs,
// WebSocket and timers are replaced with small local fakes so the modules can
// be exercised with the Node built-in test runner.

import test from "node:test";
import assert from "node:assert/strict";

import {
  pageRuntime,
  buildPageExpression,
  SNAPSHOT_CANDIDATE_SELECTOR,
} from "../extension/lib/page.js";
import {
  asObject,
  requireTabId,
  normalizeHttpUrl,
  normalizeMaxChars,
  normalizeButton,
  normalizeClickCount,
  normalizeModifiers,
  normalizeKey,
  normalizeExpression,
  normalizeCdpMethod,
  normalizeCdpParams,
} from "../extension/lib/validate.js";
import { buildKeyEvents, canonicalKeyName } from "../extension/lib/keys.js";
import { createDispatcher } from "../extension/lib/dispatcher.js";
import { Connection } from "../extension/lib/connection.js";
import { DebuggerSession } from "../extension/lib/debugger.js";
import { createCommands } from "../extension/lib/commands.js";

/* -------------------------------------------------------------------------- */
/* Fake DOM                                                                   */
/* -------------------------------------------------------------------------- */

function makeElement(tag, options = {}) {
  const {
    id = "",
    attrs = {},
    children = [],
    rect = { left: 0, top: 0, width: 20, height: 10 },
    style = {},
    text = "",
    value,
    disabled = false,
    readOnly = false,
    contentEditable = false,
    labels = [],
    candidate = false,
  } = options;

  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id,
    parentElement: null,
    children: [],
    hidden: false,
    disabled,
    readOnly,
    isContentEditable: contentEditable,
    labels,
    value,
    textContent: text,
    _attrs: { ...attrs, ...(id ? { id } : {}) },
    _style: style,
    _rect: rect,
    _candidate: candidate,
    _doc: null,
    _scrolled: false,
    getAttribute(name) {
      const wanted = String(name).toLowerCase();
      for (const key of Object.keys(this._attrs)) {
        if (key.toLowerCase() === wanted) return this._attrs[key];
      }
      return null;
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
      this._doc.activeElement = this;
    },
    closest(selector) {
      if (selector !== '[aria-hidden="true"]') return null;
      let current = this;
      while (current) {
        if (current.getAttribute && current.getAttribute("aria-hidden") === "true") return current;
        current = current.parentElement;
      }
      return null;
    },
    contains() {
      return false;
    },
  };
  node.children = children;
  for (const child of children) child.parentElement = node;
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
    if (siblings.length > 1) {
      segment += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
    }
    parts.unshift(segment);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function makeDom(html, options = {}) {
  const title = options.title === undefined ? "Test page" : options.title;
  const url = options.url === undefined ? "https://example.test/page" : options.url;
  const nodes = [];
  (function walk(node) {
    nodes.push(node);
    for (const child of node.children || []) walk(child);
  })(html);

  const byId = new Map();
  for (const node of nodes) {
    const id = node.getAttribute("id");
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(node);
  }

  const body = html.children.find((child) => child.tagName === "BODY") || null;
  const doc = {
    nodeType: 9,
    title,
    URL: url,
    documentElement: html,
    body,
    activeElement: body,
    querySelectorAll(selector) {
      if (selector === SNAPSHOT_CANDIDATE_SELECTOR) {
        return nodes.filter((node) => node._candidate && node !== html && node !== body);
      }
      if (selector === "::bad") throw new SyntaxError("bad selector");
      if (selector.startsWith("#")) return byId.get(selector.slice(1)) || [];
      return nodes.filter((node) => pathOf(node) === selector);
    },
    getElementById(id) {
      const list = byId.get(id);
      return list && list.length > 0 ? list[0] : null;
    },
  };
  for (const node of nodes) node._doc = doc;
  doc.activeElement = body;
  return doc;
}

function makeWindow(doc, options = {}) {
  return {
    innerWidth: options.width === undefined ? 800 : options.width,
    innerHeight: options.height === undefined ? 600 : options.height,
    location: { href: doc.URL },
    getComputedStyle(element) {
      return {
        display: "block",
        visibility: "visible",
        opacity: "1",
        pointerEvents: "auto",
        ...element._style,
      };
    },
  };
}

function contextFor(doc) {
  const win = makeWindow(doc);
  return { document: doc, window: win, getComputedStyle: win.getComputedStyle };
}

function buildFixture() {
  const save = makeElement("button", {
    id: "save",
    text: "Сохранить",
    candidate: true,
    rect: { left: 100, top: 50, width: 40, height: 20 },
  });
  const email = makeElement("input", {
    id: "email",
    attrs: { type: "email", "aria-label": "E-mail" },
    value: "user@example.test",
    candidate: true,
  });
  const password = makeElement("input", {
    id: "pw",
    attrs: { type: "password", "aria-label": "Пароль" },
    value: "hunter2",
    candidate: true,
  });
  const hidden = makeElement("input", {
    id: "hidden",
    attrs: { type: "hidden" },
    value: "secret",
    candidate: true,
  });
  const gone = makeElement("div", {
    id: "gone",
    candidate: true,
    rect: { left: 0, top: 0, width: 0, height: 0 },
  });
  const link = makeElement("a", {
    id: "link",
    attrs: { href: "/x" },
    text: "Перейти",
    candidate: true,
  });
  const file = makeElement("input", {
    id: "file",
    attrs: { type: "file" },
    value: "C:\\secret.txt",
    candidate: true,
  });
  const plainOne = makeElement("button", { text: "Один", candidate: true });
  const plainTwo = makeElement("button", { text: "Два", candidate: true });
  const group = makeElement("div", { id: "group", children: [plainOne, plainTwo] });
  const app = makeElement("div", {
    id: "app",
    children: [save, email, password, hidden, gone, link, file, group],
  });
  const body = makeElement("body", { children: [app] });
  body.innerText = "Привет, мир!";
  const html = makeElement("html", { children: [body] });
  const doc = makeDom(html);
  doc.activeElement = body;
  return { doc, win: makeWindow(doc), save, email, password, hidden, gone, link, file, group };
}

/* -------------------------------------------------------------------------- */
/* Page runtime                                                               */
/* -------------------------------------------------------------------------- */

test("snapshot returns sanitized elements and page text", () => {
  const fixture = buildFixture();
  const ctx = contextFor(fixture.doc);
  const result = pageRuntime(ctx, "snapshot", {
    maxChars: 1000,
    candidates: SNAPSHOT_CANDIDATE_SELECTOR,
  });

  assert.equal(result.url, "https://example.test/page");
  assert.equal(result.title, "Test page");
  assert.equal(result.text, "Привет, мир!");
  assert.equal(result.truncated, false);
  assert.equal(result.elements.length, 7);

  const bySelector = new Map(result.elements.map((item) => [item.selector, item]));
  assert.ok(bySelector.has("#save"));
  assert.ok(bySelector.has("#email"));
  assert.ok(bySelector.has("#pw"));
  assert.ok(bySelector.has("#link"));
  assert.ok(bySelector.has("#file"));
  assert.equal(bySelector.get("#email").value, "user@example.test");
  assert.equal("value" in bySelector.get("#pw"), false, "password value must not be read");
  assert.equal("value" in bySelector.get("#file"), false, "file input value must not be read");
  assert.equal(bySelector.has("#hidden"), false);
  assert.equal(bySelector.has("#gone"), false);

  for (const item of result.elements) {
    const matches = fixture.doc.querySelectorAll(item.selector);
    assert.equal(matches.length, 1, "selector must resolve to exactly one element: " + item.selector);
  }
  const pathSelectors = result.elements
    .map((item) => item.selector)
    .filter((selector) => !selector.startsWith("#"));
  assert.equal(pathSelectors.length, 2);
  for (const selector of pathSelectors) {
    assert.match(selector, /:nth-of-type\(/);
  }
});

test("find matches names and roles without sending page text or field values", () => {
  const ctx = contextFor(buildFixture().doc);
  const find = (name, role) => pageRuntime(ctx, "find", { name, role, candidates: SNAPSHOT_CANDIDATE_SELECTOR });
  assert.deepEqual(find("ХРАН", "button").elements.map(el => el.selector), ["#save"]);
  assert.deepEqual(find("ХРАН", "textbox"), { elements: [], truncated: false });
  const email = find("mail").elements[0];
  assert.equal(email.selector, "#email");
  assert.equal("value" in email, false);
  assert.equal("text" in find("mail"), false);
});

test("snapshot truncates text and reports the truncation flag", () => {
  const fixture = buildFixture();
  const result = pageRuntime(contextFor(fixture.doc), "snapshot", {
    maxChars: 5,
    candidates: SNAPSHOT_CANDIDATE_SELECTOR,
  });
  assert.equal(result.text.length, 5);
  assert.equal(result.truncated, true);
});

test("snapshot caps the element list at 300 entries", () => {
  const buttons = [];
  for (let index = 0; index < 305; index += 1) {
    buttons.push(makeElement("button", { id: "b" + index, text: "Button " + index, candidate: true }));
  }
  const body = makeElement("body", { children: buttons });
  body.innerText = "";
  const html = makeElement("html", { children: [body] });
  const doc = makeDom(html);
  const result = pageRuntime(contextFor(doc), "snapshot", {
    candidates: SNAPSHOT_CANDIDATE_SELECTOR,
  });
  assert.equal(result.elements.length, 300);
  assert.equal(result.truncated, true);
  const find = (name) => pageRuntime(contextFor(doc), "find", { name, candidates: SNAPSHOT_CANDIDATE_SELECTOR });
  assert.equal(find("Button 304").elements[0].selector, "#b304");
  const broad = find("Button");
  assert.equal(broad.elements.length, 10);
  assert.equal(broad.truncated, true);
});

test("buildPageExpression is self-contained for Runtime.evaluate", () => {
  const fixture = buildFixture();
  const expression = buildPageExpression("snapshot", {
    maxChars: 1000,
    candidates: SNAPSHOT_CANDIDATE_SELECTOR,
  });
  const run = new Function("document", "window", "getComputedStyle", "return " + expression);
  const result = run(fixture.doc, fixture.win, fixture.win.getComputedStyle);
  assert.equal(result.title, "Test page");
  assert.equal(result.elements.length, 7);
});

test("locate scrolls into view and returns viewport center coordinates", () => {
  const fixture = buildFixture();
  const ctx = contextFor(fixture.doc);
  const result = pageRuntime(ctx, "locate", { selector: "#save" });
  assert.deepEqual(result, { ok: true, x: 120, y: 60 });
  assert.equal(fixture.save._scrolled, true);
});

test("locate rejects missing, ambiguous, invisible and offscreen elements", () => {
  const first = makeElement("button", { id: "dup" });
  const second = makeElement("button", { id: "dup" });
  const zero = makeElement("div", {
    id: "zero",
    rect: { left: 0, top: 0, width: 0, height: 0 },
  });
  const far = makeElement("button", {
    id: "far",
    rect: { left: 2000, top: 20, width: 10, height: 10 },
  });
  const body = makeElement("body", { children: [first, second, zero, far] });
  body.innerText = "";
  const doc = makeDom(makeElement("html", { children: [body] }));
  const ctx = contextFor(doc);

  assert.match(pageRuntime(ctx, "locate", { selector: "#missing" }).error, /No element matches/);
  assert.match(pageRuntime(ctx, "locate", { selector: "#dup" }).error, /matches 2 elements/);
  assert.match(pageRuntime(ctx, "locate", { selector: "#zero" }).error, /not visible/);
  assert.match(pageRuntime(ctx, "locate", { selector: "#far" }).error, /outside the viewport/);
  assert.match(pageRuntime(ctx, "locate", { selector: "::bad" }).error, /Invalid CSS selector/);
});

test("focus and focused report editable targets only", () => {
  const editor = makeElement("div", {
    id: "editor",
    contentEditable: true,
    text: "rich",
    candidate: true,
  });
  const save = makeElement("button", { id: "save", text: "Save", candidate: true });
  const gone = makeElement("div", {
    id: "gone",
    candidate: true,
    rect: { left: 0, top: 0, width: 0, height: 0 },
  });
  const body = makeElement("body", { children: [editor, save, gone] });
  body.innerText = "";
  const doc = makeDom(makeElement("html", { children: [body] }));
  const ctx = contextFor(doc);

  assert.deepEqual(pageRuntime(ctx, "focus", { selector: "#editor" }), {
    ok: true,
    editable: true,
  });
  assert.equal(doc.activeElement, editor);
  assert.match(pageRuntime(ctx, "focus", { selector: "#save" }).error, /not editable/);
  assert.match(pageRuntime(ctx, "focus", { selector: "#gone" }).error, /not visible/);

  assert.deepEqual(pageRuntime(ctx, "focused", {}), { ok: true, editable: true });
  doc.activeElement = doc.body;
  assert.match(pageRuntime(ctx, "focused", {}).error, /No focused element/);
});

test("viewport reports the inner size", () => {
  const fixture = buildFixture();
  assert.deepEqual(pageRuntime(contextFor(fixture.doc), "viewport", {}), {
    width: 800,
    height: 600,
  });
});

/* -------------------------------------------------------------------------- */
/* Validation and keys                                                        */
/* -------------------------------------------------------------------------- */

test("only http(s) URLs are accepted for open and navigate", () => {
  assert.equal(normalizeHttpUrl("https://example.com"), "https://example.com/");
  assert.equal(normalizeHttpUrl("http://127.0.0.1:8080/a?b=1"), "http://127.0.0.1:8080/a?b=1");
  assert.throws(() => normalizeHttpUrl("javascript:alert(1)"), /Only http/);
  assert.throws(() => normalizeHttpUrl("file:///C:/secret.txt"), /Only http/);
  assert.throws(() => normalizeHttpUrl("example.com"), /Invalid URL/);
  assert.throws(() => normalizeHttpUrl(""), /non-empty/);
});

test("tab ids, maxChars, buttons and modifiers are validated", () => {
  assert.equal(requireTabId(5), 5);
  assert.equal(requireTabId("5"), 5);
  assert.throws(() => requireTabId(0), /positive integer/);
  assert.throws(() => requireTabId(-1), /positive integer/);
  assert.throws(() => requireTabId(1.5), /positive integer/);
  assert.throws(() => requireTabId("x"), /positive integer/);

  assert.equal(normalizeMaxChars(undefined), 20000);
  assert.equal(normalizeMaxChars(0), 1);
  assert.equal(normalizeMaxChars(500000), 100000);
  assert.throws(() => normalizeMaxChars("100"), /maxChars/);

  assert.equal(normalizeButton(undefined), "left");
  assert.equal(normalizeButton(2), "right");
  assert.equal(normalizeButton("MIDDLE"), "middle");
  assert.throws(() => normalizeButton("wheel"), /button/);

  assert.equal(normalizeClickCount(undefined), 1);
  assert.equal(normalizeClickCount(2), 2);
  assert.throws(() => normalizeClickCount(4), /clickCount/);

  assert.deepEqual(normalizeModifiers(["control", "SHIFT", "Control"]), {
    mask: 10,
    names: ["Control", "Shift"],
  });
  assert.throws(() => normalizeModifiers(["Ctrl"]), /Unsupported modifier/);
  assert.throws(() => normalizeModifiers("Shift"), /array/);

  assert.equal(normalizeKey("enter"), "Enter");
  assert.equal(normalizeKey("Ж"), "Ж");
  assert.throws(() => normalizeKey("F13"), /Unsupported key/);

  assert.equal(canonicalKeyName("space"), "Space");
  assert.equal(canonicalKeyName("F13"), null);

  assert.throws(() => normalizeExpression(""), /non-empty/);
  assert.equal(normalizeExpression("1 + 1"), "1 + 1");
  assert.throws(() => normalizeCdpMethod("navigate"), /CDP method/);
  assert.equal(normalizeCdpMethod(" Page.navigate "), "Page.navigate");
  assert.deepEqual(normalizeCdpParams(undefined), {});
  assert.throws(() => normalizeCdpParams([]), /object/);
  assert.deepEqual(asObject(undefined), {});
  assert.throws(() => asObject("x"), /object/);
});

test("trusted key events map named keys and characters", () => {
  const enter = buildKeyEvents("Enter", 0);
  assert.equal(enter.length, 2);
  assert.equal(enter[0].type, "keyDown");
  assert.equal(enter[0].windowsVirtualKeyCode, 13);
  assert.equal(enter[0].text, "\r");
  assert.equal(enter[1].type, "keyUp");

  const ctrlA = buildKeyEvents("a", 2);
  assert.equal(ctrlA[0].key, "a");
  assert.equal(ctrlA[0].code, "KeyA");
  assert.equal(ctrlA[0].modifiers, 2);
  assert.equal("text" in ctrlA[0], false);

  const shiftA = buildKeyEvents("a", 8);
  assert.equal(shiftA[0].key, "A");
  assert.equal(shiftA[0].text, "A");

  const shiftOne = buildKeyEvents("1", 8);
  assert.equal(shiftOne[0].key, "!");
  assert.equal(shiftOne[0].code, "Digit1");
  assert.equal(shiftOne[0].text, "!");

  const space = buildKeyEvents("Space", 0);
  assert.equal(space[0].key, " ");
  assert.equal(space[0].text, " ");

  const cyrillic = buildKeyEvents("Ж", 0);
  assert.equal(cyrillic[0].text, "Ж");
  assert.equal("windowsVirtualKeyCode" in cyrillic[0], false);
});

/* -------------------------------------------------------------------------- */
/* Dispatcher                                                                 */
/* -------------------------------------------------------------------------- */

test("dispatcher maps results, errors and timeouts", async () => {
  const dispatch = createDispatcher({
    handlers: {
      echo: async (params) => ({ value: params.value }),
      boom: async () => {
        throw new Error("boom");
      },
      slow: () => new Promise(() => {}),
      nothing: () => undefined,
    },
    timeoutMs: 40,
  });

  assert.deepEqual(await dispatch({ id: "1", method: "echo", params: { value: 42 } }), {
    id: "1",
    result: { value: 42 },
  });
  assert.deepEqual(await dispatch({ id: "2", method: "nothing" }), { id: "2", result: null });
  assert.deepEqual(await dispatch({ id: "3", method: "boom" }), { id: "3", error: "boom" });
  const timedOut = await dispatch({ id: "4", method: "slow" });
  assert.equal(timedOut.id, "4");
  assert.match(timedOut.error, /timed out/);
  assert.deepEqual(await dispatch({ id: "5", method: "missing" }), {
    id: "5",
    error: "Unknown method: missing",
  });
  assert.deepEqual(await dispatch({ id: "6" }), {
    id: "6",
    error: "Request method must be a non-empty string",
  });
  assert.equal(await dispatch({ id: "", method: "echo" }), null);
  assert.equal(await dispatch(null), null);
  assert.equal(await dispatch("nope"), null);
});

/* -------------------------------------------------------------------------- */
/* WebSocket transport                                                        */
/* -------------------------------------------------------------------------- */

class FakeSocket {
  static instances = [];

  static reset() {
    FakeSocket.instances = [];
  }

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
  }

  send(data) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    if (typeof this.onclose === "function") this.onclose({});
  }

  open() {
    this.readyState = 1;
    if (typeof this.onopen === "function") this.onopen({});
  }

  serverClose() {
    this.readyState = 3;
    if (typeof this.onclose === "function") this.onclose({});
  }

  deliver(message) {
    if (typeof this.onmessage === "function") this.onmessage({ data: JSON.stringify(message) });
  }

  deliverRaw(text) {
    if (typeof this.onmessage === "function") this.onmessage({ data: text });
  }

  get messages() {
    return this.sent.map((entry) => JSON.parse(entry));
  }
}

function makeFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();

  function runDue() {
    let fired = true;
    while (fired) {
      fired = false;
      for (const [id, entry] of Array.from(timeouts)) {
        if (entry.at <= now) {
          timeouts.delete(id);
          fired = true;
          entry.fn();
        }
      }
      for (const [id, entry] of Array.from(intervals)) {
        if (entry.next <= now) {
          entry.next += entry.every;
          fired = true;
          entry.fn();
        }
      }
    }
  }

  return {
    get now() {
      return now;
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      timeouts.set(id, { fn, at: now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      const every = Math.max(1, Number(ms) || 1);
      intervals.set(id, { fn, every, next: now + every });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    advance(ms) {
      now += Math.max(0, Number(ms) || 0);
      runDue();
    },
    get pendingTimeouts() {
      return timeouts.size;
    },
    get pendingIntervals() {
      return intervals.size;
    },
  };
}

function makeConnection(timers, handleMessage = async () => undefined) {
  return new Connection({
    endpoint: "ws://127.0.0.1:37891/extension",
    createSocket: (url) => new FakeSocket(url),
    timers,
    handleMessage,
    pingIntervalMs: 20000,
    reconnectBaseMs: 500,
    reconnectMaxMs: 5000,
  });
}

test("connection opens, sends keepalive pings and pongs, and dispatches requests", () => {
  FakeSocket.reset();
  const timers = makeFakeTimers();
  const received = [];
  const connection = makeConnection(timers, async (message) => {
    received.push(message);
  });

  connection.start();
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(connection.getStatus().state, "connecting");

  const socket = FakeSocket.instances[0];
  socket.open();
  assert.equal(connection.getStatus().state, "connected");
  assert.equal(connection.isConnected(), true);

  assert.equal(connection.send({ hello: "world" }), true);
  assert.deepEqual(socket.messages[0], { hello: "world" });

  timers.advance(19999);
  assert.equal(socket.messages.filter((message) => message.type === "ping").length, 0);
  timers.advance(1);
  assert.equal(socket.messages.filter((message) => message.type === "ping").length, 1);

  socket.deliver({ id: "req-1", method: "tabs", params: {} });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { id: "req-1", method: "tabs", params: {} });

  socket.deliver({ type: "ping" });
  assert.deepEqual(socket.messages.at(-1), { type: "pong" });

  socket.deliver({ type: "pong" });
  socket.deliverRaw("not json");
  socket.deliver({ method: "no-id" });
  assert.equal(received.length, 1);

  connection.stop();
  assert.equal(socket.closed, true);
  assert.equal(connection.getStatus().state, "disconnected");
  assert.equal(timers.pendingIntervals, 0);
});

test("connection reconnects with backoff and replaces old sockets", () => {
  FakeSocket.reset();
  const timers = makeFakeTimers();
  const connection = makeConnection(timers);

  connection.start();
  const first = FakeSocket.instances[0];
  first.open();
  first.serverClose();
  assert.equal(connection.getStatus().state, "disconnected");
  assert.equal(FakeSocket.instances.length, 1);

  timers.advance(499);
  assert.equal(FakeSocket.instances.length, 1);
  timers.advance(1);
  assert.equal(FakeSocket.instances.length, 2);

  const second = FakeSocket.instances[1];
  second.open();
  assert.equal(connection.getStatus().state, "connected");
  const epochBefore = connection.epoch;

  const status = connection.reconnect();
  assert.equal(second.closed, true);
  assert.equal(FakeSocket.instances.length, 3);
  assert.equal(status.state, "connecting");
  assert.ok(connection.epoch > epochBefore);
  assert.equal(timers.pendingIntervals, 0);

  connection.stop();
});

/* -------------------------------------------------------------------------- */
/* Debugger session                                                           */
/* -------------------------------------------------------------------------- */

function makeDebuggerChrome() {
  const attachCalls = [];
  const detachCalls = [];
  const sendCalls = [];
  let detachListener = null;
  const chromeApi = {
    debugger: {
      attach: async (target, version) => {
        attachCalls.push({ target, version });
      },
      detach: async (target) => {
        detachCalls.push(target);
      },
      sendCommand: async (target, method, params) => {
        sendCalls.push({ target, method, params });
        return { method };
      },
      onDetach: {
        addListener(fn) {
          detachListener = fn;
        },
      },
    },
    tabs: {
      onRemoved: { addListener() {} },
      onReplaced: { addListener() {} },
    },
  };
  return {
    chromeApi,
    attachCalls,
    detachCalls,
    sendCalls,
    emitDetach(source, reason) {
      if (detachListener) detachListener(source, reason);
    },
  };
}

test("debugger session attaches lazily and serializes commands per tab", async () => {
  const harness = makeDebuggerChrome();
  let running = 0;
  let maxRunning = 0;
  harness.chromeApi.debugger.sendCommand = async (target, method) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return { method };
  };

  const session = new DebuggerSession({ chromeApi: harness.chromeApi });
  const results = await Promise.all([
    session.exclusive(7, () => session.send(7, "A", {})),
    session.exclusive(7, () => session.send(7, "B", {})),
    session.exclusive(7, () => session.send(7, "C", {})),
  ]);

  assert.deepEqual(results, [{ method: "A" }, { method: "B" }, { method: "C" }]);
  assert.equal(maxRunning, 1, "commands for one tab must not overlap");
  assert.equal(harness.attachCalls.length, 1, "debugger must attach only once");
  assert.deepEqual(harness.attachCalls[0].target, { tabId: 7 });
  assert.equal(harness.attachCalls[0].version, "1.3");
});

test("debugger session re-attaches after detach and does not retry failures", async () => {
  const harness = makeDebuggerChrome();
  let failing = true;
  let attempts = 0;
  harness.chromeApi.debugger.sendCommand = async () => {
    attempts += 1;
    if (failing) throw new Error("Debugger is not attached to the tab with id: 9");
    return { ok: true };
  };

  const session = new DebuggerSession({ chromeApi: harness.chromeApi });
  await assert.rejects(session.send(9, "Page.navigate", {}), /Tab 9/);
  assert.equal(attempts, 1, "mutations must not be retried");

  failing = false;
  await session.send(9, "Page.enable", {});
  assert.equal(harness.attachCalls.length, 2, "next command re-attaches after failure");

  harness.emitDetach({ tabId: 9 }, "canceled_by_user");
  await session.send(9, "Page.enable", {});
  assert.equal(harness.attachCalls.length, 3, "detach event is recovered on the next command");
});

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

function makeFakeChrome() {
  return {
    tabs: {
      get: async (tabId) => ({
        id: tabId,
        windowId: 1,
        title: "Tab",
        url: "https://example.test/",
        active: true,
        status: "complete",
        extra: "dropped",
      }),
      query: async () => [
        {
          id: 1,
          windowId: 1,
          title: "Tab",
          url: "https://example.test/",
          active: true,
          status: "complete",
          extra: "dropped",
        },
      ],
      create: async ({ url }) => ({
        id: 2,
        windowId: 1,
        title: "",
        url,
        active: true,
        status: "loading",
      }),
      update: async (tabId, changes) => ({
        id: tabId,
        windowId: 1,
        title: "Tab",
        url: changes && changes.url ? changes.url : "https://example.test/",
        active: true,
        status: "complete",
      }),
      remove: async () => undefined,
    },
    windows: {
      update: async () => ({}),
    },
  };
}

function makeStubSession(overrides = {}) {
  return {
    detach: async () => undefined,
    exclusive: async (tabId, task) => task(),
    send: async () => ({}),
    ...overrides,
  };
}

test("commands validate unsafe or incomplete parameters", async () => {
  const commands = createCommands({ chromeApi: makeFakeChrome(), session: makeStubSession() });

  await assert.rejects(commands.open({ url: "javascript:alert(1)" }), /Only http/);
  await assert.rejects(commands.navigate({ tabId: 1, url: "file:///C:/x" }), /Only http/);
  await assert.rejects(commands.snapshot({}), /tabId/);
  await assert.rejects(commands.snapshot({ tabId: 1, maxChars: "500" }), /maxChars/);
  await assert.rejects(commands.find({ tabId: 1, name: "   " }), /name/);
  await assert.rejects(commands.find({ tabId: 1, name: "Save", role: [] }), /role/);
  await assert.rejects(commands.click({ tabId: 1 }), /selector|viewport/);
  await assert.rejects(commands.click({ tabId: 1, x: 10 }), /both "x" and "y"/);
  await assert.rejects(commands.click({ tabId: 1, selector: "#a", button: "wheel" }), /button/);
  await assert.rejects(commands.click({ tabId: 1, selector: "#a", clickCount: 5 }), /clickCount/);
  await assert.rejects(commands.type({ tabId: 1, text: 5 }), /text/);
  await assert.rejects(commands.press({ tabId: 1, key: "F13" }), /Unsupported key/);
  await assert.rejects(commands.press({ tabId: 1, key: "Enter", modifiers: "Control" }), /array/);
  await assert.rejects(commands.scroll({ tabId: 1 }), /deltaY/);
  await assert.rejects(commands.scroll({ tabId: 1, deltaY: 10, x: 5 }), /both "x" and "y"/);
  await assert.rejects(commands.evaluate({ tabId: 1, expression: "" }), /non-empty/);
  await assert.rejects(commands.cdp({ tabId: 1, method: "navigate" }), /CDP method/);
  await assert.rejects(commands.cdp({ tabId: 1, method: "Page.navigate", params: [] }), /object/);
});

test("tabs and open return protocol tab summaries", async () => {
  const commands = createCommands({ chromeApi: makeFakeChrome(), session: makeStubSession() });

  assert.deepEqual(await commands.tabs({}), [
    {
      id: 1,
      windowId: 1,
      title: "Tab",
      url: "https://example.test/",
      active: true,
      status: "complete",
    },
  ]);
  const opened = await commands.open({ url: "https://example.com/" });
  assert.equal(opened.id, 2);
  assert.equal(opened.url, "https://example.test/");
  assert.equal(opened.status, "complete");
  assert.equal("extra" in opened, false);
});

test("snapshot normalizes elements and never forwards password values", async () => {
  const session = makeStubSession({
    send: async () => ({
      result: {
        value: {
          url: "https://example.test/",
          title: "Tab",
          text: "Hello",
          truncated: false,
          elements: [
            { selector: "#a", tag: "button", role: "button", name: "A", type: "", value: "v" },
            { selector: "", tag: "broken" },
            { selector: "#pw", tag: "input", role: "textbox", name: "P", type: "password", value: "secret" },
          ],
        },
      },
    }),
  });
  const commands = createCommands({ chromeApi: makeFakeChrome(), session });
  const result = await commands.snapshot({ tabId: 1, maxChars: 10 });

  assert.equal(result.text, "Hello");
  assert.equal(result.elements.length, 2);
  assert.deepEqual(result.elements[0], {
    selector: "#a",
    tag: "button",
    role: "button",
    name: "A",
    type: "",
    value: "v",
  });
  assert.equal(result.elements[1].selector, "#pw");
  assert.equal("value" in result.elements[1], false);
  const found = await commands.find({ tabId: 1, name: "A" });
  assert.deepEqual(found.elements.map(el => el.selector), ["#a", "#pw"]);
  assert.ok(found.elements.every(el => !("value" in el)));
});

test("click and type use trusted CDP input without echoing values", async () => {
  const calls = [];
  const session = makeStubSession({
    send: async (tabId, method, params) => {
      calls.push({ tabId, method, params });
      if (method === "Runtime.evaluate") {
        return { result: { value: { ok: true, x: 10, y: 20, editable: true } } };
      }
      return {};
    },
  });
  const commands = createCommands({ chromeApi: makeFakeChrome(), session });

  assert.deepEqual(await commands.click({ tabId: 1, selector: "#save", clickCount: 2 }), {
    clicked: true,
  });
  const mouse = calls
    .filter((call) => call.method === "Input.dispatchMouseEvent")
    .map((call) => call.params);
  assert.equal(mouse[0].type, "mouseMoved");
  assert.deepEqual(
    mouse.filter((event) => event.type === "mousePressed").map((event) => event.clickCount),
    [1, 2],
  );
  assert.equal(mouse[1].x, 10);
  assert.equal(mouse[1].y, 20);

  calls.length = 0;
  const typed = await commands.type({ tabId: 1, selector: "#email", text: "привет", clear: true });
  assert.deepEqual(typed, { typed: true });
  assert.equal(JSON.stringify(typed).includes("привет"), false, "entered text must not be echoed");
  assert.ok(calls.some((call) => call.method === "Input.insertText" && call.params.text === "привет"));
  assert.ok(
    calls.some(
      (call) =>
        call.method === "Input.dispatchKeyEvent" &&
        call.params.type === "keyDown" &&
        call.params.key === "a" &&
        call.params.modifiers === 2,
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === "Input.dispatchKeyEvent" &&
        call.params.type === "keyDown" &&
        call.params.key === "Backspace",
    ),
  );
});

test("evaluate awaits results, forwards a timeout and surfaces page exceptions", async () => {
  const calls = [];
  let mode = "ok";
  const session = makeStubSession({
    send: async (tabId, method, params) => {
      calls.push({ tabId, method, params });
      if (mode === "throw") {
        return {
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "Error: boom" },
          },
        };
      }
      return { result: { type: "number", value: 42 } };
    },
  });
  const commands = createCommands({ chromeApi: makeFakeChrome(), session });

  assert.equal(await commands.evaluate({ tabId: 1, expression: "6*7" }), 42);
  assert.equal(calls[0].method, "Runtime.evaluate");
  assert.equal(calls[0].params.expression, "6*7");
  assert.equal(calls[0].params.awaitPromise, true);
  assert.equal(calls[0].params.returnByValue, true);
  assert.equal(calls[0].params.timeout, 20000);

  mode = "throw";
  await assert.rejects(
    commands.evaluate({ tabId: 1, expression: "throw new Error('boom')" }),
    /boom/,
  );
});

test("cdp returns the raw CDP response", async () => {
  const calls = [];
  const session = makeStubSession({
    send: async (tabId, method, params) => {
      calls.push({ tabId, method, params });
      return { result: { value: 7 } };
    },
  });
  const commands = createCommands({ chromeApi: makeFakeChrome(), session });
  const raw = await commands.cdp({
    tabId: 1,
    method: "Runtime.evaluate",
    params: { expression: "7", returnByValue: true },
  });
  assert.deepEqual(raw, { result: { value: 7 } });
  assert.equal(calls[0].method, "Runtime.evaluate");
  assert.deepEqual(calls[0].params, { expression: "7", returnByValue: true });
});

test("screenshot returns PNG base64 and rejects an empty capture", async () => {
  let data = "iVBORw0KGgo=";
  const session = makeStubSession({
    send: async () => ({ data }),
  });
  const commands = createCommands({ chromeApi: makeFakeChrome(), session });

  assert.deepEqual(await commands.screenshot({ tabId: 1 }), {
    data: "iVBORw0KGgo=",
    mimeType: "image/png",
  });
  data = "";
  await assert.rejects(commands.screenshot({ tabId: 1 }), /no data/);
});

test("close is idempotent when the tab is already gone", async () => {
  const chromeApi = makeFakeChrome();
  chromeApi.tabs.remove = async () => {
    throw new Error("No tab with id: 5");
  };
  const commands = createCommands({ chromeApi, session: makeStubSession() });
  assert.deepEqual(await commands.close({ tabId: 5 }), { closed: true });
});
