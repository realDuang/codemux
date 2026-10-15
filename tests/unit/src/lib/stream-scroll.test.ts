import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamScroll, isNearScrollBottom } from "../../../../src/lib/stream-scroll";

describe("createStreamScroll", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });
  afterEach(() => vi.unstubAllGlobals());

  function frame() {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  }

  function setup() {
    const viewport = { scrollTop: 900, scrollHeight: 1500, clientHeight: 600 };
    const state = { following: true, sessionId: "first", viewport };
    const scroll = createStreamScroll({
      viewport: () => state.viewport,
      sessionId: () => state.sessionId,
      following: () => state.following,
    });
    return { viewport, state, scroll };
  }

  it("coalesces streaming and delayed image layout while following the tail", () => {
    const { viewport, scroll } = setup();
    scroll.schedule();
    viewport.scrollHeight += 100;
    scroll.schedule();
    expect(frames.size).toBe(1);
    frame();
    expect(viewport.scrollTop).toBe(1600);
    viewport.scrollHeight += 200;
    scroll.schedule();
    frame();
    expect(viewport.scrollTop).toBe(1800);
  });

  it("does not pull the reader back when upward input arrives after a stream update", () => {
    const { viewport, state, scroll } = setup();
    viewport.scrollHeight += 100;
    scroll.schedule();
    state.following = false;
    viewport.scrollTop = 600;
    frame();
    expect(viewport.scrollTop).toBe(600);
    viewport.scrollHeight += 300;
    scroll.schedule();
    expect(frames.size).toBe(0);
  });

  it("respects a scrollbar drag even before the browser delivers its scroll event", () => {
    const { viewport, scroll } = setup();
    scroll.schedule();
    viewport.scrollTop = 400;
    frame();
    expect(viewport.scrollTop).toBe(400);
  });

  it("resumes after returning to the tail or sending another message", () => {
    const { viewport, state, scroll } = setup();
    state.following = false;
    viewport.scrollTop = 400;
    scroll.schedule();
    frame();
    expect(viewport.scrollTop).toBe(400);
    state.following = true;
    scroll.schedule();
    frame();
    expect(viewport.scrollTop).toBe(1500);
  });

  it("does not apply an old session frame to a restored reading position", () => {
    const { viewport, state, scroll } = setup();
    scroll.schedule();
    state.sessionId = "second";
    viewport.scrollTop = 1200;
    frame();
    expect(viewport.scrollTop).toBe(1200);
  });

  it("cancels work when leaving the page and permits a later fresh schedule", () => {
    const { viewport, scroll } = setup();
    scroll.schedule();
    scroll.cancel();
    frame();
    expect(viewport.scrollTop).toBe(900);
    scroll.schedule();
    frame();
    expect(viewport.scrollTop).toBe(1500);
  });
});

describe("isNearScrollBottom", () => {
  it("retains the existing 80 pixel tolerance", () => {
    expect(isNearScrollBottom({ scrollTop: 821, scrollHeight: 1500, clientHeight: 600 })).toBe(true);
    expect(isNearScrollBottom({ scrollTop: 820, scrollHeight: 1500, clientHeight: 600 })).toBe(false);
    expect(isNearScrollBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 })).toBe(true);
  });
});
