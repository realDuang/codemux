import { describe, expect, it, vi } from "vitest";
import { createPwaUpdateGate } from "../../../../src/web/pwa-update";

describe("createPwaUpdateGate", () => {
  it("keeps the page open when another tab activates an update", () => {
    const reload = vi.fn();
    const gate = createPwaUpdateGate(() => true, reload);
    gate.activate();
    expect(reload).not.toHaveBeenCalled();
    expect(gate.request()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads only after an explicitly requested update activates", () => {
    const reload = vi.fn();
    const gate = createPwaUpdateGate(() => true, reload);
    gate.request();
    expect(reload).not.toHaveBeenCalled();
    gate.activate();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("rechecks unsaved work when activation happens after the refresh click", () => {
    let safe = true;
    const reload = vi.fn();
    const gate = createPwaUpdateGate(() => safe, reload);
    gate.request();
    safe = false;
    gate.activate();
    expect(reload).not.toHaveBeenCalled();
    expect(gate.request()).toBe(false);
    safe = true;
    expect(reload).not.toHaveBeenCalled();
    gate.request();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload after a timed out update activates later", () => {
    const reload = vi.fn();
    const gate = createPwaUpdateGate(() => true, reload);
    gate.request();
    gate.cancel();
    gate.activate();
    expect(reload).not.toHaveBeenCalled();
  });
});
