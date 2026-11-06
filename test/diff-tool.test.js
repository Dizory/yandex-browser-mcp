// Diff tool tests. No browser, no network, no filesystem: captures, tabs,
// clocks and the debugger session are small local fakes.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { createDiffTool } from "../extension/lib/diff-tool.js";
import { diffDefinition } from "../server/diff-tool.js";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

function makeChrome() {
  const tabs = new Map();
  const removedListeners = [];
  const chromeApi = {
    tabs: {
      get: async (tabId) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error("No tab with id: " + tabId);
        return { ...tab };
      },
      onRemoved: {
        addListener(listener) {
          removedListeners.push(listener);
        },
      },
    },
  };
  return {
    chromeApi,
    addTab(tabId, url) {
      tabs.set(tabId, {
        id: tabId,
        windowId: 1,
        title: "Tab " + tabId,
        url,
        active: false,
        status: "complete",
      });
    },
    removeTab(tabId) {
      tabs.delete(tabId);
      for (const listener of removedListeners) listener(tabId, { isWindowClosing: false });
    },
  };
}

function makePages() {
  const pages = new Map();
  const calls = [];
  async function snapshot({ tabId, maxChars }) {
    calls.push({ tabId, maxChars });
    const page = pages.get(tabId);
    if (!page) throw new Error("Snapshot unavailable for tab " + tabId);
    return {
      url: page.url,
      title: page.title === undefined ? "Page" : page.title,
      text: page.text === undefined ? "" : page.text,
      elements: (page.elements || []).map((element) => ({ ...element })),
      truncated: page.truncated === true,
    };
  }
  return {
    snapshot,
    calls,
    set(tabId, page) {
      pages.set(tabId, page);
    },
  };
}

function makeClock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    },
  };
}

function element(selector, name, extra = {}) {
  return { selector, tag: "button", role: "button", name, type: "", ...extra };
}

function setup(options = {}) {
  const chrome = makeChrome();
  const pages = makePages();
  const clock = makeClock();
  const tool = createDiffTool({
    snapshot: pages.snapshot,
    chromeApi: chrome.chromeApi,
    now: clock.now,
    ...options,
  });
  return {
    chromeApi: chrome.chromeApi,
    addTab: chrome.addTab,
    removeTab: chrome.removeTab,
    pages,
    clock,
    tool,
  };
}

/* -------------------------------------------------------------------------- */
/* Factory and validation                                                     */
/* -------------------------------------------------------------------------- */

test("createDiffTool requires a capture source and a tabs API", () => {
  assert.throws(() => createDiffTool(), /snapshot function/);
  assert.throws(() => createDiffTool({ snapshot: async () => ({}) }), /chromeApi\.tabs/);
  assert.doesNotThrow(() =>
    createDiffTool({ snapshot: async () => ({}), chromeApi: { tabs: {} } }),
  );
  assert.throws(
    () =>
      createDiffTool({
        snapshot: async () => ({}),
        chromeApi: { tabs: { get: async () => ({}) } },
        serializeCapture: true,
      }),
    /exclusive/,
  );
});

test("a capture-only embedding needs no tabs.get", async () => {
  const pages = makePages();
  pages.set(1, { url: "https://example.test/a", text: "A" });
  const tool = createDiffTool({ snapshot: pages.snapshot, chromeApi: { tabs: {} } });
  const result = await tool({ tabId: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://example.test/a");
  assert.equal(result.stored, true);
});

test("diff validates parameters and ignores fields it does not execute", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, { url: "https://example.test/a", text: "" });

  await assert.rejects(env.tool(), /tabId/);
  await assert.rejects(env.tool({ tabId: 0 }), /positive integer/);
  await assert.rejects(env.tool({ tabId: "one" }), /positive integer/);
  await assert.rejects(env.tool({ tabId: 1, text: "yes" }), /"text" must be a boolean/);
  await assert.rejects(env.tool({ tabId: 1, elements: 1 }), /"elements" must be a boolean/);
  await assert.rejects(env.tool({ tabId: 1, text: false, elements: false }), /text.*elements/);
  await assert.rejects(env.tool({ tabId: 1, maxChars: "10" }), /maxChars/);
  await assert.rejects(env.tool({ tabId: 1, maxTextChunks: "10" }), /maxTextChunks/);
  await assert.rejects(env.tool({ tabId: 1, maxDiffChars: "big" }), /maxDiffChars/);
  await assert.rejects(env.tool({ tabId: 1, snapshotId: 5 }), /"snapshotId" must be a string/);
  await assert.rejects(env.tool({ tabId: 1, snapshotId: "  " }), /1 to 200 characters/);
  await assert.rejects(
    env.tool({ tabId: 1, snapshotId: "diff_x", baseline: { text: "a" } }),
    /not both/,
  );
  await assert.rejects(env.tool({ tabId: 1, baseline: "text" }), /snapshot-like object/);
  await assert.rejects(env.tool({ tabId: 1, baseline: [] }), /snapshot-like object/);

  // Unknown fields (for example expression) are never evaluated or echoed.
  const result = await env.tool({ tabId: 1, expression: "alert(1)", script: "1+1" });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes("alert"), false);
  assert.equal(JSON.stringify(result).includes("1+1"), false);

  assert.equal(env.pages.calls.length, 1, "invalid calls must not capture the page");
});

test("limits are clamped to their supported range", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, { url: "https://example.test/a", text: "" });

  const result = await env.tool({
    tabId: 1,
    maxChars: 999999,
    maxTextChunks: 10000,
    maxElementChanges: 0,
    maxDiffChars: 1,
  });
  assert.deepEqual(result.limits, {
    maxChars: 100000,
    maxTextChunks: 200,
    maxElementChanges: 1,
    maxDiffChars: 500,
  });
  assert.deepEqual(env.pages.calls[0], { tabId: 1, maxChars: 100000 });
});

test("a malformed capture is reported, not turned into an empty diff", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  const tool = createDiffTool({
    snapshot: async () => null,
    chromeApi: env.chromeApi,
    now: env.clock.now,
  });
  await assert.rejects(tool({ tabId: 1 }), /Snapshot returned no data/);
});

/* -------------------------------------------------------------------------- */
/* Baseline lifecycle                                                         */
/* -------------------------------------------------------------------------- */

test("the first call stores a reference baseline and returns a new snapshotId", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/app");
  env.pages.set(1, {
    url: "https://example.test/app",
    title: "App",
    text: "Header\nAlpha\nBeta",
    elements: [element("#save", "Save")],
  });

  const result = await env.tool({ tabId: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.tabId, 1);
  assert.equal(result.reference, "none");
  assert.equal(result.compared, false);
  assert.match(result.snapshotId, /^diff_/);
  assert.equal(result.stored, true);
  assert.equal(result.baselineSnapshotId, null);
  assert.equal(result.url, "https://example.test/app");
  assert.equal(result.title, "App");
  assert.equal(result.navigated, null);
  assert.equal(result.documentVerified, false);
  assert.equal(result.baselineCapturedAt, null);
  assert.equal(result.baselineAgeMs, null);
  assert.equal(result.baselineExpiresAt, null);
  assert.deepEqual(result.include, { text: true, elements: true });
  assert.deepEqual(result.text.added, []);
  assert.equal(result.text.available, false);
  assert.equal(result.text.reason, "no-baseline");
  assert.equal(result.elements.available, false);
  assert.equal(result.elements.reason, "no-baseline");
  assert.equal(result.complete, false);
  assert.deepEqual(env.pages.calls, [{ tabId: 1, maxChars: 20000 }]);
  assert.equal(env.tool.stats().baselines, 1);
  assert.equal(env.tool.stats().tabs, 1);
});

test("diffing against a snapshotId reports changes and chains a new id", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/app");
  env.pages.set(1, {
    url: "https://example.test/app",
    title: "App",
    text: "Header\nAlpha\nBeta\nSave",
    elements: [
      element("#save", "Save"),
      { selector: "#email", tag: "input", role: "textbox", name: "E-mail", type: "email", value: "a@b.c" },
      element("#old", "Old"),
    ],
  });
  const first = await env.tool({ tabId: 1 });

  env.clock.advance(1000);
  env.pages.set(1, {
    url: "https://example.test/app",
    title: "App",
    text: "Header\nAlpha\nGamma\nSave",
    elements: [
      element("#save", "Saved"),
      { selector: "#email", tag: "input", role: "textbox", name: "E-mail", type: "email", value: "a@b.c" },
      element("#link", "Open"),
    ],
  });
  const second = await env.tool({ tabId: 1, snapshotId: first.snapshotId });

  assert.equal(second.compared, true);
  assert.equal(second.reference, "snapshotId");
  assert.equal(second.baselineSnapshotId, first.snapshotId);
  assert.notEqual(second.snapshotId, first.snapshotId);
  assert.equal(second.stored, true);
  assert.deepEqual(second.text.added, ["Gamma"]);
  assert.deepEqual(second.text.removed, ["Beta"]);
  assert.equal(second.text.addedCount, 1);
  assert.equal(second.text.removedCount, 1);
  assert.equal(second.text.truncated, false);
  assert.deepEqual(second.elements.added.map((item) => item.selector), ["#link"]);
  assert.deepEqual(second.elements.removed.map((item) => item.selector), ["#old"]);
  assert.deepEqual(second.elements.changed, [
    { selector: "#save", changes: [{ field: "name", before: "Save", after: "Saved" }] },
  ]);
  assert.equal(second.elements.addedCount, 1);
  assert.equal(second.elements.removedCount, 1);
  assert.equal(second.elements.changedCount, 1);
  assert.equal(second.elements.unchangedCount, 1);
  assert.equal(second.navigated, false);
  assert.equal(second.documentVerified, true);
  assert.equal(second.baselineCapturedAt, first.capturedAt);
  assert.equal(second.baselineAgeMs, 1000);
  assert.equal(second.baselineExpiresAt, first.capturedAt + 300000);
  assert.equal(second.complete, true);
  assert.equal(second.clipped.baseline, false);
  assert.equal(second.clipped.current, false);

  const third = await env.tool({ tabId: 1, snapshotId: second.snapshotId });
  assert.deepEqual(third.text.added, []);
  assert.deepEqual(third.text.removed, []);
  assert.equal(third.text.addedCount, 0);
  assert.equal(third.text.removedCount, 0);
  assert.equal(third.elements.addedCount, 0);
  assert.equal(third.elements.removedCount, 0);
  assert.equal(third.elements.changedCount, 0);
  assert.equal(third.elements.unchangedCount, 3);
  assert.equal(third.complete, true);
});

test("duplicate chunks and duplicate selectors do not create phantom changes", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/list");
  env.pages.set(1, { url: "https://example.test/list", text: "a\na\nb", elements: [] });
  const first = await env.tool({ tabId: 1 });

  env.pages.set(1, {
    url: "https://example.test/list",
    text: "a\nb\nb",
    elements: [element("#x", "First"), element("#x", "Second")],
  });
  const second = await env.tool({ tabId: 1, snapshotId: first.snapshotId });

  assert.deepEqual(second.text.added, ["b"]);
  assert.deepEqual(second.text.removed, ["a"]);
  assert.equal(second.text.addedCount, 1);
  assert.equal(second.text.removedCount, 1);
  assert.equal(second.elements.addedCount, 1, "duplicate selectors count once");
  assert.deepEqual(second.elements.added, [
    { selector: "#x", tag: "button", role: "button", name: "First", type: "" },
  ]);
});

test("stored baselines are immutable copies", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/app");
  const page = { url: "https://example.test/app", text: "A", elements: [element("#a", "A")] };
  env.pages.set(1, page);
  const first = await env.tool({ tabId: 1 });

  page.text = "HACKED";
  page.elements[0].name = "HACKED";
  env.pages.set(1, { url: "https://example.test/app", text: "A", elements: [element("#a", "A")] });
  const second = await env.tool({ tabId: 1, snapshotId: first.snapshotId });

  assert.deepEqual(second.text.added, []);
  assert.deepEqual(second.text.removed, []);
  assert.equal(second.elements.changedCount, 0);
  assert.equal(second.elements.unchangedCount, 1);
  assert.equal(second.complete, true);
});

test("reset drops every reference baseline", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/app");
  env.pages.set(1, { url: "https://example.test/app", text: "A" });
  const first = await env.tool({ tabId: 1 });
  assert.equal(env.tool.stats().baselines, 1);
  env.tool.reset();
  assert.equal(env.tool.stats().baselines, 0);
  await assert.rejects(env.tool({ tabId: 1, snapshotId: first.snapshotId }), /unknown or expired/);
});

/* -------------------------------------------------------------------------- */
/* Stateless baselines                                                        */
/* -------------------------------------------------------------------------- */

test("a caller-provided baseline needs no stored state", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, {
    url: "https://example.test/a",
    title: "A",
    text: "One\nTwo",
    elements: [element("#go", "Go")],
  });
  const baseline = {
    url: "https://example.test/a",
    title: "A",
    text: "One",
    elements: [{ selector: "#go", tag: "button", role: "button", name: "Go", type: "" }],
    truncated: false,
  };

  const result = await env.tool({ tabId: 1, baseline });
  assert.equal(result.reference, "provided");
  assert.equal(result.baselineSnapshotId, null);
  assert.equal(result.baselineCapturedAt, null);
  assert.equal(result.baselineAgeMs, null);
  assert.equal(result.baselineExpiresAt, null);
  assert.equal(result.navigated, false);
  assert.equal(result.documentVerified, true);
  assert.deepEqual(result.text.added, ["Two"]);
  assert.deepEqual(result.text.removed, []);
  assert.deepEqual(result.elements.added, []);
  assert.equal(result.elements.changedCount, 0);
  assert.equal(result.elements.unchangedCount, 1);
  assert.equal(result.complete, true);
  assert.equal(result.stored, true, "the current capture is still reusable by id");
  assert.equal(env.pages.calls.length, 1);
});

test("a text-only baseline reports elements as unavailable instead of all-new", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, {
    url: "https://example.test/a",
    text: "One\nTwo",
    elements: [element("#go", "Go")],
  });

  const result = await env.tool({ tabId: 1, baseline: { url: "https://example.test/a", text: "One" } });
  assert.equal(result.text.available, true);
  assert.deepEqual(result.text.added, ["Two"]);
  assert.equal(result.elements.available, false);
  assert.equal(result.elements.reason, "baseline-has-no-elements");
  assert.deepEqual(result.elements.added, []);
  assert.equal(result.complete, false);
});

test("missing baseline element fields are unknown, not changed", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, {
    url: "https://example.test/a",
    text: "A",
    elements: [{ selector: "#go", tag: "button", role: "button", name: "Go", type: "" }],
  });

  const result = await env.tool({
    tabId: 1,
    baseline: { url: "https://example.test/a", text: "A", elements: [{ selector: "#go", name: "Go" }] },
  });
  assert.equal(result.elements.unchangedCount, 1);
  assert.equal(result.elements.changedCount, 0);
  assert.deepEqual(result.elements.changed, []);
  assert.deepEqual(result.elements.added, []);
  assert.deepEqual(result.elements.removed, []);
});

test("a baseline without a URL cannot be trusted to describe the same document", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, { url: "https://example.test/a", text: "One\nTwo", elements: [] });

  const result = await env.tool({ tabId: 1, baseline: { text: "One" } });
  assert.equal(result.navigated, null);
  assert.equal(result.documentVerified, false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.text.added, ["Two"]);
});

/* -------------------------------------------------------------------------- */
/* Tab binding and reference safety                                          */
/* -------------------------------------------------------------------------- */

test("reference snapshots are bound to their tab and never mix tabs", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/one");
  env.addTab(2, "https://example.test/two");
  env.pages.set(1, { url: "https://example.test/one", text: "one" });
  env.pages.set(2, { url: "https://example.test/two", text: "two" });
  const first = await env.tool({ tabId: 1 });

  const callsBefore = env.pages.calls.length;
  await assert.rejects(env.tool({ tabId: 2, snapshotId: first.snapshotId }), /tab 1/);
  assert.equal(env.pages.calls.length, callsBefore, "a foreign reference must not capture the other tab");

  const own = await env.tool({ tabId: 1, snapshotId: first.snapshotId });
  assert.equal(own.tabId, 1);
  assert.equal(own.compared, true);
});

test("unknown and expired references fail with recovery guidance", async () => {
  const env = setup({ ttlMs: 1000 });
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, { url: "https://example.test/a", text: "A" });
  const first = await env.tool({ tabId: 1 });

  await assert.rejects(
    env.tool({ tabId: 1, snapshotId: "diff_missing" }),
    /unknown or expired.*take a new baseline/,
  );

  env.clock.advance(999);
  const stillValid = await env.tool({ tabId: 1, snapshotId: first.snapshotId });
  assert.equal(stillValid.compared, true);

  env.clock.advance(2);
  const callsBefore = env.pages.calls.length;
  await assert.rejects(env.tool({ tabId: 1, snapshotId: first.snapshotId }), /unknown or expired/);
  assert.equal(env.pages.calls.length, callsBefore, "an expired reference must not capture the page");
  assert.equal(env.tool.stats().baselines, 1);
});

test("closed tabs drop their baselines", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, { url: "https://example.test/a", text: "A" });
  await env.tool({ tabId: 1 });
  assert.equal(env.tool.stats().baselines, 1);
  env.removeTab(1);
  assert.equal(env.tool.stats().baselines, 0);
});

test("missing tabs fail before capture and other tab errors keep context", async () => {
  const env = setup();
  env.pages.set(2, { url: "https://example.test/b", text: "B" });
  await assert.rejects(env.tool({ tabId: 2 }), /Tab 2 not found/);
  assert.equal(env.pages.calls.length, 0);

  const pages = makePages();
  pages.set(1, { url: "https://example.test/a", text: "" });
  const tool = createDiffTool({
    snapshot: pages.snapshot,
    chromeApi: {
      tabs: {
        get: async () => {
          throw new Error("Permission denied");
        },
      },
    },
  });
  await assert.rejects(tool({ tabId: 1 }), /Cannot access tab 1: Permission denied/);
});

/* -------------------------------------------------------------------------- */
/* Eviction and memory caps                                                   */
/* -------------------------------------------------------------------------- */

test("the store evicts least recently used baselines", async () => {
  const env = setup({ maxBaselines: 2, maxBaselinesPerTab: 5 });
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, { url: "https://example.test/a", text: "v1" });
  const first = await env.tool({ tabId: 1 });

  env.clock.advance(1000);
  env.pages.set(1, { url: "https://example.test/a", text: "v2" });
  const second = await env.tool({ tabId: 1 });

  // Using the first baseline makes it newer than the second one; the capture
  // taken by this call also enters the store.
  env.clock.advance(1000);
  const reuse = await env.tool({ tabId: 1, snapshotId: first.snapshotId, elements: false });
  assert.equal(reuse.compared, true);

  env.clock.advance(1000);
  env.pages.set(1, { url: "https://example.test/a", text: "v3" });
  await env.tool({ tabId: 1 });

  assert.equal(env.tool.stats().baselines, 2);
  await assert.rejects(env.tool({ tabId: 1, snapshotId: second.snapshotId }), /unknown or expired/);
  const survivor = await env.tool({ tabId: 1, snapshotId: reuse.snapshotId, elements: false });
  assert.equal(survivor.compared, true);
});

test("the per-tab cap evicts the oldest baseline of that tab", async () => {
  const env = setup({ maxBaselines: 10, maxBaselinesPerTab: 2 });
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, { url: "https://example.test/a", text: "v1" });
  const first = await env.tool({ tabId: 1 });
  env.clock.advance(10);
  const second = await env.tool({ tabId: 1 });
  env.clock.advance(10);
  const third = await env.tool({ tabId: 1 });

  assert.equal(env.tool.stats().baselines, 2);
  await assert.rejects(env.tool({ tabId: 1, snapshotId: first.snapshotId }), /unknown or expired/);
  const survivor = await env.tool({ tabId: 1, snapshotId: second.snapshotId, elements: false });
  assert.equal(survivor.compared, true);
  assert.ok(third.snapshotId);
});

test("the store stays under its memory cap", async () => {
  const env = setup({ maxStoreSize: 256 * 1024, maxBaselines: 100, maxBaselinesPerTab: 100 });
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, { url: "https://example.test/a", text: "x".repeat(50000) });

  for (let index = 0; index < 6; index += 1) {
    await env.tool({ tabId: 1 });
    env.clock.advance(10);
  }
  const stats = env.tool.stats();
  assert.ok(stats.baselines < 6, "entries are evicted to respect the cap");
  assert.ok(stats.bytes <= 256 * 1024, "stored bytes stay under the cap");
});

test("a capture too large to keep is diffed but not stored", async () => {
  const env = setup({ maxStoreSize: 300 * 1024 });
  env.addTab(1, "https://example.test/big");
  const elements = [];
  for (let index = 0; index < 300; index += 1) {
    elements.push(element("#" + "a".repeat(1200) + index, "Button " + index));
  }
  env.pages.set(1, { url: "https://example.test/big", text: "", elements });

  const result = await env.tool({ tabId: 1 });
  assert.equal(result.stored, false);
  assert.equal(result.snapshotId, null);
  assert.equal(env.tool.stats().baselines, 0);
});

/* -------------------------------------------------------------------------- */
/* Navigation, clipping and output bounds                                     */
/* -------------------------------------------------------------------------- */

test("navigation is reported and fragment changes are not navigation", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, {
    url: "https://example.test/a",
    text: "Old page",
    elements: [element("#old", "Old")],
  });
  const first = await env.tool({ tabId: 1 });

  env.addTab(1, "https://example.test/b");
  env.pages.set(1, {
    url: "https://example.test/b",
    text: "New page",
    elements: [element("#new", "New")],
  });
  const navigated = await env.tool({ tabId: 1, snapshotId: first.snapshotId });
  assert.equal(navigated.navigated, true);
  assert.equal(navigated.documentVerified, true);
  assert.equal(navigated.previousUrl, "https://example.test/a");
  assert.equal(navigated.url, "https://example.test/b");
  assert.deepEqual(navigated.text.added, ["New page"]);
  assert.deepEqual(navigated.text.removed, ["Old page"]);
  assert.deepEqual(navigated.elements.added.map((item) => item.selector), ["#new"]);
  assert.deepEqual(navigated.elements.removed.map((item) => item.selector), ["#old"]);

  env.clock.advance(10);
  env.addTab(1, "https://example.test/b#section");
  env.pages.set(1, {
    url: "https://example.test/b#section",
    text: "New page",
    elements: [element("#new", "New")],
  });
  const hashOnly = await env.tool({ tabId: 1, snapshotId: navigated.snapshotId });
  assert.equal(hashOnly.navigated, false);
});

test("clipped captures are flagged and make the diff incomplete", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, { url: "https://example.test/a", text: "A", truncated: true });
  const first = await env.tool({ tabId: 1 });
  assert.equal(first.clipped.current, true);
  assert.equal(first.complete, false);

  env.pages.set(1, { url: "https://example.test/a", text: "A\nB", truncated: false });
  const second = await env.tool({ tabId: 1, snapshotId: first.snapshotId });
  assert.equal(second.clipped.baseline, true);
  assert.equal(second.clipped.current, false);
  assert.equal(second.text.clipped, true);
  assert.equal(second.elements.clipped, true);
  assert.equal(second.complete, false);

  const provided = await env.tool({
    tabId: 1,
    baseline: { url: "https://example.test/a", text: "A", truncated: true },
  });
  assert.equal(provided.clipped.baseline, true);
  assert.equal(provided.complete, false);
});

test("text beyond the capture budget is clipped", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/long");
  env.pages.set(1, { url: "https://example.test/long", text: "word ".repeat(12000) });
  const result = await env.tool({ tabId: 1 });
  assert.equal(result.clipped.current, true);
  assert.equal(result.complete, false);
});

test("diff output is bounded by the requested limits", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, { url: "https://example.test/a", text: "" });
  const first = await env.tool({ tabId: 1 });

  const lines = [];
  const elements = [];
  for (let index = 0; index < 100; index += 1) {
    lines.push("line " + index);
    elements.push(element("#e" + index, "E " + index));
  }
  env.pages.set(1, { url: "https://example.test/a", text: lines.join("\n"), elements });
  const second = await env.tool({
    tabId: 1,
    snapshotId: first.snapshotId,
    maxTextChunks: 5,
    maxElementChanges: 3,
  });

  assert.equal(second.text.addedCount, 100);
  assert.deepEqual(second.text.added, ["line 0", "line 1", "line 2", "line 3", "line 4"]);
  assert.equal(second.text.truncated, true);
  assert.equal(second.elements.addedCount, 100);
  assert.equal(second.elements.added.length, 3);
  assert.equal(second.elements.truncated, true);
  assert.equal(second.complete, false);
  assert.deepEqual(second.limits, {
    maxChars: 20000,
    maxTextChunks: 5,
    maxElementChanges: 3,
    maxDiffChars: 12000,
  });

  env.pages.set(1, { url: "https://example.test/a", text: "z".repeat(1000) });
  const third = await env.tool({
    tabId: 1,
    snapshotId: second.snapshotId,
    maxTextChunks: 10,
    maxDiffChars: 500,
    elements: false,
  });
  assert.equal(third.text.addedCount, 3);
  assert.equal(third.text.added.length, 1);
  assert.equal(third.text.truncated, true);
});

test("text and elements can be diffed independently", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, { url: "https://example.test/a", text: "A", elements: [element("#a", "A")] });
  const first = await env.tool({ tabId: 1, elements: false });
  assert.deepEqual(first.include, { text: true, elements: false });
  assert.equal(first.elements.available, false);
  assert.equal(first.elements.reason, "disabled");
  assert.deepEqual(first.elements.changed, []);

  env.pages.set(1, {
    url: "https://example.test/a",
    text: "A\nB",
    elements: [element("#a", "A"), element("#b", "B")],
  });
  const second = await env.tool({ tabId: 1, snapshotId: first.snapshotId, text: false, elements: true });
  assert.equal(second.text.available, false);
  assert.equal(second.text.reason, "disabled");
  assert.deepEqual(second.text.added, []);
  assert.equal(second.elements.available, true);
  assert.deepEqual(second.elements.added.map((item) => item.selector), ["#b"]);
});

/* -------------------------------------------------------------------------- */
/* Secrets and serialization                                                  */
/* -------------------------------------------------------------------------- */

test("secret field values never appear in a diff", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/form");
  env.pages.set(1, {
    url: "https://example.test/form",
    text: "Form",
    elements: [
      { selector: "#pw", tag: "input", role: "textbox", name: "Password", type: "password", value: "hunter2" },
      { selector: "#file", tag: "input", role: "button", name: "File", type: "file", value: "C:\\secret.txt" },
      { selector: "#q", tag: "input", role: "textbox", name: "Query", type: "text", value: "a" },
    ],
  });
  const first = await env.tool({ tabId: 1 });

  env.pages.set(1, {
    url: "https://example.test/form",
    text: "Form",
    elements: [
      { selector: "#q", tag: "input", role: "textbox", name: "Query", type: "text", value: "ab" },
    ],
  });
  const diff = await env.tool({ tabId: 1, snapshotId: first.snapshotId });
  const serialized = JSON.stringify(diff);
  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes("secret.txt"), false);
  assert.deepEqual(diff.elements.removed.map((item) => item.selector), ["#pw", "#file"]);
  assert.deepEqual(diff.elements.changed, [
    { selector: "#q", changes: [{ field: "value", before: "a", after: "ab" }] },
  ]);

  const provided = await env.tool({
    tabId: 1,
    baseline: {
      url: "https://example.test/form",
      text: "Form",
      elements: [
        { selector: "#pw2", tag: "input", role: "textbox", name: "Password", type: "password", value: "pa55" },
      ],
    },
  });
  assert.equal(JSON.stringify(provided).includes("pa55"), false);
});

test("a raw capture can be serialized through the debugger session", async () => {
  const env = setup();
  env.addTab(1, "https://example.test/a");
  env.pages.set(1, { url: "https://example.test/a", text: "" });

  const exclusiveCalls = [];
  const session = {
    exclusive: async (tabId, task) => {
      exclusiveCalls.push(tabId);
      return task();
    },
  };
  const serialized = createDiffTool({
    snapshot: env.pages.snapshot,
    chromeApi: env.chromeApi,
    session,
    serializeCapture: true,
    now: env.clock.now,
  });
  await serialized({ tabId: 1 });
  assert.deepEqual(exclusiveCalls, [1]);

  const unserialized = createDiffTool({
    snapshot: env.pages.snapshot,
    chromeApi: env.chromeApi,
    session,
    now: env.clock.now,
  });
  await unserialized({ tabId: 1 });
  assert.deepEqual(exclusiveCalls, [1], "commands.snapshot already holds the tab queue");
});

/* -------------------------------------------------------------------------- */
/* Server tool definition                                                     */
/* -------------------------------------------------------------------------- */

test("diffDefinition is a strict browser_diff tool definition", () => {
  assert.ok(Array.isArray(diffDefinition));
  assert.equal(diffDefinition.length, 3);
  const [method, description, shape] = diffDefinition;
  assert.equal(method, "diff");
  assert.equal("browser_" + method, "browser_diff");
  assert.equal(typeof description, "string");
  assert.ok(description.length > 80);
  assert.match(description, /snapshotId/);
  assert.match(description, /No JavaScript/);
  assert.equal(typeof shape, "object");
  assert.ok(shape.tabId);
  for (const forbidden of ["expression", "script", "code", "evaluate"]) {
    assert.equal(Object.hasOwn(shape, forbidden), false);
  }

  const schema = z.strictObject(shape);
  assert.deepEqual(schema.parse({ tabId: 1, text: true, maxTextChunks: 5 }), {
    tabId: 1,
    text: true,
    maxTextChunks: 5,
  });

  const valid = schema.safeParse({
    tabId: 1,
    snapshotId: "diff_abc",
    maxChars: 1000,
    maxTextChunks: 10,
    maxElementChanges: 10,
    maxDiffChars: 5000,
  });
  assert.equal(valid.success, true);

  const withBaseline = schema.safeParse({
    tabId: 1,
    baseline: {
      url: "https://example.test/",
      title: "T",
      text: "x",
      elements: [{ selector: "#a", tag: "button", role: "button", name: "A", type: "", value: "v" }],
      truncated: false,
    },
  });
  assert.equal(withBaseline.success, true);

  assert.equal(schema.safeParse({ tabId: 0 }).success, false);
  assert.equal(schema.safeParse({ tabId: 1.5 }).success, false);
  assert.equal(schema.safeParse({ tabId: 1, expression: "alert(1)" }).success, false);
  assert.equal(schema.safeParse({ tabId: 1, script: "alert(1)" }).success, false);
  assert.equal(schema.safeParse({ tabId: 1, maxChars: 200000 }).success, false);
  assert.equal(schema.safeParse({ tabId: 1, maxDiffChars: 100 }).success, false);
  assert.equal(schema.safeParse({ tabId: 1, snapshotId: "" }).success, false);
  assert.equal(schema.safeParse({ tabId: 1, baseline: { text: 5 } }).success, false);
  assert.equal(schema.safeParse({ tabId: 1, baseline: { extra: true } }).success, false);
  assert.equal(schema.safeParse({ tabId: 1, baseline: { elements: [{ selector: "" }] } }).success, false);
  assert.equal(
    schema.safeParse({
      tabId: 1,
      baseline: {
        elements: Array.from({ length: 301 }, (_, index) => ({ selector: "#e" + index })),
      },
    }).success,
    false,
  );

  const json = z.toJSONSchema(schema);
  assert.equal(json.type, "object");
  assert.equal(json.properties.tabId.type, "integer");
  assert.deepEqual(Object.keys(json.properties).sort(), [
    "baseline",
    "elements",
    "maxChars",
    "maxDiffChars",
    "maxElementChanges",
    "maxTextChunks",
    "snapshotId",
    "tabId",
    "text",
  ]);
});
