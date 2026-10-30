import { afterEach, expect, it, vi } from "vitest";
import { createMemoryWindowBus, openStudioChannel, serveStudio, StudioRequestError } from "./index";

const { emitTo, listen } = vi.hoisted(() => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/event", () => ({ emitTo, listen }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

type Requests = {
  echo: { params: { text: string }; result: string };
  fail: { params: undefined; result: never };
  refuse: { params: undefined; result: never };
};

const handlers = {
  echo: ({ text }: { text: string }) => `echo ${text}`,
  fail: () => Promise.reject(new Error("no world")),
  refuse: () => {
    throw new StudioRequestError("too_large", "Too big to live here");
  },
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function connect() {
  const bus = createMemoryWindowBus();
  const strip = serveStudio<Requests, string[]>(handlers, bus.connect("main"));
  const studio = openStudioChannel<Requests, string[]>({ transport: bus.connect("studio") });
  return { bus, strip, studio };
}

it("answers the Studio's requests", async () => {
  const { studio } = connect();
  await expect(studio.request("echo", { text: "hi" })).resolves.toBe("echo hi");
  await expect(
    Promise.all([studio.request("echo", { text: "a" }), studio.request("echo", { text: "b" })]),
  ).resolves.toEqual(["echo a", "echo b"]);
});

it("passes the strip's errors on", async () => {
  const { studio } = connect();
  await expect(studio.request("fail", undefined)).rejects.toThrow("no world");
  await expect(
    (studio as unknown as { request(kind: string, params: unknown): Promise<unknown> }).request(
      "toString",
      undefined,
    ),
  ).rejects.toThrow("Unknown request toString");
});

it("passes a refusal's code on with its message, and none with a plain error", async () => {
  const { studio } = connect();
  const refused = await studio.request("refuse", undefined).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(StudioRequestError);
  expect(refused).toMatchObject({ code: "too_large", message: "Too big to live here" });
  const failed = await studio.request("fail", undefined).catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(Error);
  expect(failed).not.toBeInstanceOf(StudioRequestError);
});

it("pushes library snapshots to the Studio", async () => {
  const { strip, studio } = connect();
  const heard: string[][] = [];
  const stop = studio.onLibraryChanged((snapshot) => heard.push(snapshot));
  await strip.pushLibrary(["user:a"]);
  stop();
  await strip.pushLibrary(["user:b"]);
  expect(heard).toEqual([["user:a"]]);
});

it("times out when the strip doesn't answer, and ignores a late answer", async () => {
  vi.useFakeTimers();
  const bus = createMemoryWindowBus();
  const studio = openStudioChannel<Requests, string[]>({
    transport: bus.connect("studio"),
    timeoutMs: 100,
  });
  const strip = bus.connect("main");
  const requests: unknown[] = [];
  await strip.listen("studio-request", (message) => requests.push(message));

  const answer = studio.request("echo", { text: "late" });
  const expectation = expect(answer).rejects.toThrow("No answer to echo in time");
  await vi.advanceTimersByTimeAsync(100);
  await expectation;

  const { requestId } = requests[0] as { requestId: string };
  await strip.emit("studio", "studio-response", { requestId, result: "too late" });
});

it("rejects waiting requests when the Studio closes", async () => {
  const bus = createMemoryWindowBus();
  const studio = openStudioChannel<Requests, string[]>({ transport: bus.connect("studio") });
  const answer = studio.request("echo", { text: "x" });
  studio.close();
  await expect(answer).rejects.toThrow("closed");
});

it("delivers only to the window an event is sent to", async () => {
  const bus = createMemoryWindowBus();
  const heard: string[] = [];
  await bus.connect("main").listen("ping", () => heard.push("main"));
  await bus.connect("studio").listen("ping", () => heard.push("studio"));
  await bus.connect("main").emit("studio", "ping", null);
  expect(heard).toEqual(["studio"]);
});

it("listens in Tauri as its own window and sends to the other", async () => {
  const strip = serveStudio<Requests, string[]>(handlers);
  const studio = openStudioChannel<Requests, string[]>();
  await strip.pushLibrary([]);
  await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(3));

  const targets = listen.mock.calls.map((call: unknown[]) => [call[0], call[2]]);
  expect(targets).toEqual(
    expect.arrayContaining([
      ["studio-request", { target: "main" }],
      ["studio-response", { target: "studio" }],
      ["library-changed", { target: "studio" }],
    ]),
  );
  expect(emitTo).toHaveBeenCalledWith("studio", "library-changed", []);
  strip.close();
  studio.close();
});
