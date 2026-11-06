// MV3 service worker entry point.
//
// Owns a single WebSocket to the local MCP bridge server, dispatches protocol
// requests, keeps the connection alive with 20s pings, and uses chrome.alarms
// as the recovery path after service-worker suspension.

import { Connection } from "./lib/connection.js";
import { createDispatcher } from "./lib/dispatcher.js";
import { createCommands } from "./lib/commands.js";
import { DebuggerSession } from "./lib/debugger.js";
import { reloadUpdatedExtension } from "./lib/self-update.js";

const ENDPOINT = "ws://127.0.0.1:37891/extension";
const ALARM_NAME = "bridge:keepalive";
const ALARM_PERIOD_MINUTES = 0.5;
const COMMAND_TIMEOUT_MS = 30000;

const chromeApi = chrome;

const session = new DebuggerSession({ chromeApi });
session.init();

const commands = createCommands({ chromeApi, session });
const dispatch = createDispatcher({ handlers: commands, timeoutMs: COMMAND_TIMEOUT_MS });

let statusNotifyTimer = null;
let activeRequests = 0;
function notifyPopup(status) {
  if (statusNotifyTimer !== null) return;
  statusNotifyTimer = setTimeout(() => {
    statusNotifyTimer = null;
  }, 500);
  try {
    const pending = chrome.runtime.sendMessage({ type: "bridge:status", status });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch (error) {
    /* no popup is open */
  }
}

const connection = new Connection({
  endpoint: ENDPOINT,
  createSocket: (url) => new WebSocket(url),
  pingIntervalMs: 20000,
  handleMessage: async (message) => {
    // Answers for a request that belonged to a closed socket are dropped: the
    // server keeps a fresh pending-id map after reconnecting.
    const epoch = connection.epoch;
    activeRequests++;
    try {
      const response = await dispatch(message);
      if (response && connection.epoch === epoch) connection.send(response);
    } finally {
      activeRequests--;
    }
  },
  onStatusChange: (status) => notifyPopup(status),
});

async function ensureAlarm() {
  try {
    const existing = await chromeApi.alarms.get(ALARM_NAME);
    if (!existing) {
      await chromeApi.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
    }
  } catch (error) {
    /* alarms are best-effort recovery; the live ping keeps the socket up */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm();
  connection.start();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  connection.start();
});

chromeApi.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== ALARM_NAME) return;
  void ensureAlarm();
  if (!connection.isConnected()) connection.connect();
  void reloadUpdatedExtension(chrome.runtime, () => activeRequests === 0 && session.queues.size === 0)
    .catch(() => {}); // A temporarily unavailable directory is retried on the next alarm.
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (message.type === "bridge:status:get") {
    sendResponse({ ok: true, status: connection.getStatus() });
    return false;
  }
  if (message.type === "bridge:reconnect") {
    try {
      sendResponse({ ok: true, status: connection.reconnect() });
    } catch (error) {
      sendResponse({ ok: false, error: error && error.message ? String(error.message) : String(error) });
    }
    return false;
  }
  return false;
});

void ensureAlarm();
connection.start();
