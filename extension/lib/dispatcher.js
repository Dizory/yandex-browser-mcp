// Request dispatcher: validates the envelope, enforces the protocol timeout,
// maps handler failures to {id, error}. It never retries an operation.

export class CommandTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super('Command "' + method + '" timed out after ' + timeoutMs + " ms");
    this.name = "CommandTimeoutError";
  }
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error == null ? "Unknown error" : error);
  return text === "" ? "Unknown error" : text;
}

function withTimeout(promise, timeoutMs, setTimer, clearTimer, method) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      reject(new CommandTimeoutError(method, timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        reject(error);
      },
    );
  });
}

/**
 * @param {{
 *   handlers: Record<string, (params: object) => Promise<unknown>|unknown>,
 *   timeoutMs?: number,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} options
 * @returns {(message: unknown) => Promise<{id:string, result?:unknown, error?:string}|null>}
 */
export function createDispatcher({
  handlers,
  timeoutMs = 30000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!handlers || typeof handlers !== "object") {
    throw new Error("createDispatcher requires a handlers object");
  }
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;

  return async function dispatch(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    if (typeof message.id !== "string" || message.id === "") return null;
    const id = message.id;
    if (typeof message.method !== "string" || message.method === "") {
      return { id, error: "Request method must be a non-empty string" };
    }
    const method = message.method;
    if (!Object.prototype.hasOwnProperty.call(handlers, method)) {
      return { id, error: "Unknown method: " + method };
    }
    const handler = handlers[method];
    if (typeof handler !== "function") {
      return { id, error: "Unknown method: " + method };
    }
    const params = message.params === undefined || message.params === null ? {} : message.params;
    try {
      const result = await withTimeout(
        Promise.resolve().then(() => handler(params)),
        limit,
        setTimer,
        clearTimer,
        method,
      );
      return { id, result: result === undefined ? null : result };
    } catch (error) {
      return { id, error: errorMessage(error) };
    }
  };
}
