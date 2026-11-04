// chrome.debugger wrapper: lazy attach per tab, per-tab command serialization,
// and recovery after detach. Never retries a failed operation on its own.

const PROTOCOL_VERSION = "1.3";

function describe(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

function decorateAttachError(error) {
  const message = describe(error);
  if (/another debugger|already attached/i.test(message)) {
    return new Error(
      "Cannot attach debugger: another debugger (for example DevTools) is attached to this tab. Close it and retry.",
    );
  }
  if (/cannot access a chrome|chrome:\/\//i.test(message)) {
    return new Error("Cannot debug this page: browser-internal pages are not accessible.");
  }
  return new Error("Cannot attach debugger: " + message);
}

function isDetachError(message) {
  return /not attached|no tab with given id|target closed|inspected target navigated|cannot find context|no target/i.test(
    message,
  );
}

export class DebuggerSession {
  /**
   * @param {{chromeApi: typeof chrome, protocolVersion?: string}} options
   */
  constructor({ chromeApi, protocolVersion = PROTOCOL_VERSION } = {}) {
    if (!chromeApi || !chromeApi.debugger) {
      throw new Error("DebuggerSession requires chromeApi.debugger");
    }
    this.chromeApi = chromeApi;
    this.protocolVersion = protocolVersion;
    this.attached = new Set();
    this.queues = new Map();
    this.listenersRegistered = false;
  }

  init() {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;
    try {
      this.chromeApi.debugger.onDetach.addListener((source) => {
        if (source && Number.isInteger(source.tabId)) this.attached.delete(source.tabId);
      });
    } catch (error) {
      /* the API is present in normal Chromium builds */
    }
    try {
      this.chromeApi.tabs.onRemoved.addListener((tabId) => {
        this.attached.delete(tabId);
      });
    } catch (error) {
      /* ignore */
    }
    try {
      this.chromeApi.tabs.onReplaced.addListener((added, removed) => {
        if (Number.isInteger(removed)) this.attached.delete(removed);
      });
    } catch (error) {
      /* ignore */
    }
  }

  isAttached(tabId) {
    return this.attached.has(tabId);
  }

  /**
   * Attaches lazily. A stale attachment left by a previous service-worker
   * instance is cleared with one detach and then re-attached. DevTools (or any
   * other debugger) cannot be detached this way and yields a readable error.
   *
   * @param {number} tabId
   */
  async attach(tabId) {
    if (this.attached.has(tabId)) return;
    this.init();
    const target = { tabId };
    try {
      await this.chromeApi.debugger.attach(target, this.protocolVersion);
      this.attached.add(tabId);
      return;
    } catch (error) {
      if (!/already attached/i.test(describe(error))) throw decorateAttachError(error);
    }
    try {
      await this.chromeApi.debugger.detach(target);
    } catch (error) {
      /* another debugger owns it; the retry below reports the readable error */
    }
    try {
      await this.chromeApi.debugger.attach(target, this.protocolVersion);
      this.attached.add(tabId);
    } catch (error) {
      throw decorateAttachError(error);
    }
  }

  /**
   * Best-effort detach, used before closing a tab.
   *
   * @param {number} tabId
   */
  async detach(tabId) {
    this.attached.delete(tabId);
    try {
      await this.chromeApi.debugger.detach({ tabId });
    } catch (error) {
      /* already detached or never attached */
    }
  }

  /**
   * Sends one CDP command. Callers must have acquired the tab queue with
   * `exclusive` for multi-step interactions.
   *
   * @param {number} tabId
   * @param {string} method
   * @param {object} [params]
   */
  async send(tabId, method, params = {}) {
    await this.attach(tabId);
    try {
      return await this.chromeApi.debugger.sendCommand({ tabId }, method, params);
    } catch (error) {
      const message = describe(error);
      if (isDetachError(message)) this.attached.delete(tabId);
      throw new Error("Tab " + tabId + ": " + message);
    }
  }

  /**
   * Serializes work per tab. The tail promise never rejects, so one failed
   * command does not poison the queue.
   *
   * @template T
   * @param {number} tabId
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  exclusive(tabId, task) {
    const previous = this.queues.get(tabId) || Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(tabId, tail);
    tail.then(() => {
      if (this.queues.get(tabId) === tail) this.queues.delete(tabId);
    });
    return run;
  }
}
