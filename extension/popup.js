"use strict";

const STATE_LABELS = {
  connected: "Подключено",
  connecting: "Подключение…",
  disconnected: "Нет связи",
};

const stateEl = document.getElementById("state");
const dotEl = document.getElementById("dot");
const endpointEl = document.getElementById("endpoint");
const errorEl = document.getElementById("error");
const reconnectEl = document.getElementById("reconnect");

function shorten(value, limit) {
  const text = String(value == null ? "" : value);
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

function render(status) {
  const state = status && STATE_LABELS[status.state] ? status.state : "disconnected";
  stateEl.textContent = STATE_LABELS[state];
  dotEl.className = "dot " + state;
  if (status && typeof status.endpoint === "string" && status.endpoint) {
    endpointEl.textContent = status.endpoint;
  }
  if (status && status.lastError) {
    errorEl.hidden = false;
    errorEl.textContent = shorten(status.lastError, 180);
  } else {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
}

async function fetchStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "bridge:status:get" });
    if (response && response.ok) {
      render(response.status);
      return;
    }
    render({ state: "disconnected", lastError: "Фоновый процесс вернул неожиданный ответ" });
  } catch (error) {
    render({ state: "disconnected", lastError: "Фоновый процесс недоступен" });
  }
}

async function reconnect() {
  reconnectEl.disabled = true;
  stateEl.textContent = "Переподключение…";
  dotEl.className = "dot connecting";
  try {
    const response = await chrome.runtime.sendMessage({ type: "bridge:reconnect" });
    if (response && response.ok) {
      render(response.status);
    } else {
      render({
        state: "disconnected",
        lastError: response && response.error ? response.error : "Не удалось подключиться",
      });
    }
  } catch (error) {
    render({ state: "disconnected", lastError: "Фоновый процесс недоступен" });
  } finally {
    reconnectEl.disabled = false;
  }
}

reconnectEl.addEventListener("click", () => {
  void reconnect();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "bridge:status" && message.status) {
    render(message.status);
  }
  return false;
});

void fetchStatus();
setInterval(() => {
  void fetchStatus();
}, 1500);
