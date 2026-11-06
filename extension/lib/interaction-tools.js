// Interaction commands that sit alongside ./commands.js: hover, drag, frame
// discovery, download tracking, file upload and tab history.
//
// The module is deliberately additive. `createInteractionTools` returns a
// handlers object shaped exactly like the one `createCommands` returns, so a
// caller can merge both maps into one dispatcher without touching this file.
// Every handler validates its own parameters, uses the injected page
// evaluation helper (or a small Runtime.evaluate fallback), serializes work
// per tab through the debugger session, and never retries a mutation.

import { buildPageExpression } from "./page.js";
import {
  asObject,
  requireTabId,
  normalizeSelector,
  normalizeCoordinate,
  normalizeBoolean,
} from "./validate.js";

const PAGE_LOAD_TIMEOUT_MS = 12000;

const DEFAULT_DRAG_STEPS = 5;
const MAX_DRAG_STEPS = 50;

const MAX_FRAMES = 500;
const MAX_FRAME_DEPTH = 50;

const DOWNLOAD_DEFAULT_TIMEOUT_MS = 15000;
const DOWNLOAD_MAX_TIMEOUT_MS = 25000;
const DOWNLOAD_POLL_MS = 100;
const DOWNLOAD_DEFAULT_LOOKBACK_MS = 30000;
const DOWNLOAD_MAX_LOOKBACK_MS = 600000;
const DOWNLOAD_SEARCH_LIMIT = 100;

const MAX_UPLOAD_FILES = 20;
const MAX_UPLOAD_PATH_LENGTH = 32768;

const HISTORY_ACTIONS = new Set(["back", "forward", "reload"]);

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const UNC_ABSOLUTE_PATH = /^\\\\[^\\/]+[\\/][^\\/]+/;
const POSIX_ABSOLUTE_PATH = /^\//;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

function abbreviate(value, limit = 120) {
  const text = String(value);
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

function exceptionMessage(details) {
  if (!details || typeof details !== "object") return "Page evaluation failed";
  const exception =
    details.exception && typeof details.exception === "object" ? details.exception : null;
  const raw =
    (exception && (exception.description || exception.value)) ||
    details.text ||
    "Page evaluation failed";
  return String(raw).slice(0, 2000);
}

function tabSummary(tab) {
  return {
    id: tab && typeof tab.id === "number" ? tab.id : null,
    windowId: tab && typeof tab.windowId === "number" ? tab.windowId : null,
    title: tab && typeof tab.title === "string" ? tab.title : "",
    url: tab && typeof tab.url === "string" ? tab.url : "",
    active: !!(tab && tab.active === true),
    status: tab && typeof tab.status === "string" ? tab.status : "unknown",
  };
}

/**
 * Small page evaluation fallback used when the caller does not inject one.
 * It mirrors the private helper inside ./commands.js.
 *
 * @param {import("./debugger.js").DebuggerSession} session
 */
function createPageEval(session) {
  return async function evaluate(tabId, action, payload) {
    const response = await session.send(tabId, "Runtime.evaluate", {
      expression: buildPageExpression(action, payload),
      returnByValue: true,
      awaitPromise: false,
      userGesture: false,
    });
    if (response && response.exceptionDetails) {
      throw new Error(exceptionMessage(response.exceptionDetails));
    }
    if (!response || !response.result) return undefined;
    return response.result.value;
  };
}

function normalizeTarget(params, actionName) {
  const hasSelector = params.selector !== undefined && params.selector !== null;
  const hasX = params.x !== undefined && params.x !== null;
  const hasY = params.y !== undefined && params.y !== null;
  if (hasSelector && (hasX || hasY)) {
    throw new Error(
      actionName + " accepts either a selector or x/y viewport coordinates, not both",
    );
  }
  if (hasSelector) return { selector: normalizeSelector(params.selector) };
  if (!hasX && !hasY) {
    throw new Error(
      actionName + ' requires a "selector" or viewport coordinates "x" and "y"',
    );
  }
  if (!hasX || !hasY) {
    throw new Error(actionName + ' requires both "x" and "y" viewport coordinates');
  }
  return { x: normalizeCoordinate(params.x, "x"), y: normalizeCoordinate(params.y, "y") };
}

function normalizePoint(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('drag requires "' + name + '" as {selector} or {x,y}');
  }
  const hasSelector = value.selector !== undefined && value.selector !== null;
  const hasX = value.x !== undefined && value.x !== null;
  const hasY = value.y !== undefined && value.y !== null;
  if (hasSelector && (hasX || hasY)) {
    throw new Error('drag "' + name + '" must use either selector or x/y, not both');
  }
  if (hasSelector) return { selector: normalizeSelector(value.selector) };
  if (!hasX || !hasY) {
    throw new Error('drag "' + name + '" requires a selector or both x and y');
  }
  return {
    x: normalizeCoordinate(value.x, name + ".x"),
    y: normalizeCoordinate(value.y, name + ".y"),
  };
}

function normalizeDragSteps(value) {
  if (value === undefined || value === null) return DEFAULT_DRAG_STEPS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_DRAG_STEPS) {
    throw new Error('Parameter "steps" must be an integer between 1 and ' + MAX_DRAG_STEPS);
  }
  return value;
}

function assertInsideViewport(x, y, viewport, actionName) {
  if (!viewport || typeof viewport !== "object") return;
  const width = viewport.width;
  const height = viewport.height;
  if (typeof width !== "number" || typeof height !== "number") return;
  if (x < 0 || y < 0 || x > width || y > height) {
    throw new Error(
      actionName +
        " coordinates (" +
        x +
        ", " +
        y +
        ") are outside the viewport " +
        width +
        "x" +
        height,
    );
  }
}

function attributeMap(rawAttributes) {
  const map = new Map();
  if (!Array.isArray(rawAttributes)) return map;
  for (let index = 0; index + 1 < rawAttributes.length; index += 2) {
    const name = String(rawAttributes[index]).toLowerCase();
    if (!map.has(name)) map.set(name, String(rawAttributes[index + 1]));
  }
  return map;
}

function isAbsoluteFilePath(value) {
  return (
    WINDOWS_ABSOLUTE_PATH.test(value) ||
    UNC_ABSOLUTE_PATH.test(value) ||
    POSIX_ABSOLUTE_PATH.test(value)
  );
}

function normalizeUploadPaths(value) {
  if (!Array.isArray(value)) {
    throw new Error('Parameter "paths" must be an array of absolute file paths');
  }
  if (value.length === 0) {
    throw new Error('Parameter "paths" must contain at least one absolute path');
  }
  if (value.length > MAX_UPLOAD_FILES) {
    throw new Error('Parameter "paths" must contain at most ' + MAX_UPLOAD_FILES + " paths");
  }
  const paths = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error('Parameter "paths" must be an array of absolute file paths');
    }
    if (entry === "") throw new Error('Parameter "paths" must not contain empty paths');
    if (entry.length > MAX_UPLOAD_PATH_LENGTH) {
      throw new Error('Parameter "paths" contains a path that is too long');
    }
    if (entry.includes("\u0000")) {
      throw new Error('Parameter "paths" contains a path with invalid characters');
    }
    if (!isAbsoluteFilePath(entry)) {
      throw new Error(
        'Parameter "paths" must contain explicit absolute paths, got "' + abbreviate(entry) + '"',
      );
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    paths.push(entry);
  }
  return paths;
}

function normalizeOptionalSubstring(value, name, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error('Parameter "' + name + '" must be a string');
  const trimmed = value.trim();
  if (trimmed === "") throw new Error('Parameter "' + name + '" must not be empty');
  if (trimmed.length > maxLength) throw new Error('Parameter "' + name + '" is too long');
  if (trimmed.includes("\u0000")) {
    throw new Error('Parameter "' + name + '" contains invalid characters');
  }
  return trimmed;
}

function normalizeOptionalDownloadId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error('Parameter "downloadId" must be a positive integer');
  }
  return value;
}

function normalizeBoundedInteger(value, name, defaultValue, min, max) {
  if (value === undefined || value === null) return defaultValue;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      'Parameter "' + name + '" must be an integer between ' + min + " and " + max,
    );
  }
  return value;
}

function normalizeHistoryAction(value) {
  if (typeof value !== "string") {
    throw new Error('Parameter "action" must be "back", "forward" or "reload"');
  }
  const action = value.trim().toLowerCase();
  if (!HISTORY_ACTIONS.has(action)) {
    throw new Error('Parameter "action" must be "back", "forward" or "reload"');
  }
  return action;
}

function isTerminalDownload(item) {
  return item.state === "complete" || item.state === "interrupted";
}

function matchesDownloadFilters(item, filters) {
  if (!item || typeof item !== "object" || typeof item.id !== "number") return false;
  if (filters.filenameContains !== null) {
    const filename = typeof item.filename === "string" ? item.filename.toLowerCase() : "";
    if (!filename.includes(filters.filenameContains)) return false;
  }
  if (filters.urlContains !== null) {
    const urls = [];
    if (typeof item.url === "string") urls.push(item.url.toLowerCase());
    if (typeof item.finalUrl === "string") urls.push(item.finalUrl.toLowerCase());
    if (!urls.some((value) => value.includes(filters.urlContains))) return false;
  }
  if (filters.since !== null) {
    const startTime = Date.parse(item.startTime);
    // An unparseable startTime is kept rather than silently hidden; the time
    // window is a convenience filter, not a security boundary.
    if (Number.isFinite(startTime) && startTime < filters.since) return false;
  }
  return true;
}

function downloadSortKey(item) {
  const startTime = Date.parse(item.startTime);
  return Number.isFinite(startTime) ? startTime : 0;
}

function formatDownload(item, extra = {}) {
  const result = {
    id: typeof item.id === "number" ? item.id : null,
    filename: typeof item.filename === "string" ? item.filename : "",
    url: typeof item.url === "string" ? item.url : "",
    state: typeof item.state === "string" ? item.state : "unknown",
    error: typeof item.error === "string" && item.error !== "" ? item.error : null,
  };
  if (typeof item.finalUrl === "string" && item.finalUrl !== "") result.finalUrl = item.finalUrl;
  if (typeof item.bytesReceived === "number" && Number.isFinite(item.bytesReceived)) {
    result.bytesReceived = item.bytesReceived;
  }
  if (typeof item.totalBytes === "number" && Number.isFinite(item.totalBytes)) {
    result.totalBytes = item.totalBytes;
  }
  if (typeof item.exists === "boolean") result.exists = item.exists;
  return Object.assign(result, extra);
}

function downloadsFrom(searchResult) {
  if (!Array.isArray(searchResult)) return [];
  return searchResult.filter((item) => item && typeof item === "object");
}

function multipleDownloadsError(items) {
  const sample = items
    .slice(0, 5)
    .map((item) => "#" + item.id + " " + abbreviate(item.filename || item.url || "", 80))
    .join(", ");
  return new Error(
    "Multiple recent downloads match; pass downloadId or narrow filenameContains/urlContains: " +
      sample,
  );
}

function historyNavigationError(action, error) {
  const message = errorText(error);
  if (/cannot go back/i.test(message)) {
    return new Error("Cannot go back: no previous history entry in this tab");
  }
  if (/cannot go forward/i.test(message)) {
    return new Error("Cannot go forward: no next history entry in this tab");
  }
  return new Error("Cannot go " + action + ": " + message);
}

/**
 * Builds the interaction handlers.
 *
 * @param {{
 *   chromeApi: typeof chrome,
 *   session: import("./debugger.js").DebuggerSession,
 *   pageEval?: (tabId: number, action: string, payload: object) => Promise<any>,
 * }} options
 */
export function createInteractionTools({ chromeApi, session, pageEval } = {}) {
  if (!chromeApi || typeof chromeApi !== "object") {
    throw new Error("createInteractionTools requires chromeApi");
  }
  if (
    !session ||
    typeof session.send !== "function" ||
    typeof session.exclusive !== "function"
  ) {
    throw new Error("createInteractionTools requires a debugger session");
  }
  const evaluatePage = typeof pageEval === "function" ? pageEval : createPageEval(session);

  async function getTab(tabId) {
    if (!chromeApi.tabs || typeof chromeApi.tabs.get !== "function") {
      throw new Error("Tabs API is unavailable");
    }
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

  async function requireTab(tabId) {
    await getTab(tabId);
  }

  async function waitForTabReady(tabId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    for (;;) {
      try {
        latest = await chromeApi.tabs.get(tabId);
      } catch (error) {
        return null;
      }
      if (latest && latest.status === "complete") return latest;
      if (Date.now() >= deadline) return latest;
      await sleep(Math.min(200, Math.max(10, deadline - Date.now())));
    }
  }

  async function resolveCoordinates(tabId, target, actionName, scroll = true) {
    if (target.selector) {
      const located = await evaluatePage(tabId, "locate", { selector: target.selector, ...(scroll ? {} : { scroll: false }) });
      if (!located || located.ok !== true) {
        throw new Error(
          "Cannot " + actionName + ": " + ((located && located.error) || "selector not found"),
        );
      }
      return { x: located.x, y: located.y };
    }
    const viewport = await evaluatePage(tabId, "viewport", {});
    assertInsideViewport(target.x, target.y, viewport, actionName);
    return { x: target.x, y: target.y };
  }

  async function releaseMouse(tabId, point) {
    try {
      await session.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    } catch (error) {
      /* the button may already be released, or the tab may be gone */
    }
  }

  async function hover(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const target = normalizeTarget(p, "hover");
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      const point = await resolveCoordinates(tabId, target, "hover");
      await session.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "none",
        buttons: 0,
      });
      return { hovered: true };
    });
  }

  async function drag(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const from = normalizePoint(p.from, "from");
    const to = normalizePoint(p.to, "to");
    const steps = normalizeDragSteps(p.steps);
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      let start = await resolveCoordinates(tabId, from, "drag");
      const end = await resolveCoordinates(tabId, to, "drag");
      if (from.selector && to.selector) start = await resolveCoordinates(tabId, from, "drag", false);
      let pressAttempted = false;
      let current = start;
      try {
        await session.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: start.x,
          y: start.y,
          button: "none",
          buttons: 0,
        });
        pressAttempted = true;
        await session.send(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: start.x,
          y: start.y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        for (let step = 1; step <= steps; step += 1) {
          const ratio = step / steps;
          current = {
            x: start.x + (end.x - start.x) * ratio,
            y: start.y + (end.y - start.y) * ratio,
          };
          await session.send(tabId, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: current.x,
            y: current.y,
            button: "left",
            buttons: 1,
          });
        }
        await session.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: end.x,
          y: end.y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
        pressAttempted = false;
      } catch (error) {
        if (pressAttempted) await releaseMouse(tabId, current);
        throw error;
      }
      return { dragged: true };
    });
  }

  async function frames(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      const response = await session.send(tabId, "Page.getFrameTree", {});
      const root = response && response.frameTree ? response.frameTree : null;
      if (!root || !root.frame || typeof root.frame.id !== "string" || root.frame.id === "") {
        throw new Error("Page.getFrameTree returned no frame tree");
      }
      const list = [];
      const seen = new Set();
      let truncated = false;
      const walk = (frameTree, parentFrameId, depth) => {
        if (truncated || !frameTree || !frameTree.frame) return;
        if (list.length >= MAX_FRAMES || depth > MAX_FRAME_DEPTH) {
          truncated = true;
          return;
        }
        const frame = frameTree.frame;
        const frameId = typeof frame.id === "string" ? frame.id : "";
        if (frameId === "" || seen.has(frameId)) return;
        seen.add(frameId);
        const entry = {
          frameId,
          parentFrameId: parentFrameId === null ? null : parentFrameId,
          url: typeof frame.url === "string" ? frame.url : "",
          name: typeof frame.name === "string" ? frame.name : "",
          securityOrigin:
            typeof frame.securityOrigin === "string" ? frame.securityOrigin : "",
          mimeType: typeof frame.mimeType === "string" ? frame.mimeType : "",
        };
        if (typeof frame.unreachableUrl === "string" && frame.unreachableUrl !== "") {
          entry.unreachableUrl = frame.unreachableUrl;
        }
        list.push(entry);
        const children = Array.isArray(frameTree.childFrames) ? frameTree.childFrames : [];
        for (const child of children) walk(child, frameId, depth + 1);
      };
      walk(root, null, 0);
      return { frames: list, truncated };
    });
  }

  async function waitDownload(params) {
    const p = asObject(params);
    const downloadId = normalizeOptionalDownloadId(p.downloadId);
    const filenameContains = normalizeOptionalSubstring(p.filenameContains, "filenameContains", 500);
    const urlContains = normalizeOptionalSubstring(p.urlContains, "urlContains", 2000);
    const timeoutMs = normalizeBoundedInteger(
      p.timeoutMs,
      "timeoutMs",
      DOWNLOAD_DEFAULT_TIMEOUT_MS,
      1,
      DOWNLOAD_MAX_TIMEOUT_MS,
    );
    const lookbackMs = normalizeBoundedInteger(
      p.lookbackMs,
      "lookbackMs",
      DOWNLOAD_DEFAULT_LOOKBACK_MS,
      0,
      DOWNLOAD_MAX_LOOKBACK_MS,
    );
    const downloads = chromeApi.downloads;
    if (!downloads || typeof downloads.search !== "function") {
      throw new Error(
        'Downloads API is unavailable: the extension needs the "downloads" permission',
      );
    }
    const filters = {
      filenameContains: filenameContains === null ? null : filenameContains.toLowerCase(),
      urlContains: urlContains === null ? null : urlContains.toLowerCase(),
      since: null,
    };

    async function search(query) {
      let result;
      try {
        result = await downloads.search(query);
      } catch (error) {
        throw new Error("Cannot read downloads: " + errorText(error));
      }
      return downloadsFrom(result);
    }

    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;

    if (downloadId !== null) {
      let latest = null;
      for (;;) {
        const items = await search({ id: downloadId });
        const item = items.find((entry) => entry.id === downloadId) || null;
        if (item) {
          if (!matchesDownloadFilters(item, filters)) {
            throw new Error(
              "Download " + downloadId + " does not match the filename/url filters",
            );
          }
          latest = item;
          if (isTerminalDownload(item)) return formatDownload(item);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(DOWNLOAD_POLL_MS, remaining));
      }
      if (latest) return formatDownload(latest, { timedOut: true });
      throw new Error(
        "Timed out after " + timeoutMs + " ms waiting for download " + downloadId,
      );
    }

    filters.since = startedAt - lookbackMs;
    const candidates = new Map();
    let latest = null;
    for (;;) {
      const items = await search({ limit: DOWNLOAD_SEARCH_LIMIT });
      for (const item of items) {
        if (typeof item.id !== "number") continue;
        if (!matchesDownloadFilters(item, filters)) continue;
        candidates.set(item.id, item);
      }
      if (candidates.size > 0) {
        const list = Array.from(candidates.values()).sort(
          (left, right) => downloadSortKey(right) - downloadSortKey(left),
        );
        if (list.length > 1) throw multipleDownloadsError(list);
        latest = list[0];
        if (isTerminalDownload(latest)) return formatDownload(latest);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(DOWNLOAD_POLL_MS, remaining));
    }
    if (latest) return formatDownload(latest, { timedOut: true });
    throw new Error("Timed out after " + timeoutMs + " ms waiting for a matching download");
  }

  async function uploadFile(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const selector =
      p.selector === undefined || p.selector === null
        ? 'input[type="file"]'
        : normalizeSelector(p.selector);
    const files = normalizeUploadPaths(p.paths);
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      const document = await session.send(tabId, "DOM.getDocument", {
        depth: -1,
        pierce: false,
      });
      const rootNodeId = document && document.root ? document.root.nodeId : null;
      if (!Number.isInteger(rootNodeId) || rootNodeId <= 0) {
        throw new Error("Cannot resolve the document root for file upload");
      }
      const matches = await session.send(tabId, "DOM.querySelectorAll", {
        nodeId: rootNodeId,
        selector,
      });
      const nodeIds =
        matches && Array.isArray(matches.nodeIds)
          ? matches.nodeIds.filter((nodeId) => Number.isInteger(nodeId) && nodeId > 0)
          : [];
      if (nodeIds.length === 0) {
        throw new Error('No element matches selector "' + selector + '"');
      }
      if (nodeIds.length > 1) {
        throw new Error(
          'Selector "' +
            selector +
            '" matches ' +
            nodeIds.length +
            " elements; expected exactly one file input",
        );
      }
      const nodeId = nodeIds[0];
      const described = await session.send(tabId, "DOM.describeNode", { nodeId, depth: 0 });
      const node = described && described.node;
      if (!node) throw new Error("Cannot inspect the selected element");
      const nodeName = typeof node.nodeName === "string" ? node.nodeName.toLowerCase() : "";
      if (nodeName !== "input") {
        throw new Error('The selected element is not an input (found "' + nodeName + '")');
      }
      let attributes = attributeMap(node.attributes);
      if (attributes.size === 0) {
        const raw = await session.send(tabId, "DOM.getAttributes", { nodeId });
        attributes = attributeMap(raw && raw.attributes);
      }
      if (String(attributes.get("type") || "").toLowerCase() !== "file") {
        throw new Error('The selected element is not a file input (type="file")');
      }
      if (attributes.has("disabled")) {
        throw new Error("The selected file input is disabled");
      }
      if (files.length > 1 && !attributes.has("multiple")) {
        throw new Error("This file input accepts only one file");
      }
      await session.send(tabId, "DOM.setFileInputFiles", { files, nodeId });
      return { uploaded: true, count: files.length, selector };
    });
  }

  async function history(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const action = normalizeHistoryAction(p.action);
    const bypassCache = normalizeBoolean(p.bypassCache, "bypassCache", false);
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      const tabsApi = chromeApi.tabs;
      if (action === "back" || action === "forward") {
        const method = action === "back" ? "goBack" : "goForward";
        if (typeof tabsApi[method] !== "function") {
          throw new Error("This browser does not support tabs." + method);
        }
        try {
          await tabsApi[method](tabId);
        } catch (error) {
          throw historyNavigationError(action, error);
        }
      } else {
        if (typeof tabsApi.reload !== "function") {
          throw new Error("This browser does not support tabs.reload");
        }
        try {
          await tabsApi.reload(tabId, { bypassCache });
        } catch (error) {
          throw new Error("Cannot reload tab " + tabId + ": " + errorText(error));
        }
      }
      const loaded = await waitForTabReady(tabId, PAGE_LOAD_TIMEOUT_MS);
      return { action, tab: tabSummary(loaded || (await getTab(tabId))) };
    });
  }

  return {
    hover,
    drag,
    frames,
    wait_download: waitDownload,
    upload_file: uploadFile,
    history,
  };
}
