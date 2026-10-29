import { runSimulationHost } from "@living-diorama/simulation";
import { loadContent } from "./content";

// The simulation Web Worker (ADR 0006 §11). The app's tsconfig uses the DOM lib, not WebWorker,
// so the worker scope is typed by the little it needs here.

const scope = self as unknown as {
  postMessage(data: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
};

runSimulationHost(
  {
    postMessage: (data) => scope.postMessage(data),
    onMessage: (handler) => {
      scope.onmessage = (event) => handler(event.data);
    },
  },
  {
    loadContent,
    now: () => performance.now(),
    wallNow: () => Date.now(),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    close: () => scope.close(),
  },
);
