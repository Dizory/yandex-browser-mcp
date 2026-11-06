// Reference-snapshot diffs for one tab's visible text and actionable elements.
//
// Baselines are kept in this service worker's memory only: they hold user page
// data, so nothing is written to disk. Each baseline is an immutable capture
// bound to the tab that produced it, expires, and is evicted when the store
// passes its caps. A caller that wants no shared state at all passes its own
// capture as `baseline` and never depends on the store.
//
// The handler intentionally accepts no JavaScript: diff only compares captures
// that the extension produced itself (or a caller-supplied snapshot-shaped
// object).

import {
  asObject,
  normalizeBoolean,
  normalizeMaxChars,
  requireTabId,
} from "./validate.js";

const DEFAULT_MAX_TEXT_CHUNKS = 40;
const MAX_TEXT_CHUNKS = 200;
const DEFAULT_MAX_ELEMENT_CHANGES = 40;
const MAX_ELEMENT_CHANGES = 300;
const DEFAULT_MAX_DIFF_CHARS = 12000;
const MIN_DIFF_CHARS = 500;
const MAX_DIFF_CHARS = 40000;

const MAX_CHUNK_CHARS = 400;
const MAX_CAPTURE_CHUNKS = 4000;
const MAX_CAPTURE_TEXT_CHARS = 50000;
const MAX_CAPTURE_ELEMENTS = 300;
const MAX_ELEMENT_NAME = 200;
const MAX_ELEMENT_VALUE = 300;
const MAX_ELEMENT_FIELD = 100;
const MAX_SELECTOR_LENGTH = 10000;
const MAX_URL_LENGTH = 20000;
const MAX_TITLE_LENGTH = 2000;
const MAX_BASELINE_TEXT_CHARS = 100000;
const MAX_SNAPSHOT_ID_LENGTH = 200;

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BASELINES = 24;
const DEFAULT_MAX_BASELINES_PER_TAB = 3;
const DEFAULT_MAX_STORE_SIZE = 2 * 1024 * 1024;
const MIN_STORE_SIZE = 256 * 1024;
const MAX_STORE_SIZE = 16 * 1024 * 1024;

function errorText(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

function clampInteger(value, fallback, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeLimit(value, name, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error('Parameter "' + name + '" must be a finite number');
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

// A fragment-only change keeps the document; everything else is a navigation.
function documentKey(url) {
  if (typeof url !== "string" || url === "") return "";
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

// Splits normalized page text into comparable chunks. Long lines are cut at a
// word boundary so one huge paragraph cannot dominate the diff; the same rules
// are applied to both captures, so identical text always yields identical
// chunks.
function splitTextChunks(text) {
  const chunks = [];
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  for (const line of lines) {
    const collapsed = line.replace(/[ \t\f\v]+/g, " ").trim();
    if (collapsed === "") continue;
    let start = 0;
    while (start < collapsed.length) {
      let end = Math.min(collapsed.length, start + MAX_CHUNK_CHARS);
      if (end < collapsed.length) {
        const space = collapsed.lastIndexOf(" ", end);
        if (space > start) end = space;
      }
      const piece = collapsed.slice(start, end).trim();
      if (piece !== "") chunks.push(piece);
      start = end;
      while (start < collapsed.length && collapsed.charAt(start) === " ") start += 1;
    }
  }
  return chunks;
}

function capChunks(chunks) {
  const kept = [];
  let chars = 0;
  let clipped = false;
  for (const chunk of chunks) {
    if (kept.length >= MAX_CAPTURE_CHUNKS || chars + chunk.length > MAX_CAPTURE_TEXT_CHARS) {
      clipped = true;
      break;
    }
    kept.push(chunk);
    chars += chunk.length;
  }
  return { chunks: kept, clipped };
}

function countOccurrences(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function createCharBudget(limit) {
  let remaining = limit;
  return {
    take(text) {
      const length = typeof text === "string" ? text.length : 0;
      if (length > remaining) return false;
      remaining -= length;
      return true;
    },
  };
}

function normalizeElement(raw, partial) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const selector = typeof raw.selector === "string" ? raw.selector.trim() : "";
  if (selector === "" || selector.length > MAX_SELECTOR_LENGTH) return null;
  const element = { selector };
  // A partial element (from a caller-supplied baseline) keeps only the fields
  // it actually carries, so unknown fields are not reported as changed.
  const field = (name) => {
    if (typeof raw[name] !== "string") return;
    element[name] = raw[name].slice(0, MAX_ELEMENT_FIELD);
  };
  if (partial) {
    field("tag");
    field("role");
    field("type");
    if (typeof raw.name === "string") element.name = raw.name.slice(0, MAX_ELEMENT_NAME);
  } else {
    element.tag = typeof raw.tag === "string" ? raw.tag.slice(0, MAX_ELEMENT_FIELD) : "";
    element.role = typeof raw.role === "string" ? raw.role.slice(0, MAX_ELEMENT_FIELD) : "";
    element.name = typeof raw.name === "string" ? raw.name.slice(0, MAX_ELEMENT_NAME) : "";
    element.type = typeof raw.type === "string" ? raw.type.slice(0, MAX_ELEMENT_FIELD) : "";
  }
  // Defense in depth: secrets never reach a baseline, even from a malformed
  // payload. commands.snapshot already drops these values.
  const secretType = element.type === "password" || element.type === "hidden" || element.type === "file";
  if (!secretType && typeof raw.value === "string" && raw.value !== "") {
    element.value = raw.value.slice(0, MAX_ELEMENT_VALUE);
  }
  return element;
}

// Keeps document order, drops duplicate selectors (they cannot both be the same
// actionable target), and reports entries lost to the element cap.
function normalizeElements(list, maxElements, partial) {
  const elements = [];
  const seen = new Set();
  let clipped = false;
  if (!Array.isArray(list)) return { elements, clipped };
  for (const raw of list) {
    if (elements.length >= maxElements) {
      clipped = true;
      break;
    }
    const element = normalizeElement(raw, partial);
    if (!element) continue;
    if (seen.has(element.selector)) continue;
    seen.add(element.selector);
    elements.push(element);
  }
  return { elements, clipped };
}

function freezeElements(elements) {
  for (const element of elements) Object.freeze(element);
  return Object.freeze(elements);
}

function normalizeCapture(raw, tab) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Snapshot returned no data");
  }
  const tabUrl = tab && typeof tab.url === "string" ? tab.url : "";
  const rawUrl = typeof raw.url === "string" ? raw.url : "";
  const url = (rawUrl !== "" ? rawUrl : tabUrl).slice(0, MAX_URL_LENGTH);
  const title = typeof raw.title === "string" ? raw.title.slice(0, MAX_TITLE_LENGTH) : "";
  const text = typeof raw.text === "string" ? raw.text : "";
  const elementPart = normalizeElements(raw.elements, MAX_CAPTURE_ELEMENTS, false);
  const textPart = capChunks(splitTextChunks(text));
  return {
    url,
    title,
    documentKey: documentKey(url),
    documentTime: raw.documentTime,
    urlKnown: url !== "",
    textChunks: Object.freeze(textPart.chunks),
    elements: freezeElements(elementPart.elements),
    hasText: true,
    hasElements: true,
    clipped: raw.truncated === true || textPart.clipped || elementPart.clipped,
    capturedAt: null,
  };
}

// A caller-supplied baseline is a snapshot-shaped object (the result of
// browser_snapshot). Absent fields mean "not captured", not "empty": that keeps
// a text-only baseline from reporting every element as added.
function normalizeProvidedBaseline(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('Parameter "baseline" must be a snapshot-like object');
  }
  const url = typeof value.url === "string" ? value.url.slice(0, MAX_URL_LENGTH) : "";
  const title = typeof value.title === "string" ? value.title.slice(0, MAX_TITLE_LENGTH) : "";
  const hasText = typeof value.text === "string";
  const hasElements = Array.isArray(value.elements);
  let text = hasText ? value.text : "";
  let textTruncated = value.truncated === true;
  if (text.length > MAX_BASELINE_TEXT_CHARS) {
    text = text.slice(0, MAX_BASELINE_TEXT_CHARS);
    textTruncated = true;
  }
  const textPart = hasText ? capChunks(splitTextChunks(text)) : { chunks: [], clipped: false };
  const elementPart = hasElements
    ? normalizeElements(value.elements, MAX_CAPTURE_ELEMENTS, true)
    : { elements: [], clipped: false };
  return {
    url,
    title,
    documentKey: documentKey(url),
    documentTime: value.documentTime,
    urlKnown: url !== "",
    textChunks: Object.freeze(textPart.chunks),
    elements: freezeElements(elementPart.elements),
    hasText,
    hasElements,
    clipped: textTruncated || textPart.clipped || elementPart.clipped,
    capturedAt: null,
  };
}

// Count-based diff: a chunk repeated in both captures is not a change, and a
// chunk that merely moves is ignored. Surplus occurrences are reported, so
// duplicates are handled without greedy first-match mistakes.
function collectSurplus(chunks, otherCounts, limit, budget) {
  const remaining = new Map(otherCounts);
  const values = [];
  for (const chunk of chunks) {
    const matched = remaining.get(chunk) || 0;
    if (matched > 0) {
      remaining.set(chunk, matched - 1);
      continue;
    }
    if (values.length >= limit) continue;
    if (!budget.take(chunk)) continue;
    values.push(chunk);
  }
  return values;
}

function diffTextChunks(baselineChunks, currentChunks, limit, budget) {
  const baselineCounts = countOccurrences(baselineChunks);
  const currentCounts = countOccurrences(currentChunks);
  let addedCount = 0;
  let removedCount = 0;
  for (const [chunk, count] of currentCounts) {
    const surplus = count - (baselineCounts.get(chunk) || 0);
    if (surplus > 0) addedCount += surplus;
  }
  for (const [chunk, count] of baselineCounts) {
    const surplus = count - (currentCounts.get(chunk) || 0);
    if (surplus > 0) removedCount += surplus;
  }
  const added = collectSurplus(currentChunks, baselineCounts, limit, budget);
  const removed = collectSurplus(baselineChunks, currentCounts, limit, budget);
  return {
    added,
    removed,
    addedCount,
    removedCount,
    truncated: added.length < addedCount || removed.length < removedCount,
  };
}

function elementSummary(element) {
  return {
    selector: element.selector,
    tag: typeof element.tag === "string" ? element.tag : "",
    role: typeof element.role === "string" ? element.role : "",
    name: typeof element.name === "string" ? element.name : "",
    type: typeof element.type === "string" ? element.type : "",
  };
}

function compareElementField(before, after, field, baselinePartial) {
  const left = typeof before[field] === "string" ? before[field] : undefined;
  const right = typeof after[field] === "string" ? after[field] : undefined;
  if (baselinePartial) {
    // A caller-supplied baseline may omit fields; unknown is not a change.
    if (left === undefined) return null;
    const wanted = right === undefined ? "" : right;
    return left === wanted ? null : { before: left, after: wanted };
  }
  const reference = left === undefined ? "" : left;
  const current = right === undefined ? "" : right;
  return reference === current ? null : { before: reference, after: current };
}

function elementChanges(before, after, baselinePartial) {
  const changes = [];
  for (const field of ["name", "role", "type", "tag"]) {
    const change = compareElementField(before, after, field, baselinePartial);
    if (change) changes.push({ field, ...change });
  }
  const beforeValue =
    typeof before.value === "string" ? before.value : baselinePartial ? undefined : null;
  const afterValue = typeof after.value === "string" ? after.value : null;
  if (beforeValue !== undefined && beforeValue !== afterValue) {
    changes.push({ field: "value", before: beforeValue, after: afterValue });
  }
  return changes;
}

// Elements are matched by selector, the only stable handle a snapshot gives.
// Added/removed entries carry the actionable summary; changed entries carry
// only the fields that differ so output stays bounded.
function diffElements(baselineElements, currentElements, limit, budget, baselinePartial) {
  const baselineBySelector = new Map();
  for (const element of baselineElements) {
    if (!baselineBySelector.has(element.selector)) baselineBySelector.set(element.selector, element);
  }
  const currentBySelector = new Map();
  for (const element of currentElements) {
    if (!currentBySelector.has(element.selector)) currentBySelector.set(element.selector, element);
  }

  const added = [];
  let addedCount = 0;
  for (const element of currentElements) {
    if (baselineBySelector.has(element.selector)) continue;
    addedCount += 1;
    if (added.length >= limit) continue;
    const summary = elementSummary(element);
    if (!budget.take(JSON.stringify(summary))) continue;
    added.push(summary);
  }

  const removed = [];
  let removedCount = 0;
  for (const element of baselineElements) {
    if (currentBySelector.has(element.selector)) continue;
    removedCount += 1;
    if (removed.length >= limit) continue;
    const summary = elementSummary(element);
    if (!budget.take(JSON.stringify(summary))) continue;
    removed.push(summary);
  }

  const changed = [];
  let changedCount = 0;
  let unchangedCount = 0;
  for (const element of currentElements) {
    const before = baselineBySelector.get(element.selector);
    if (!before) continue;
    const changes = elementChanges(before, element, baselinePartial);
    if (changes.length === 0) {
      unchangedCount += 1;
      continue;
    }
    changedCount += 1;
    if (changed.length >= limit) continue;
    const entry = { selector: element.selector, changes };
    if (!budget.take(JSON.stringify(entry))) continue;
    changed.push(entry);
  }

  return {
    added,
    removed,
    changed,
    addedCount,
    removedCount,
    changedCount,
    unchangedCount,
    truncated:
      added.length < addedCount || removed.length < removedCount || changed.length < changedCount,
  };
}

function unavailableSection(reason) {
  return {
    available: false,
    reason,
    added: [],
    removed: [],
    addedCount: 0,
    removedCount: 0,
    truncated: false,
    clipped: false,
  };
}

function unavailableElementSection(reason) {
  return {
    ...unavailableSection(reason),
    changed: [],
    changedCount: 0,
    unchangedCount: 0,
  };
}

/**
 * Creates the `diff` bridge command.
 *
 * @param {{
 *   snapshot: (params: {tabId: number, maxChars: number}) => Promise<object>,
 *   chromeApi: {tabs: {get: Function}},
 *   session?: {exclusive: Function},
 *   serializeCapture?: boolean,
 *   now?: () => number,
 *   ttlMs?: number,
 *   maxBaselines?: number,
 *   maxBaselinesPerTab?: number,
 *   maxStoreSize?: number,
 * }} options
 * @returns {(params: object) => Promise<object>} async handler
 */
export function createDiffTool({
  snapshot,
  chromeApi,
  session,
  serializeCapture = false,
  now = () => Date.now(),
  ttlMs,
  maxBaselines,
  maxBaselinesPerTab,
  maxStoreSize,
} = {}) {
  if (typeof snapshot !== "function") {
    throw new Error("createDiffTool requires a snapshot function");
  }
  if (!chromeApi || !chromeApi.tabs) {
    throw new Error("createDiffTool requires chromeApi.tabs");
  }
  // `commands.snapshot` already serializes per tab; wrapping it again would
  // deadlock the tab queue. Raw capture helpers must opt in.
  if (serializeCapture && (!session || typeof session.exclusive !== "function")) {
    throw new Error("serializeCapture requires a debugger session with exclusive()");
  }

  const clock = typeof now === "function" ? now : () => Date.now();
  const ttl = clampInteger(ttlMs, DEFAULT_TTL_MS, 1, MAX_TTL_MS);
  const baselineLimit = clampInteger(maxBaselines, DEFAULT_MAX_BASELINES, 1, 256);
  const perTabLimit = clampInteger(
    maxBaselinesPerTab,
    DEFAULT_MAX_BASELINES_PER_TAB,
    1,
    baselineLimit,
  );
  const storeLimit = clampInteger(maxStoreSize, DEFAULT_MAX_STORE_SIZE, MIN_STORE_SIZE, MAX_STORE_SIZE);

  const baselines = new Map();
  let baselineBytes = 0;
  let sequence = 0;
  let usageSequence = 0;

  // Strictly monotonic recency, independent of clock granularity, so eviction
  // never depends on two operations sharing a timestamp.
  function nextUsage() {
    usageSequence += 1;
    return usageSequence;
  }

  function removeBaseline(id) {
    const entry = baselines.get(id);
    if (!entry) return;
    baselines.delete(id);
    baselineBytes -= entry.size;
  }

  function purgeExpired() {
    const at = clock();
    for (const [id, entry] of Array.from(baselines)) {
      if (entry.expiresAt <= at) removeBaseline(id);
    }
  }

  function leastRecentlyUsed() {
    let victim = null;
    for (const entry of baselines.values()) {
      if (
        !victim ||
        entry.usedAt < victim.usedAt ||
        (entry.usedAt === victim.usedAt && entry.capturedAt < victim.capturedAt)
      ) {
        victim = entry;
      }
    }
    return victim;
  }

  function createSnapshotId() {
    sequence += 1;
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
      return "diff_" + cryptoApi.randomUUID();
    }
    return (
      "diff_" +
      clock().toString(36) +
      "_" +
      sequence.toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 10)
    );
  }

  function estimateCaptureSize(capture) {
    try {
      return JSON.stringify({ text: capture.textChunks, elements: capture.elements }).length;
    } catch (error) {
      return storeLimit + 1;
    }
  }

  // Returns the stored entry, or null when the capture alone exceeds the store
  // cap (the diff is still returned; only the reusable id is unavailable).
  function storeCapture(tabId, capture) {
    purgeExpired();
    const size = estimateCaptureSize(capture);
    if (size > storeLimit) return null;
    const sameTab = [];
    for (const entry of baselines.values()) {
      if (entry.tabId === tabId) sameTab.push(entry);
    }
    sameTab.sort(
      (left, right) => left.usedAt - right.usedAt || left.capturedAt - right.capturedAt,
    );
    while (sameTab.length >= perTabLimit) removeBaseline(sameTab.shift().id);
    const id = createSnapshotId();
    const entry = {
      id,
      tabId,
      url: capture.url,
      title: capture.title,
      documentKey: capture.documentKey,
      documentTime: capture.documentTime,
      urlKnown: capture.urlKnown,
      textChunks: capture.textChunks,
      elements: capture.elements,
      hasText: true,
      hasElements: true,
      clipped: capture.clipped === true,
      capturedAt: capture.capturedAt,
      expiresAt: capture.capturedAt + ttl,
      usedAt: nextUsage(),
      size,
    };
    baselines.set(id, entry);
    baselineBytes += size;
    while (baselines.size > baselineLimit || baselineBytes > storeLimit) {
      const victim = leastRecentlyUsed();
      if (!victim) break;
      removeBaseline(victim.id);
    }
    return baselines.has(id) ? entry : null;
  }

  function findBaseline(id) {
    const entry = baselines.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= clock()) {
      removeBaseline(id);
      return null;
    }
    return entry;
  }

  async function readTab(tabId) {
    // Minimal embeddings may omit tabs.get; the capture itself then owns tab
    // access (commands.snapshot already validates the tab).
    if (typeof chromeApi.tabs.get !== "function") return null;
    try {
      return await chromeApi.tabs.get(tabId);
    } catch (error) {
      const message = errorText(error);
      if (/no tab with (given )?id/i.test(message)) {
        throw new Error("Tab " + tabId + " not found");
      }
      throw new Error("Cannot access tab " + tabId + ": " + message);
    }
  }

  async function captureTab(tabId, maxChars) {
    const run = () => snapshot({ tabId, maxChars });
    return serializeCapture ? session.exclusive(tabId, run) : run();
  }

  let listenerRegistered = false;
  try {
    const onRemoved = chromeApi.tabs.onRemoved;
    if (onRemoved && typeof onRemoved.addListener === "function") {
      onRemoved.addListener((closedTabId) => {
        if (!Number.isInteger(closedTabId)) return;
        for (const [id, entry] of Array.from(baselines)) {
          if (entry.tabId === closedTabId) removeBaseline(id);
        }
      });
      listenerRegistered = true;
    }
  } catch (error) {
    /* baselines still expire and are evicted without the listener */
  }

  /**
   * Compares the current tab with a reference capture.
   *
   * First call (no reference) captures the page and returns a `snapshotId`.
   * Later calls pass that id, or a self-contained `baseline` snapshot object.
   * Every call stores (subject to caps) and returns a new `snapshotId`.
   *
   * @param {object} params
   * @returns {Promise<object>}
   */
  async function diff(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const includeText = normalizeBoolean(p.text, "text", true);
    const includeElements = normalizeBoolean(p.elements, "elements", true);
    if (!includeText && !includeElements) {
      throw new Error('At least one of "text" or "elements" must be enabled');
    }
    const maxChars = normalizeMaxChars(p.maxChars);
    const maxTextChunks = normalizeLimit(
      p.maxTextChunks,
      "maxTextChunks",
      DEFAULT_MAX_TEXT_CHUNKS,
      1,
      MAX_TEXT_CHUNKS,
    );
    const maxElementChanges = normalizeLimit(
      p.maxElementChanges,
      "maxElementChanges",
      DEFAULT_MAX_ELEMENT_CHANGES,
      1,
      MAX_ELEMENT_CHANGES,
    );
    const maxDiffChars = normalizeLimit(
      p.maxDiffChars,
      "maxDiffChars",
      DEFAULT_MAX_DIFF_CHARS,
      MIN_DIFF_CHARS,
      MAX_DIFF_CHARS,
    );

    const hasSnapshotId = p.snapshotId !== undefined && p.snapshotId !== null;
    const hasProvidedBaseline = p.baseline !== undefined && p.baseline !== null;
    if (hasSnapshotId && hasProvidedBaseline) {
      throw new Error('Provide either "snapshotId" or "baseline", not both');
    }

    let snapshotId = null;
    if (hasSnapshotId) {
      if (typeof p.snapshotId !== "string") {
        throw new Error('Parameter "snapshotId" must be a string');
      }
      snapshotId = p.snapshotId.trim();
      if (snapshotId === "" || snapshotId.length > MAX_SNAPSHOT_ID_LENGTH) {
        throw new Error(
          'Parameter "snapshotId" must contain 1 to ' + MAX_SNAPSHOT_ID_LENGTH + " characters",
        );
      }
    }

    const providedBaseline = hasProvidedBaseline
      ? normalizeProvidedBaseline(p.baseline)
      : null;

    // Resolve the reference before touching the page so an expired or
    // foreign reference never costs a capture.
    let baselineCapture = null;
    let storedEntry = null;
    if (snapshotId !== null) {
      storedEntry = findBaseline(snapshotId);
      if (!storedEntry) {
        throw new Error(
          'Reference snapshot "' +
            snapshotId +
            '" is unknown or expired. Baselines live in memory for up to ' +
            Math.round(ttl / 60000) +
            ' minutes and are evicted when the store is full; call browser_diff without "snapshotId" to take a new baseline.',
        );
      }
      if (storedEntry.tabId !== tabId) {
        throw new Error(
          'Reference snapshot "' +
            snapshotId +
            '" was taken from tab ' +
            storedEntry.tabId +
            ' and must not be compared with tab ' +
            tabId +
            '. Diffs never mix tabs; take a baseline on tab ' +
            tabId +
            ".",
        );
      }
      baselineCapture = storedEntry;
      storedEntry.usedAt = nextUsage();
    } else if (providedBaseline) {
      baselineCapture = providedBaseline;
    }

    const tab = await readTab(tabId);
    const raw = await captureTab(tabId, maxChars);
    const current = normalizeCapture(raw, tab);
    current.capturedAt = clock();

    const stored = storeCapture(tabId, current);

    const compared = baselineCapture !== null;
    const documentVerified = compared && baselineCapture.urlKnown === true;
    const navigated = documentVerified
      ? baselineCapture.documentKey !== current.documentKey ||
        (Number.isFinite(current.documentTime) && Number.isFinite(baselineCapture.documentTime) &&
          current.documentTime !== baselineCapture.documentTime)
      : null;
    const clippedBaseline = compared ? baselineCapture.clipped === true : false;
    const clippedCurrent = current.clipped === true;
    const budget = createCharBudget(maxDiffChars);

    let textSection;
    if (!includeText) {
      textSection = unavailableSection("disabled");
    } else if (!compared) {
      textSection = unavailableSection("no-baseline");
    } else if (!baselineCapture.hasText) {
      textSection = unavailableSection("baseline-has-no-text");
    } else {
      const textDiff = diffTextChunks(
        baselineCapture.textChunks,
        current.textChunks,
        maxTextChunks,
        budget,
      );
      textSection = {
        available: true,
        ...textDiff,
        clipped: clippedBaseline || clippedCurrent,
      };
    }

    let elementsSection;
    if (!includeElements) {
      elementsSection = unavailableElementSection("disabled");
    } else if (!compared) {
      elementsSection = unavailableElementSection("no-baseline");
    } else if (!baselineCapture.hasElements) {
      elementsSection = unavailableElementSection("baseline-has-no-elements");
    } else {
      const elementDiff = diffElements(
        baselineCapture.elements,
        current.elements,
        maxElementChanges,
        budget,
        !storedEntry,
      );
      elementsSection = {
        available: true,
        ...elementDiff,
        clipped: clippedBaseline || clippedCurrent,
      };
    }

    const complete =
      compared &&
      documentVerified &&
      !navigated &&
      !clippedBaseline &&
      !clippedCurrent &&
      (!includeText || (textSection.available && !textSection.truncated)) &&
      (!includeElements || (elementsSection.available && !elementsSection.truncated));

    const baselineCapturedAt =
      compared && typeof baselineCapture.capturedAt === "number"
        ? baselineCapture.capturedAt
        : null;

    return {
      ok: true,
      tabId,
      snapshotId: stored ? stored.id : null,
      stored: stored !== null,
      reference: compared ? (storedEntry ? "snapshotId" : "provided") : "none",
      baselineSnapshotId: storedEntry ? storedEntry.id : null,
      compared,
      url: current.url,
      title: current.title,
      previousUrl: compared ? baselineCapture.url : null,
      previousTitle: compared ? baselineCapture.title : null,
      navigated,
      documentVerified,
      capturedAt: current.capturedAt,
      baselineCapturedAt,
      baselineAgeMs:
        baselineCapturedAt === null ? null : Math.max(0, current.capturedAt - baselineCapturedAt),
      baselineExpiresAt: storedEntry ? storedEntry.expiresAt : null,
      include: { text: includeText, elements: includeElements },
      text: textSection,
      elements: elementsSection,
      clipped: { baseline: clippedBaseline, current: clippedCurrent },
      complete,
      limits: {
        maxChars,
        maxTextChunks,
        maxElementChanges,
        maxDiffChars,
      },
    };
  }

  diff.stats = () => {
    purgeExpired();
    const tabs = new Set();
    for (const entry of baselines.values()) tabs.add(entry.tabId);
    return { baselines: baselines.size, tabs: tabs.size, bytes: baselineBytes, listener: listenerRegistered };
  };
  diff.reset = () => {
    baselines.clear();
    baselineBytes = 0;
  };

  return diff;
}
