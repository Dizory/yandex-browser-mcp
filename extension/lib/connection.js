// WebSocket transport for the local bridge server.
//
// - fixed server endpoint, one socket at a time
// - 20s keepalive ping while connected
// - short exponential backoff on disconnect
// - the old socket is closed (and de-handled) before a new one replaces it
// - `epoch` lets the background drop answers that belong to a dead connection

function describe(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

export class Connection {
  /**
   * @param {{
   *   endpoint: string,
   *   createSocket: (url: string) => WebSocket,
   *   handleMessage?: (message: object) => unknown,
   *   timers?: {setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function},
   *   pingIntervalMs?: number,
   *   reconnectBaseMs?: number,
   *   reconnectMaxMs?: number,
   *   onStatusChange?: ((status: object) => void)|null,
   * }} options
   */
  constructor(options = {}) {
    const {
      endpoint,
      createSocket,
      handleMessage = () => undefined,
      timers = globalThis,
      pingIntervalMs = 20000,
      reconnectBaseMs = 500,
      reconnectMaxMs = 5000,
      onStatusChange = null,
    } = options;
    if (typeof endpoint !== "string" || endpoint === "") {
      throw new Error("Connection requires an endpoint string");
    }
    if (typeof createSocket !== "function") {
      throw new Error("Connection requires a createSocket function");
    }
    this.endpoint = endpoint;
    this.createSocket = createSocket;
    this.handleMessage = handleMessage;
    this.timers = timers;
    this.pingIntervalMs = Math.max(1000, Number(pingIntervalMs) || 20000);
    this.reconnectBaseMs = Math.max(50, Number(reconnectBaseMs) || 500);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, Number(reconnectMaxMs) || 5000);
    this.onStatusChange = typeof onStatusChange === "function" ? onStatusChange : null;

    this.socket = null;
    this.state = "disconnected";
    this.attempts = 0;
    this.lastError = null;
    this.lastConnectedAt = null;
    this.lastMessageAt = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.stopped = true;
    this.epoch = 0;
  }

  isConnected() {
    return this.state === "connected" && !!this.socket && this.socket.readyState === 1;
  }

  getStatus() {
    return {
      state: this.state,
      endpoint: this.endpoint,
      attempts: this.attempts,
      lastError: this.lastError,
      connectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
    };
  }

  start() {
    this.stopped = false;
    this.connect();
    return this.getStatus();
  }

  stop() {
    this.stopped = true;
    this.clearReconnectTimer();
    this.stopPing();
    this.closeSocket();
    this.setState("disconnected");
  }

  /**
   * Manual reconnect: drops the old socket first, resets backoff, connects.
   */
  reconnect() {
    this.stopped = false;
    this.attempts = 0;
    this.clearReconnectTimer();
    this.stopPing();
    this.closeSocket();
    this.setState("disconnected");
    this.connect();
    return this.getStatus();
  }

  connect() {
    if (this.stopped) return;
    const current = this.socket;
    if (current && (current.readyState === 0 || current.readyState === 1)) return;
    this.clearReconnectTimer();
    this.closeSocket();
    this.attempts += 1;
    this.epoch += 1;
    const epoch = this.epoch;
    this.setState("connecting");
    let socket;
    try {
      socket = this.createSocket(this.endpoint);
    } catch (error) {
      this.lastError = describe(error);
      this.setState("disconnected");
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.epoch !== epoch) return;
      this.attempts = 0;
      this.lastError = null;
      this.lastConnectedAt = Date.now();
      this.setState("connected");
      this.startPing();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.epoch !== epoch) return;
      this.handleIncoming(event);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPing();
      this.setState("disconnected");
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.lastError = "WebSocket error";
    };
  }

  /**
   * @param {object} message
   * @returns {boolean} true when the message was handed to the socket
   */
  send(message) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    let serialized;
    try {
      serialized = JSON.stringify(message);
    } catch (error) {
      return false;
    }
    if (typeof serialized !== "string") return false;
    try {
      socket.send(serialized);
      return true;
    } catch (error) {
      this.lastError = describe(error);
      return false;
    }
  }

  handleIncoming(event) {
    let message;
    try {
      const data = event && event.data;
      message = typeof data === "string" ? JSON.parse(data) : null;
    } catch (error) {
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    this.lastMessageAt = Date.now();
    if (message.type === "ping") {
      this.send({ type: "pong" });
      return;
    }
    if (message.type === "pong") return;
    if (typeof message.id !== "string" || message.id === "") return;
    try {
      Promise.resolve(this.handleMessage(message)).catch((error) => {
        this.send({ id: message.id, error: describe(error) });
      });
    } catch (error) {
      this.send({ id: message.id, error: describe(error) });
    }
  }

  closeSocket() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      if (socket.readyState === 0 || socket.readyState === 1) socket.close();
    } catch (error) {
      /* ignore */
    }
  }

  startPing() {
    this.stopPing();
    this.pingTimer = this.timers.setInterval(() => {
      this.send({ type: "ping" });
    }, this.pingIntervalMs);
  }

  stopPing() {
    if (this.pingTimer !== null) {
      this.timers.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== null) return;
    const exponent = Math.min(this.attempts, 20);
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * Math.pow(2, exponent));
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  setState(state) {
    this.state = state;
    if (!this.onStatusChange) return;
    try {
      this.onStatusChange(this.getStatus());
    } catch (error) {
      /* a broken status listener must not break the bridge */
    }
  }
}
