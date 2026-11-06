// Bridge command handlers. Each command validates its own parameters, works on
// the user's existing tabs and returns protocol-shaped results.

import { buildPageExpression, SNAPSHOT_CANDIDATE_SELECTOR } from "./page.js";
import { createDomTools, domRuntime } from "./dom-tools.js";
import { createInteractionTools } from "./interaction-tools.js";
import { createDiffTool } from "./diff-tool.js";
import { MODIFIER_BITS, buildKeyEvents } from "./keys.js";
import {
  asObject,
  requireTabId,
  normalizeHttpUrl,
  normalizeMaxChars,
  normalizeSelector,
  normalizeButton,
  normalizeClickCount,
  normalizeCoordinate,
  normalizeModifiers,
  normalizeKey,
  normalizeDeltaX,
  normalizeDeltaY,
  normalizeText,
  normalizeBoolean,
  normalizeExpression,
  normalizeCdpMethod,
  normalizeCdpParams,
} from "./validate.js";

const MAX_SUMMARY_ELEMENTS = 300;
const MAX_ELEMENT_NAME = 200;
const MAX_ELEMENT_VALUE = 300;
const PAGE_LOAD_TIMEOUT_MS = 12000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

function exceptionMessage(details) {
  if (!details || typeof details !== "object") return "Page evaluation failed";
  const exception = details.exception && typeof details.exception === "object" ? details.exception : null;
  const raw =
    (exception && (exception.description || exception.value)) ||
    details.text ||
    "Page evaluation failed";
  return String(raw).slice(0, 2000);
}

function summaryElement(item) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.selector !== "string" || item.selector === "") return null;
  const summary = {
    selector: item.selector,
    tag: typeof item.tag === "string" ? item.tag : "",
    role: typeof item.role === "string" ? item.role : "",
    name: typeof item.name === "string" ? item.name.slice(0, MAX_ELEMENT_NAME) : "",
    type: typeof item.type === "string" ? item.type : "",
  };
  // Defense in depth: password/hidden/file values never leave the extension,
  // even if a page-side payload were malformed.
  const secretType =
    summary.type === "password" || summary.type === "hidden" || summary.type === "file";
  if (!secretType && typeof item.value === "string" && item.value !== "") {
    summary.value = item.value.slice(0, MAX_ELEMENT_VALUE);
  }
  return summary;
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

function jsonResult(response) {
  if (!response || !response.result) return null;
  const result = response.result;
  if (Object.prototype.hasOwnProperty.call(result, "value")) {
    return result.value === undefined ? null : result.value;
  }
  if (result.unserializableValue !== undefined) return String(result.unserializableValue);
  return null;
}

/**
 * @param {{chromeApi: typeof chrome, session: import("./debugger.js").DebuggerSession}} options
 */
export function createCommands({ chromeApi, session } = {}) {
  if (!chromeApi || !chromeApi.tabs) throw new Error("createCommands requires chromeApi.tabs");
  if (!session) throw new Error("createCommands requires a debugger session");

  async function getTab(tabId) {
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

  const domTools = createDomTools({ pageEval, session });
  async function pageEval(tabId, action, payload, frameId) {
    const isDomTool = Object.hasOwn(domTools, action);
    let contextId;
    if (frameId !== undefined) {
      if (typeof frameId !== "string" || !frameId) throw new Error("Invalid frameId");
      const world = await session.send(tabId, "Page.createIsolatedWorld", { frameId, worldName: "yandex-browser-mcp" });
      contextId = world.executionContextId;
      if (!Number.isInteger(contextId)) throw new Error("Frame context unavailable; refresh browser_frames");
    }
    const response = await session.send(tabId, "Runtime.evaluate", {
      expression: buildPageExpression(action, payload, isDomTool ? domRuntime : undefined),
      ...(contextId === undefined ? {} : { contextId }),
      returnByValue: true,
      awaitPromise: isDomTool,
      userGesture: false,
    });
    if (response && response.exceptionDetails) {
      throw new Error(exceptionMessage(response.exceptionDetails));
    }
    if (!response || !response.result) return undefined;
    return response.result.value;
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

  async function tabs() {
    const all = await chromeApi.tabs.query({});
    if (!Array.isArray(all)) return [];
    return all.filter((tab) => tab && typeof tab.id === "number").map(tabSummary);
  }

  async function open(params) {
    const p = asObject(params);
    const url = normalizeHttpUrl(p.url);
    const created = await chromeApi.tabs.create({ url, active: true });
    const loaded = await waitForTabReady(created.id, PAGE_LOAD_TIMEOUT_MS);
    return tabSummary(loaded || created);
  }

  async function activate(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    await getTab(tabId);
    return session.exclusive(tabId, async () => {
      const tab = await getTab(tabId);
      await chromeApi.tabs.update(tabId, { active: true });
      try {
        await chromeApi.windows.update(tab.windowId, { focused: true });
      } catch (error) {
        /* activating the tab is enough when the window cannot be focused */
      }
      return tabSummary(await getTab(tabId));
    });
  }

  async function close(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    return session.exclusive(tabId, async () => {
      await session.detach(tabId);
      try {
        await chromeApi.tabs.remove(tabId);
      } catch (error) {
        const message = errorText(error);
        if (!/no tab with (given )?id/i.test(message)) throw error;
      }
      return { closed: true };
    });
  }

  async function navigate(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const url = normalizeHttpUrl(p.url);
    return session.exclusive(tabId, async () => {
      await requireTab(tabId);
      const updated = await chromeApi.tabs.update(tabId, { url });
      const loaded = await waitForTabReady(tabId, PAGE_LOAD_TIMEOUT_MS);
      return tabSummary(loaded || updated);
    });
  }

  async function snapshot(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const maxChars = normalizeMaxChars(p.maxChars);
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      const raw = await pageEval(tabId, "snapshot", {
        maxChars,
        candidates: SNAPSHOT_CANDIDATE_SELECTOR,
      }, p.frameId);
      if (!raw || typeof raw !== "object") throw new Error("Snapshot returned no data");
      const elements = Array.isArray(raw.elements)
        ? raw.elements
            .slice(0, MAX_SUMMARY_ELEMENTS)
            .map(summaryElement)
            .filter((item) => item !== null)
        : [];
      return {
        url: typeof raw.url === "string" ? raw.url : "",
        title: typeof raw.title === "string" ? raw.title : "",
        text: typeof raw.text === "string" ? raw.text.slice(0, maxChars) : "",
        elements,
        truncated: raw.truncated === true,
        ...(Number.isFinite(raw.documentTime) ? { documentTime: raw.documentTime } : {}),
      };
    });
  }

  async function find(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    if (typeof p.name !== "string" || !p.name.trim() || p.name.trim().length > MAX_ELEMENT_NAME)
      throw new Error("name must contain 1 to 200 characters");
    if (p.role !== undefined && (typeof p.role !== "string" || !/^[a-z]+$/.test(p.role)))
      throw new Error("role must be a lowercase role name");
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      const raw = await pageEval(tabId, "find", {
        name: p.name.trim(), role: p.role, candidates: SNAPSHOT_CANDIDATE_SELECTOR,
      }, p.frameId);
      if (!Array.isArray(raw?.elements)) throw new Error("Find returned no data");
      const elements = raw.elements.slice(0, 10).map(summaryElement).filter(Boolean);
      for (const el of elements) delete el.value;
      return { elements, truncated: raw.truncated === true };
    });
  }

  async function click(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const hasSelector = p.selector !== undefined && p.selector !== null;
    const selector = hasSelector ? normalizeSelector(p.selector) : null;
    const hasX = p.x !== undefined && p.x !== null;
    const hasY = p.y !== undefined && p.y !== null;
    if (!selector && !hasX && !hasY) {
      throw new Error('click requires a "selector" or viewport coordinates "x" and "y"');
    }
    if (!selector && hasX !== hasY) {
      throw new Error('click requires both "x" and "y" viewport coordinates');
    }
    const button = normalizeButton(p.button);
    const clickCount = normalizeClickCount(p.clickCount);
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      let x;
      let y;
      if (selector) {
        const located = await pageEval(tabId, "locate", { selector });
        if (!located || located.ok !== true) {
          throw new Error("Cannot click: " + ((located && located.error) || "selector not found"));
        }
        x = located.x;
        y = located.y;
      } else {
        x = normalizeCoordinate(p.x, "x");
        y = normalizeCoordinate(p.y, "y");
        const viewport = await pageEval(tabId, "viewport", {});
        if (
          viewport &&
          typeof viewport.width === "number" &&
          typeof viewport.height === "number" &&
          (x < 0 || y < 0 || x > viewport.width || y > viewport.height)
        ) {
          throw new Error(
            "Coordinates (" + x + ", " + y + ") are outside the viewport " + viewport.width + "x" + viewport.height,
          );
        }
      }
      await session.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none",
      });
      for (let count = 1; count <= clickCount; count += 1) {
        await session.send(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button,
          clickCount: count,
        });
        await session.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button,
          clickCount: count,
        });
      }
      return { clicked: true };
    });
  }

  async function type(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const text = normalizeText(p.text);
    const hasSelector = p.selector !== undefined && p.selector !== null;
    const selector = hasSelector ? normalizeSelector(p.selector) : null;
    const clear = normalizeBoolean(p.clear, "clear", false);
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      if (selector) {
        const focused = await pageEval(tabId, "focus", { selector });
        if (!focused || focused.ok !== true) {
          throw new Error("Cannot type: " + ((focused && focused.error) || "could not focus selector"));
        }
      } else {
        const focused = await pageEval(tabId, "focused", {});
        if (!focused || focused.ok !== true) {
          throw new Error("Cannot type: " + ((focused && focused.error) || "no focused element"));
        }
      }
      if (clear) {
        for (const event of buildKeyEvents("a", MODIFIER_BITS.Control)) {
          await session.send(tabId, "Input.dispatchKeyEvent", event);
        }
        for (const event of buildKeyEvents("Backspace", 0)) {
          await session.send(tabId, "Input.dispatchKeyEvent", event);
        }
      }
      if (text.length > 0) {
        await session.send(tabId, "Input.insertText", { text });
      }
      return { typed: true };
    });
  }

  async function press(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const key = normalizeKey(p.key);
    const modifiers = normalizeModifiers(p.modifiers);
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      for (const event of buildKeyEvents(key, modifiers.mask)) {
        await session.send(tabId, "Input.dispatchKeyEvent", event);
      }
      return { pressed: true };
    });
  }

  async function scroll(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const deltaY = normalizeDeltaY(p.deltaY);
    const deltaX = normalizeDeltaX(p.deltaX);
    const hasX = p.x !== undefined && p.x !== null;
    const hasY = p.y !== undefined && p.y !== null;
    if (hasX !== hasY) throw new Error('scroll requires both "x" and "y" or neither');
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      let x;
      let y;
      if (hasX) {
        x = normalizeCoordinate(p.x, "x");
        y = normalizeCoordinate(p.y, "y");
      } else {
        const viewport = await pageEval(tabId, "viewport", {});
        const width = viewport && typeof viewport.width === "number" ? viewport.width : 0;
        const height = viewport && typeof viewport.height === "number" ? viewport.height : 0;
        x = width / 2;
        y = height / 2;
      }
      await session.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
      });
      return { scrolled: true };
    });
  }

  async function screenshot(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      const result = await session.send(tabId, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const data = result && typeof result.data === "string" ? result.data : "";
      if (data === "") throw new Error("Screenshot capture returned no data");
      return { data, mimeType: "image/png" };
    });
  }

  async function evaluate(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const expression = normalizeExpression(p.expression);
    await requireTab(tabId);
    return session.exclusive(tabId, async () => {
      const response = await session.send(tabId, "Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        // A page that never settles a promise must not block the tab queue
        // until the 30s protocol timeout: CDP terminates it earlier.
        timeout: 20000,
      });
      if (response && response.exceptionDetails) {
        throw new Error(exceptionMessage(response.exceptionDetails));
      }
      return jsonResult(response);
    });
  }

  async function cdp(params) {
    const p = asObject(params);
    const tabId = requireTabId(p.tabId);
    const method = normalizeCdpMethod(p.method);
    const cdpParams = normalizeCdpParams(p.params);
    await requireTab(tabId);
    const result = await session.exclusive(tabId, () => session.send(tabId, method, cdpParams));
    return result === undefined ? null : result;
  }

  return {
    ...domTools,
    ...createInteractionTools({ chromeApi, session, pageEval }),
    diff: createDiffTool({ chromeApi, session, snapshot }),
    tabs,
    open,
    activate,
    close,
    navigate,
    snapshot,
    find,
    click,
    type,
    press,
    scroll,
    screenshot,
    evaluate,
    cdp,
  };
}
