// Interaction tool tests. No browser, no network and no real chrome.* APIs:
// fake tabs, downloads and a fake CDP session drive every handler.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { createInteractionTools } from "../extension/lib/interaction-tools.js";
import { interactionDefinitions } from "../server/interaction-tools.js";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

function makeSession(handler = async () => ({})) {
  const calls = [];
  const session = {
    calls,
    exclusive: async (tabId, task) => task(),
    send: async (tabId, method, params = {}) => {
      calls.push({ tabId, method, params });
      return handler(tabId, method, params, calls);
    },
  };
  return session;
}

function makeTabs(overrides = {}) {
  return {
    get: async (tabId) => ({
      id: tabId,
      windowId: 1,
      title: "Tab",
      url: "https://example.test/",
      active: true,
      status: "complete",
    }),
    goBack: async () => undefined,
    goForward: async () => undefined,
    reload: async () => undefined,
    ...overrides,
  };
}

function makeChrome({ tabs = {}, downloads } = {}) {
  const api = { tabs: makeTabs(tabs) };
  if (downloads !== undefined) api.downloads = downloads;
  return api;
}

function makeTools({ chrome, session, pageEval } = {}) {
  return createInteractionTools({
    chromeApi: chrome || makeChrome(),
    session: session || makeSession(),
    pageEval: pageEval || (async () => ({})),
  });
}

function makeDownloads(responder) {
  const searchCalls = [];
  const downloadCalls = [];
  let calls = 0;
  const api = {
    search: async (query) => {
      searchCalls.push(query);
      calls += 1;
      return responder(query, calls);
    },
    download: async () => {
      downloadCalls.push(true);
      return 1;
    },
  };
  return { api, searchCalls, downloadCalls };
}

function makeUploadSession(options = {}) {
  const node =
    options.node === undefined
      ? { nodeName: "INPUT", backendNodeId: 5, attributes: ["type", "file", "multiple", ""] }
      : options.node;
  return makeSession(async (tabId, method) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") {
      return { nodeIds: options.nodeIds === undefined ? [10] : options.nodeIds };
    }
    if (method === "DOM.describeNode") return { node };
    if (method === "DOM.getAttributes") {
      return { attributes: options.attributes === undefined ? ["type", "file"] : options.attributes };
    }
    if (method === "DOM.setFileInputFiles") return {};
    throw new Error("Unexpected CDP command: " + method);
  });
}

/* -------------------------------------------------------------------------- */
/* Server definitions                                                         */
/* -------------------------------------------------------------------------- */

const definitionMethods = interactionDefinitions.map(([method]) => method);
const shapes = new Map(
  interactionDefinitions.map(([method, description, shape]) => [method, shape]),
);

function parseDefinition(method, value) {
  return z.strictObject(shapes.get(method)).parse(value);
}

test("interactionDefinitions export six tool tuples in a mergeable format", () => {
  assert.deepEqual(definitionMethods, [
    "hover",
    "drag",
    "frames",
    "wait_download",
    "upload_file",
    "history",
  ]);
  for (const [method, description, shape] of interactionDefinitions) {
    assert.equal(typeof description, "string", method);
    assert.ok(description.length > 20, method + " needs a useful description");
    assert.equal(typeof shape, "object", method);
    assert.doesNotThrow(() => z.toJSONSchema(z.strictObject(shape)), method);
  }
});

test("server schemas accept valid interaction parameters", () => {
  assert.equal(parseDefinition("hover", { tabId: 1, selector: "#menu" }).selector, "#menu");
  assert.equal(parseDefinition("hover", { tabId: 1, x: 4, y: 5 }).x, 4);

  const drag = parseDefinition("drag", {
    tabId: 1,
    from: { selector: "#from" },
    to: { x: 100, y: 200 },
    steps: 10,
  });
  assert.equal(drag.steps, 10);

  assert.equal(parseDefinition("frames", { tabId: 2 }).tabId, 2);

  const download = parseDefinition("wait_download", {
    downloadId: 7,
    timeoutMs: 1000,
    lookbackMs: 0,
  });
  assert.equal(download.downloadId, 7);

  assert.equal(
    parseDefinition("upload_file", {
      tabId: 1,
      selector: "#file",
      paths: ["C:\\tmp\\a.txt"],
    }).paths.length,
    1,
  );

  assert.equal(parseDefinition("history", { tabId: 1, action: "reload", bypassCache: true }).action, "reload");
});

test("server schemas reject malformed interaction parameters", () => {
  const base = {
    hover: [{ tabId: 1, x: -1 }],
    drag: [
      { tabId: 1, from: { selector: "#a" } },
      { tabId: 1, from: { selector: "#a", x: 1, y: 2 }, to: { x: 1, y: 2 } },
      { tabId: 1, from: { x: 1, y: 2 }, to: { x: 1, y: 2 }, steps: 0 },
    ],
    frames: [{ tabId: 0 }],
    wait_download: [
      { downloadId: 0 },
      { timeoutMs: 30000 },
      { lookbackMs: 600001 },
      { filenameContains: "" },
    ],
    upload_file: [{ tabId: 1, paths: [] }, { tabId: 1, paths: [""] }],
    history: [{ tabId: 1, action: "refresh" }, { tabId: 1 }],
  };
  for (const method of definitionMethods) {
    for (const value of base[method]) {
      assert.throws(
        () => parseDefinition(method, value),
        undefined,
        method + " accepted " + JSON.stringify(value),
      );
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Hover                                                                      */
/* -------------------------------------------------------------------------- */

test("hover moves trusted mouse input to a selector or coordinates", async () => {
  const pageCalls = [];
  const pageEval = async (tabId, action, payload) => {
    pageCalls.push({ tabId, action, payload });
    if (action === "locate") return { ok: true, x: 120, y: 60 };
    return { width: 800, height: 600 };
  };
  const session = makeSession();
  const tools = makeTools({ session, pageEval });

  assert.deepEqual(await tools.hover({ tabId: 1, selector: "#save" }), { hovered: true });
  assert.deepEqual(pageCalls[0], {
    tabId: 1,
    action: "locate",
    payload: { selector: "#save" },
  });
  assert.deepEqual(session.calls[0], {
    tabId: 1,
    method: "Input.dispatchMouseEvent",
    params: { type: "mouseMoved", x: 120, y: 60, button: "none", buttons: 0 },
  });

  session.calls.length = 0;
  assert.deepEqual(await tools.hover({ tabId: 1, x: 10, y: 20 }), { hovered: true });
  assert.equal(pageCalls.at(-1).action, "viewport");
  assert.equal(session.calls[0].params.x, 10);
  assert.equal(session.calls[0].params.y, 20);

  await assert.rejects(tools.hover({ tabId: 1, x: 900, y: 20 }), /outside the viewport/);
});

test("hover validates its target and reports locate failures without clicking", async () => {
  const session = makeSession();
  const tools = makeTools({
    session,
    pageEval: async () => ({ ok: false, error: "Element is covered by another element" }),
  });
  await assert.rejects(tools.hover({ tabId: 1 }), /requires a "selector" or viewport/);
  await assert.rejects(tools.hover({ tabId: 1, x: 1 }), /both "x" and "y"/);
  await assert.rejects(tools.hover({ tabId: 1, selector: "#a", x: 1, y: 2 }), /not both/);
  await assert.rejects(
    tools.hover({ tabId: 1, selector: "#a" }),
    /Cannot hover: Element is covered/,
  );
  assert.equal(session.calls.length, 0);
});

test("hover falls back to Runtime.evaluate when pageEval is not injected", async () => {
  const session = makeSession(async (tabId, method) => {
    if (method === "Runtime.evaluate") {
      return { result: { value: { ok: true, x: 5, y: 6 } } };
    }
    return {};
  });
  const tools = createInteractionTools({ chromeApi: makeChrome(), session });
  assert.deepEqual(await tools.hover({ tabId: 1, selector: "#a" }), { hovered: true });
  const evaluateCall = session.calls.find((call) => call.method === "Runtime.evaluate");
  assert.match(evaluateCall.params.expression, /locate/);
  const mouse = session.calls.find((call) => call.method === "Input.dispatchMouseEvent");
  assert.equal(mouse.params.x, 5);
  assert.equal(mouse.params.y, 6);
});

/* -------------------------------------------------------------------------- */
/* Drag                                                                       */
/* -------------------------------------------------------------------------- */

test("drag interpolates trusted mouse moves and releases the button", async () => {
  const pageEval = async (tabId, action, payload) => {
    if (action === "locate") {
      if (payload.selector === "#from") return { ok: true, x: 10, y: 10 };
      if (payload.selector === "#to") return { ok: true, x: 100, y: 100 };
      return { ok: false, error: "No element matches selector" };
    }
    return { width: 800, height: 600 };
  };
  const session = makeSession();
  const tools = makeTools({ session, pageEval });

  assert.deepEqual(
    await tools.drag({
      tabId: 1,
      from: { selector: "#from" },
      to: { selector: "#to" },
      steps: 3,
    }),
    { dragged: true },
  );
  const mouse = session.calls.map((call) => call.params);
  assert.deepEqual(
    mouse.map((event) => event.type),
    ["mouseMoved", "mousePressed", "mouseMoved", "mouseMoved", "mouseMoved", "mouseReleased"],
  );
  assert.deepEqual([mouse[2].x, mouse[2].y], [40, 40]);
  assert.deepEqual([mouse[3].x, mouse[3].y], [70, 70]);
  assert.equal(mouse[1].buttons, 1);
  assert.equal(mouse.at(-1).buttons, 0);
  assert.equal(mouse.at(-1).x, 100);
  assert.equal(mouse.at(-1).y, 100);
});

test("drag accepts viewport coordinates without page lookups", async () => {
  const pageCalls = [];
  const session = makeSession();
  const tools = makeTools({
    session,
    pageEval: async (tabId, action) => {
      pageCalls.push(action);
      return { width: 800, height: 600 };
    },
  });
  await tools.drag({
    tabId: 1,
    from: { x: 10, y: 20 },
    to: { x: 30, y: 40 },
    steps: 1,
  });
  assert.deepEqual(pageCalls, ["viewport", "viewport"]);
  const mouse = session.calls.map((call) => call.params);
  assert.equal(mouse.at(-1).type, "mouseReleased");
  assert.equal(mouse.at(-1).x, 30);
  assert.equal(mouse.at(-1).y, 40);
});

test("drag releases the pressed button when a later event fails", async () => {
  let moves = 0;
  const session = makeSession(async (tabId, method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") {
      moves += 1;
      if (moves === 3) throw new Error("input pipeline failed");
    }
    return {};
  });
  const tools = makeTools({
    session,
    pageEval: async () => ({ width: 800, height: 600 }),
  });
  await assert.rejects(
    tools.drag({ tabId: 1, from: { x: 10, y: 10 }, to: { x: 100, y: 100 }, steps: 3 }),
    /input pipeline failed/,
  );
  const mouse = session.calls.map((call) => call.params);
  assert.equal(mouse.at(-1).type, "mouseReleased");
  assert.equal(mouse.at(-1).buttons, 0);
});

test("drag validates both endpoints and the step count", async () => {
  const tools = makeTools();
  await assert.rejects(
    tools.drag({ tabId: 1, from: {}, to: { x: 1, y: 2 } }),
    /from.*selector or both x and y/,
  );
  await assert.rejects(
    tools.drag({ tabId: 1, from: { x: 1 }, to: { x: 1, y: 2 } }),
    /both x and y/,
  );
  await assert.rejects(
    tools.drag({ tabId: 1, from: { selector: "#a", x: 1, y: 2 }, to: { x: 1, y: 2 } }),
    /either selector or x\/y/,
  );
  await assert.rejects(
    tools.drag({ tabId: 1, from: { x: 1, y: 2 } }),
    /requires "to"/,
  );
  await assert.rejects(
    tools.drag({ tabId: 1, from: { x: 1, y: 2 }, to: { x: 1, y: 2 }, steps: 99 }),
    /steps/,
  );
});

/* -------------------------------------------------------------------------- */
/* Frames                                                                     */
/* -------------------------------------------------------------------------- */

test("frames flattens the CDP frame tree with parent ids", async () => {
  const session = makeSession(async (tabId, method) => {
    assert.equal(method, "Page.getFrameTree");
    return {
      frameTree: {
        frame: {
          id: "root",
          url: "https://example.test/",
          name: "",
          securityOrigin: "https://example.test",
          mimeType: "text/html",
        },
        childFrames: [
          {
            frame: {
              id: "child",
              url: "https://example.test/frame",
              name: "inner",
              securityOrigin: "https://example.test",
              mimeType: "text/html",
            },
          },
          {
            frame: { id: "child2", url: "about:blank", name: "" },
            childFrames: [{ frame: { id: "grand", url: "about:blank" } }],
          },
        ],
      },
    };
  });
  const tools = makeTools({ session });
  const result = await tools.frames({ tabId: 4 });
  assert.deepEqual(
    result.frames.map((frame) => [frame.frameId, frame.parentFrameId]),
    [
      ["root", null],
      ["child", "root"],
      ["child2", "root"],
      ["grand", "child2"],
    ],
  );
  assert.equal(result.truncated, false);
  assert.equal(session.calls[0].tabId, 4);
});

test("frames caps large trees and rejects a malformed frame tree", async () => {
  const children = [];
  for (let index = 0; index < 600; index += 1) {
    children.push({ frame: { id: "f" + index, url: "about:blank", name: "" } });
  }
  const session = makeSession(async () => ({
    frameTree: { frame: { id: "root" }, childFrames: children },
  }));
  const result = await makeTools({ session }).frames({ tabId: 1 });
  assert.equal(result.frames.length, 500);
  assert.equal(result.truncated, true);

  const broken = makeTools({ session: makeSession(async () => ({ frameTree: {} })) });
  await assert.rejects(broken.frames({ tabId: 1 }), /no frame tree/);
});

/* -------------------------------------------------------------------------- */
/* File upload                                                                */
/* -------------------------------------------------------------------------- */

test("upload_file sets absolute paths on a unique file input", async () => {
  const session = makeUploadSession();
  const tools = makeTools({ session });
  const result = await tools.upload_file({
    tabId: 3,
    paths: ["C:\\tmp\\a.txt", "/tmp/b.txt", "\\\\server\\share\\c.txt"],
  });
  assert.deepEqual(result, {
    uploaded: true,
    count: 3,
    selector: 'input[type="file"]',
  });
  const query = session.calls.find((call) => call.method === "DOM.querySelectorAll");
  assert.equal(query.params.selector, 'input[type="file"]');
  const uploaded = session.calls.find((call) => call.method === "DOM.setFileInputFiles");
  assert.deepEqual(uploaded.params, {
    files: ["C:\\tmp\\a.txt", "/tmp/b.txt", "\\\\server\\share\\c.txt"],
    nodeId: 10,
  });

  session.calls.length = 0;
  await tools.upload_file({ tabId: 3, selector: "#avatar", paths: ["C:\\tmp\\a.txt"] });
  assert.equal(
    session.calls.find((call) => call.method === "DOM.querySelectorAll").params.selector,
    "#avatar",
  );
});

test("upload_file rejects relative paths before touching the page", async () => {
  const session = makeUploadSession();
  const tools = makeTools({ session });
  await assert.rejects(tools.upload_file({ tabId: 1 }), /paths/);
  await assert.rejects(tools.upload_file({ tabId: 1, paths: [] }), /at least one/);
  await assert.rejects(tools.upload_file({ tabId: 1, paths: ["relative.txt"] }), /absolute/);
  await assert.rejects(tools.upload_file({ tabId: 1, paths: ["C:\\tmp\\a", 5] }), /paths/);
  await assert.rejects(tools.upload_file({ tabId: 1, paths: ["C:\\tmp\\a\u0000b"] }), /invalid/);
  assert.equal(session.calls.length, 0);
});

test("upload_file rejects ambiguous, non-file and disabled inputs", async () => {
  const missing = makeTools({ session: makeUploadSession({ nodeIds: [] }) });
  await assert.rejects(missing.upload_file({ tabId: 1, paths: ["C:\\a.txt"] }), /No element matches/);

  const many = makeTools({ session: makeUploadSession({ nodeIds: [1, 2] }) });
  await assert.rejects(many.upload_file({ tabId: 1, paths: ["C:\\a.txt"] }), /matches 2 elements/);

  const notInput = makeTools({
    session: makeUploadSession({ node: { nodeName: "DIV", attributes: ["type", "file"] } }),
  });
  await assert.rejects(notInput.upload_file({ tabId: 1, paths: ["C:\\a.txt"] }), /not an input/);

  const notFile = makeTools({
    session: makeUploadSession({ node: { nodeName: "INPUT", attributes: ["type", "text"] } }),
  });
  await assert.rejects(notFile.upload_file({ tabId: 1, paths: ["C:\\a.txt"] }), /not a file input/);

  const disabled = makeTools({
    session: makeUploadSession({
      node: { nodeName: "INPUT", attributes: ["type", "file", "disabled", ""] },
    }),
  });
  await assert.rejects(disabled.upload_file({ tabId: 1, paths: ["C:\\a.txt"] }), /disabled/);
});

test("upload_file falls back to DOM.getAttributes when describeNode omits them", async () => {
  const tools = makeTools({
    session: makeUploadSession({
      node: { nodeName: "INPUT", attributes: [] },
      attributes: ["type", "file"],
    }),
  });
  assert.deepEqual(await tools.upload_file({ tabId: 1, paths: ["/tmp/a"] }), {
    uploaded: true,
    count: 1,
    selector: 'input[type="file"]',
  });
});

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

test("history uses tabs goBack/goForward/reload and returns the tab summary", async () => {
  const calls = [];
  const chrome = makeChrome({
    tabs: {
      goBack: async (tabId) => calls.push(["goBack", tabId]),
      goForward: async (tabId) => calls.push(["goForward", tabId]),
      reload: async (tabId, properties) => calls.push(["reload", tabId, properties]),
    },
  });
  const tools = makeTools({ chrome });
  const summary = {
    id: 2,
    windowId: 1,
    title: "Tab",
    url: "https://example.test/",
    active: true,
    status: "complete",
  };
  assert.deepEqual(await tools.history({ tabId: 2, action: "back" }), {
    action: "back",
    tab: summary,
  });
  assert.deepEqual(await tools.history({ tabId: 2, action: "forward" }), {
    action: "forward",
    tab: summary,
  });
  assert.deepEqual(await tools.history({ tabId: 2, action: "reload", bypassCache: true }), {
    action: "reload",
    tab: summary,
  });
  assert.deepEqual(calls, [
    ["goBack", 2],
    ["goForward", 2],
    ["reload", 2, { bypassCache: true }],
  ]);
});

test("history validates the action and maps navigation failures", async () => {
  const tools = makeTools();
  await assert.rejects(tools.history({ tabId: 1, action: "refresh" }), /back.*forward.*reload/);
  await assert.rejects(tools.history({ tabId: 1 }), /back.*forward.*reload/);

  const noApi = makeTools({ chrome: { tabs: { get: async (tabId) => ({ id: tabId, status: "complete" }) } } });
  await assert.rejects(noApi.history({ tabId: 1, action: "back" }), /does not support tabs.goBack/);
  await assert.rejects(noApi.history({ tabId: 1, action: "reload" }), /does not support tabs.reload/);

  const failing = makeTools({
    chrome: makeChrome({
      tabs: {
        goBack: async () => {
          throw new Error("Cannot go back");
        },
      },
    }),
  });
  await assert.rejects(
    failing.history({ tabId: 1, action: "back" }),
    /no previous history entry/,
  );
});

/* -------------------------------------------------------------------------- */
/* Download tracking                                                          */
/* -------------------------------------------------------------------------- */

test("wait_download follows an exact download id until it finishes", async () => {
  const started = new Date().toISOString();
  const base = {
    id: 7,
    filename: "C:\\Downloads\\report.pdf",
    url: "https://example.test/report.pdf",
    startTime: started,
  };
  const harness = makeDownloads((query, calls) =>
    calls === 1
      ? [{ ...base, state: "in_progress", bytesReceived: 10, totalBytes: 100 }]
      : [{ ...base, state: "complete", bytesReceived: 100, totalBytes: 100, exists: true }],
  );
  const tools = makeTools({
    chrome: makeChrome({ downloads: harness.api }),
    session: makeSession(),
  });
  const result = await tools.wait_download({ downloadId: 7, timeoutMs: 2000 });
  assert.deepEqual(result, {
    id: 7,
    filename: "C:\\Downloads\\report.pdf",
    url: "https://example.test/report.pdf",
    state: "complete",
    error: null,
    bytesReceived: 100,
    totalBytes: 100,
    exists: true,
  });
  assert.deepEqual(harness.searchCalls[0], { id: 7 });
  assert.equal(harness.downloadCalls.length, 0);
});

test("wait_download filters recent downloads by filename or url", async () => {
  const now = Date.now();
  const items = [
    {
      id: 1,
      filename: "/tmp/other.zip",
      url: "https://x.test/other.zip",
      state: "complete",
      startTime: new Date(now).toISOString(),
    },
    {
      id: 2,
      filename: "/tmp/Report.PDF",
      url: "https://x.test/report.pdf",
      state: "complete",
      startTime: new Date(now - 2000).toISOString(),
    },
  ];
  const harness = makeDownloads(() => items);
  const tools = makeTools({
    chrome: makeChrome({ downloads: harness.api }),
    session: makeSession(),
  });
  assert.equal(
    (await tools.wait_download({ filenameContains: "report", timeoutMs: 1000 })).id,
    2,
  );
  assert.equal(
    (await tools.wait_download({ urlContains: "REPORT.PDF", timeoutMs: 1000 })).id,
    2,
  );
});

test("wait_download refuses to guess between matching downloads", async () => {
  const started = new Date().toISOString();
  const items = [
    { id: 1, filename: "/tmp/a.pdf", state: "complete", startTime: started },
    { id: 2, filename: "/tmp/b.pdf", state: "in_progress", startTime: started },
  ];
  const tools = makeTools({
    chrome: makeChrome({ downloads: makeDownloads(() => items).api }),
    session: makeSession(),
  });
  await assert.rejects(
    tools.wait_download({ filenameContains: ".pdf", timeoutMs: 500 }),
    /Multiple recent downloads/,
  );
});

test("wait_download ignores downloads outside the recent window", async () => {
  const items = [
    {
      id: 9,
      filename: "/tmp/old.pdf",
      state: "complete",
      startTime: "2020-01-01T00:00:00.000Z",
    },
  ];
  const tools = makeTools({
    chrome: makeChrome({ downloads: makeDownloads(() => items).api }),
    session: makeSession(),
  });
  await assert.rejects(tools.wait_download({ timeoutMs: 150 }), /Timed out/);
});

test("wait_download returns an in-progress download when the deadline expires", async () => {
  const items = [
    {
      id: 11,
      filename: "/tmp/slow.bin",
      state: "in_progress",
      bytesReceived: 5,
      totalBytes: 100,
      startTime: new Date().toISOString(),
    },
  ];
  const tools = makeTools({
    chrome: makeChrome({ downloads: makeDownloads(() => items).api }),
    session: makeSession(),
  });
  const result = await tools.wait_download({ timeoutMs: 150 });
  assert.equal(result.id, 11);
  assert.equal(result.state, "in_progress");
  assert.equal(result.error, null);
  assert.equal(result.timedOut, true);
});

test("wait_download returns the error of an interrupted download", async () => {
  const items = [
    {
      id: 5,
      filename: "/tmp/x.bin",
      state: "interrupted",
      error: "NETWORK_FAILED",
      startTime: new Date().toISOString(),
    },
  ];
  const tools = makeTools({
    chrome: makeChrome({ downloads: makeDownloads(() => items).api }),
    session: makeSession(),
  });
  const result = await tools.wait_download({ downloadId: 5, timeoutMs: 500 });
  assert.equal(result.id, 5);
  assert.equal(result.state, "interrupted");
  assert.equal(result.error, "NETWORK_FAILED");
});

test("wait_download times out for an unknown download id", async () => {
  const tools = makeTools({
    chrome: makeChrome({ downloads: makeDownloads(() => []).api }),
    session: makeSession(),
  });
  await assert.rejects(
    tools.wait_download({ downloadId: 42, timeoutMs: 120 }),
    /waiting for download 42/,
  );
});

test("wait_download validates parameters and needs the downloads permission", async () => {
  const withoutDownloads = makeTools({
    chrome: { tabs: makeTabs() },
    session: makeSession(),
  });
  await assert.rejects(withoutDownloads.wait_download({}), /downloads.*permission/);

  const harness = makeDownloads(() => []);
  const tools = makeTools({
    chrome: makeChrome({ downloads: harness.api }),
    session: makeSession(),
  });
  await assert.rejects(tools.wait_download({ downloadId: 0 }), /downloadId/);
  await assert.rejects(tools.wait_download({ timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(tools.wait_download({ timeoutMs: 26000 }), /timeoutMs/);
  await assert.rejects(tools.wait_download({ lookbackMs: -1 }), /lookbackMs/);
  await assert.rejects(tools.wait_download({ filenameContains: "   " }), /filenameContains/);
  await assert.rejects(tools.wait_download({ urlContains: 5 }), /urlContains/);
  assert.equal(harness.searchCalls.length, 0);
});

test("wait_download surfaces downloads search failures", async () => {
  const api = {
    search: async () => {
      throw new Error("permission denied");
    },
    download: async () => 1,
  };
  const tools = makeTools({
    chrome: makeChrome({ downloads: api }),
    session: makeSession(),
  });
  await assert.rejects(
    tools.wait_download({ timeoutMs: 500 }),
    /Cannot read downloads: permission denied/,
  );
});

/* -------------------------------------------------------------------------- */
/* Shared plumbing                                                            */
/* -------------------------------------------------------------------------- */

test("createInteractionTools requires chromeApi and a debugger session", () => {
  assert.throws(() => createInteractionTools(), /chromeApi/);
  assert.throws(() => createInteractionTools({ chromeApi: {} }), /debugger session/);
  assert.throws(
    () => createInteractionTools({ chromeApi: {}, session: {} }),
    /debugger session/,
  );
});

test("every tab-scoped interaction tool validates tabId", async () => {
  const tools = makeTools();
  const calls = [
    () => tools.hover({ tabId: 0, selector: "#a" }),
    () => tools.drag({ tabId: 0, from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }),
    () => tools.frames({}),
    () => tools.upload_file({ tabId: -1, paths: ["/tmp/a"] }),
    () => tools.history({ tabId: 1.5, action: "back" }),
  ];
  for (const call of calls) await assert.rejects(call, /tabId/);
});
