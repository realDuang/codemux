import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeBrowserResume } from "../../../../src/lib/browser-resume";

describe("observeBrowserResume", () => {
  let page: EventTarget & { visibilityState: string };
  let browser: EventTarget;
  let network: { onLine: boolean };
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    browser = new EventTarget();
    network = { onLine: true };
    vi.stubGlobal("document", page);
    vi.stubGlobal("window", browser);
    vi.stubGlobal("navigator", network);
  });

  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("coalesces foreground, restored-page, and online events into one recovery", async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    stop = observeBrowserResume(resume);
    page.dispatchEvent(new Event("visibilitychange"));
    browser.dispatchEvent(new Event("pageshow"));
    browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(100);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("waits until the page is visible and the network returns", async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    stop = observeBrowserResume(resume);
    page.visibilityState = "hidden";
    browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(100);
    page.visibilityState = "visible";
    network.onLine = false;
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(100);
    expect(resume).not.toHaveBeenCalled();
    network.onLine = true;
    browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(100);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("avoids overlapping recovery and removes listeners on cleanup", async () => {
    let finish!: () => void;
    const resume = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    stop = observeBrowserResume(resume);
    browser.dispatchEvent(new Event("pageshow"));
    await vi.advanceTimersByTimeAsync(100);
    browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(100);
    expect(resume).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
    browser.dispatchEvent(new Event("pageshow"));
    stop();
    await vi.advanceTimersByTimeAsync(100);
    browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(100);
    expect(resume).toHaveBeenCalledOnce();
  });
});
