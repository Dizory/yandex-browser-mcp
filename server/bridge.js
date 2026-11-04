import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

export class BrowserBridge {
  constructor({ timeoutMs = 30_000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.pending = new Map();
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  attach(socket) {
    if (this.connected) {
      socket.close(1008, 'A browser is already connected');
      return;
    }
    this.socket = socket;
    let lastSeen = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastSeen > 60_000) socket.terminate();
    }, 20_000);
    heartbeat.unref();
    socket.on('message', (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (!message || typeof message !== 'object') return;
      lastSeen = Date.now();
      if (message.type === 'ping') {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry || entry.socket !== socket) return;
      if (typeof message.error !== 'string' && !Object.hasOwn(message, 'result')) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (typeof message.error === 'string') entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearInterval(heartbeat);
      if (this.socket === socket) this.socket = null;
      for (const [id, entry] of this.pending) {
        if (entry.socket !== socket) continue;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new Error('Browser disconnected. An action may already have run; inspect the page before retrying.'));
      }
    });
  }

  request(method, params) {
    if (!this.connected) return Promise.reject(new Error('Browser extension is not connected. Start Yandex Browser and enable the extension.'));
    const id = randomUUID();
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command ${method} timed out. It may already have run; inspect the page before retrying.`));
      }, this.timeoutMs);
      this.pending.set(id, { socket, resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
}
