// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachEditorInput } from "./editor-input";

// jsdom has no PointerEvent nor pointer capture, so pointer events are mouse events with a
// pointerId, and the container records the capture.

const pointer = (type: string, init: { x?: number; y?: number; button?: number } = {}) => {
  const event = new MouseEvent(type, {
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    button: init.button ?? 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "pointerId", { value: 7 });
  return event;
};

const wheel = (deltaY: number, deltaMode = 0) =>
  new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true });

/** A container with a canvas inside, whose listener stands for the camera's. */
function setup(takes: { down?: boolean; move?: boolean; up?: boolean; wheel?: boolean } = {}) {
  const container = document.createElement("main");
  const canvas = document.createElement("canvas");
  container.append(canvas);
  document.body.append(container);
  const captured = new Set<number>();
  Object.assign(container, {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });
  const order: string[] = [];
  const editor = {
    pointerDown: vi.fn(() => {
      order.push("editor");
      return takes.down ?? false;
    }),
    pointerMove: vi.fn(() => takes.move ?? false),
    pointerUp: vi.fn(() => takes.up ?? false),
    pointerCancel: vi.fn(),
    wheel: vi.fn<(deltaY: number) => boolean>(() => takes.wheel ?? false),
  };
  const camera = vi.fn((event: Event) => order.push(`camera ${event.type}`));
  for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"]) {
    canvas.addEventListener(type, camera);
  }
  const detach = attachEditorInput(container, editor);
  return { container, canvas, captured, editor, camera, order, detach };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("attachEditorInput", () => {
  it("asks the editor before the camera, and leaves the camera what it doesn't take", () => {
    const { canvas, editor, order } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { x: 3, y: 4 }));
    expect(order).toEqual(["editor", "camera pointerdown"]);
    expect(editor.pointerDown).toHaveBeenCalledWith(expect.objectContaining({ clientX: 3 }), 0);
  });

  it("keeps a press the editor takes from the camera, capturing the pointer until it is up", () => {
    const { canvas, captured, camera } = setup({ down: true, move: true, up: true });
    const down = pointer("pointerdown");
    canvas.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(captured.has(7)).toBe(true);
    canvas.dispatchEvent(pointer("pointermove"));
    canvas.dispatchEvent(pointer("pointerup"));
    expect(camera).not.toHaveBeenCalled();
    expect(captured.has(7)).toBe(false);
  });

  it("lets moves and a release through when the editor doesn't drag", () => {
    const { canvas, captured, camera } = setup();
    canvas.dispatchEvent(pointer("pointerdown"));
    canvas.dispatchEvent(pointer("pointermove"));
    canvas.dispatchEvent(pointer("pointerup"));
    expect(captured.size).toBe(0);
    expect(camera).toHaveBeenCalledTimes(3);
  });

  it("scales instead of zooming when the editor takes the wheel", () => {
    const taken = setup({ wheel: true });
    const event = wheel(-100);
    taken.canvas.dispatchEvent(event);
    expect(taken.editor.wheel).toHaveBeenCalledWith(-100);
    expect(event.defaultPrevented).toBe(true);
    expect(taken.camera).not.toHaveBeenCalled();
    document.body.replaceChildren();

    const left = setup();
    left.canvas.dispatchEvent(wheel(-100));
    expect(left.camera).toHaveBeenCalledOnce();
  });

  it("counts a scroll in lines as one notch", () => {
    const { canvas, editor } = setup();
    canvas.dispatchEvent(wheel(3, WheelEvent.DOM_DELTA_LINE));
    expect(editor.wheel).toHaveBeenCalledWith(100);
  });

  it("passes a lost pointer on, and removes every listener when detached", () => {
    const { canvas, editor, camera, detach } = setup({ down: true, wheel: true });
    canvas.dispatchEvent(pointer("pointercancel"));
    expect(editor.pointerCancel).toHaveBeenCalledOnce();
    detach();
    canvas.dispatchEvent(pointer("pointerdown"));
    canvas.dispatchEvent(pointer("pointermove"));
    canvas.dispatchEvent(pointer("pointerup"));
    canvas.dispatchEvent(pointer("pointercancel"));
    canvas.dispatchEvent(wheel(-100));
    expect(editor.pointerDown).not.toHaveBeenCalled();
    expect(editor.pointerMove).not.toHaveBeenCalled();
    expect(editor.pointerUp).not.toHaveBeenCalled();
    expect(editor.pointerCancel).toHaveBeenCalledOnce();
    expect(editor.wheel).not.toHaveBeenCalled();
    expect(camera).toHaveBeenCalledTimes(4);
  });
});
