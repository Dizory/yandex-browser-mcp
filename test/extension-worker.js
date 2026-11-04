import { parentPort, workerData } from 'node:worker_threads';
import { WebSocket } from 'ws';

const event = () => ({ addListener() {} });
globalThis.WebSocket = class extends WebSocket {
  constructor() { super(`ws://127.0.0.1:${workerData.port}/extension`); }
};
globalThis.chrome = {
  runtime: {
    id: 'a'.repeat(32), onInstalled: event(), onStartup: event(), onMessage: event(),
    async sendMessage() {},
  },
  alarms: { async get() { return {}; }, async create() {}, onAlarm: event() },
  tabs: {
    onRemoved: event(), onReplaced: event(),
    async query() { return [{ id: 7, windowId: 1, title: 'Fixture', url: 'https://example.test/', active: true, status: 'complete' }]; },
    async get(id) { return { id, windowId: 1, status: 'complete' }; },
  },
  debugger: {
    onDetach: event(),
    async attach() {}, async detach() {},
    async sendCommand(_target, method) {
      if (method === 'Runtime.evaluate') return { result: { value: 42 } };
      throw new Error('Unexpected CDP command');
    },
  },
};
await import('../extension/background.js');
parentPort.postMessage('loaded');
