import { isTauri } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { listenAs, STRIP_WINDOW, STUDIO_WINDOW } from "./events";

// The window channel between the Creation Studio and the strip (ADR 0015 §5). The world lives in
// the strip's window; the Studio asks it things with requests and hears about library changes.
// The messages are typed by the app, which knows what a request and a snapshot hold.

const REQUEST = "studio-request";
const RESPONSE = "studio-response";
const LIBRARY_CHANGED = "library-changed";

/** How long the Studio waits for an answer, so a reloading or busy strip shows an error. */
export const REQUEST_TIMEOUT_MS = 5000;

/** Each kind of request's parameters and result. Both are JSON. */
export type RequestMap = Record<string, { params: unknown; result: unknown }>;

/** Answers each kind of request; a throw or rejection reaches the Studio as an error. */
export type RequestHandlers<R extends RequestMap> = {
  [K in keyof R]: (params: R[K]["params"]) => R[K]["result"] | Promise<R[K]["result"]>;
};

interface RequestMessage {
  requestId: string;
  request: { kind: string; params: unknown };
}

type ResponseMessage = { requestId: string } & ({ result: unknown } | { error: string });

/**
 * Carries events between windows. `emit` sends to the window labelled `target` only; `listen`
 * hears only events sent to this window, and resolves once listening with a function that stops.
 */
export interface WindowTransport {
  emit(target: string, event: string, payload: unknown): Promise<void>;
  listen(event: string, listener: (payload: unknown) => void): Promise<() => void>;
}

/** Tauri's targeted events, listening as the window labelled `label`. */
const tauriTransport = (label: string): WindowTransport => ({
  emit: (target, event, payload) => emitTo(target, event, payload),
  listen: (event, listener) => listenAs(label, event, listener),
});

/**
 * Windows in memory, for tests: each `connect` is one window. Events arrive asynchronously, as
 * copies, like Tauri's.
 */
export function createMemoryWindowBus(): { connect(label: string): WindowTransport } {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const key = (label: string, event: string) => `${label}\n${event}`;
  return {
    connect: (label) => ({
      emit: (target, event, payload) =>
        Promise.resolve().then(() => {
          for (const listener of listeners.get(key(target, event)) ?? []) {
            listener(structuredClone(payload));
          }
        }),
      listen: (event, listener) => {
        const set = listeners.get(key(label, event)) ?? new Set();
        listeners.set(key(label, event), set);
        // A wrapper, so the same listener twice is two subscriptions.
        const subscription = (payload: unknown) => listener(payload);
        set.add(subscription);
        return Promise.resolve(() => void set.delete(subscription));
      },
    }),
  };
}

/** Outside Tauri there is no other window: a bus no one else is on. */
const connectTransport = (label: string) =>
  isTauri() ? tauriTransport(label) : createMemoryWindowBus().connect(label);

/** The Studio's end: requests to the strip and the library snapshots it pushes. */
export interface StudioChannel<R extends RequestMap, S> {
  /** Asks the strip. Rejects with the strip's error, or if no answer comes in time. */
  request<K extends keyof R & string>(kind: K, params: R[K]["params"]): Promise<R[K]["result"]>;
  /** Calls `listener` with each library snapshot the strip pushes. Returns a function that stops. */
  onLibraryChanged(listener: (snapshot: S) => void): () => void;
  /** Stops listening; requests still waiting reject. */
  close(): void;
}

export interface StudioChannelOptions {
  transport?: WindowTransport;
  timeoutMs?: number;
}

export function openStudioChannel<R extends RequestMap, S>({
  transport = connectTransport(STUDIO_WINDOW),
  timeoutMs = REQUEST_TIMEOUT_MS,
}: StudioChannelOptions = {}): StudioChannel<R, S> {
  const pending = new Map<string, { settle(response: ResponseMessage): void }>();
  const snapshotListeners = new Set<(snapshot: S) => void>();
  const stops = [
    transport.listen(RESPONSE, (payload) => {
      const response = payload as ResponseMessage;
      // A late answer to a request that timed out has no one waiting.
      pending.get(response.requestId)?.settle(response);
    }),
    transport.listen(LIBRARY_CHANGED, (payload) => {
      for (const listener of snapshotListeners) listener(payload as S);
    }),
  ];
  const listening = Promise.all(stops);

  return {
    request: (kind, params) =>
      new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(
          () => finish({ requestId, error: `No answer to ${kind} in time` }),
          timeoutMs,
        );
        const finish = (response: ResponseMessage) => {
          clearTimeout(timer);
          pending.delete(requestId);
          if ("error" in response) reject(new Error(response.error));
          else resolve(response.result as R[typeof kind]["result"]);
        };
        pending.set(requestId, { settle: finish });
        const message: RequestMessage = { requestId, request: { kind, params } };
        // Listening first, so the answer can't arrive before its listener.
        listening
          .then(() => transport.emit(STRIP_WINDOW, REQUEST, message))
          .catch((cause: unknown) => finish({ requestId, error: describeError(cause) }));
      }),
    onLibraryChanged: (listener) => {
      const subscription = (snapshot: S) => listener(snapshot);
      snapshotListeners.add(subscription);
      return () => void snapshotListeners.delete(subscription);
    },
    close: () => {
      for (const stop of stops) void stop.then((unlisten) => unlisten());
      snapshotListeners.clear();
      for (const [requestId, { settle }] of pending) {
        settle({ requestId, error: "The Studio's channel is closed" });
      }
    },
  };
}

/** The strip's end: answers the Studio's requests and pushes library snapshots to it. */
export interface StripChannel<S> {
  /** Sends `snapshot` to the Studio, if it is open. */
  pushLibrary(snapshot: S): Promise<void>;
  /** Stops answering. */
  close(): void;
}

export function serveStudio<R extends RequestMap, S>(
  handlers: RequestHandlers<R>,
  transport: WindowTransport = connectTransport(STRIP_WINDOW),
): StripChannel<S> {
  const answer = async ({ requestId, request }: RequestMessage) => {
    let response: ResponseMessage;
    try {
      const handler = Object.hasOwn(handlers, request.kind) ? handlers[request.kind] : undefined;
      if (!handler) throw new Error(`Unknown request ${request.kind}`);
      response = { requestId, result: await handler(request.params) };
    } catch (cause) {
      response = { requestId, error: describeError(cause) };
    }
    await transport.emit(STUDIO_WINDOW, RESPONSE, response);
  };
  const stop = transport.listen(REQUEST, (payload) => {
    answer(payload as RequestMessage).catch((cause: unknown) =>
      console.warn("Could not answer the Studio", cause),
    );
  });
  return {
    pushLibrary: (snapshot) => transport.emit(STUDIO_WINDOW, LIBRARY_CHANGED, snapshot),
    close: () => void stop.then((unlisten) => unlisten()),
  };
}

const describeError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
