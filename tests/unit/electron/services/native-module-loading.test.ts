import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyModule } from "../../../../electron/main/services/terminal-service";

const fixtures = vi.hoisted(() => {
  const requireNativeModule = vi.fn();
  return {
    requireNativeModule,
    createRequire: vi.fn(() => requireNativeModule),
    unsubscribe: vi.fn(async () => {}),
  };
});

vi.mock("node:module", () => ({ createRequire: fixtures.createRequire }));
vi.mock("node:child_process", () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: (error: null) => void) => callback(null),
}));
vi.mock("../../../../electron/main/services/logger", () => ({
  terminalLog: { info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../../../electron/main/services/terminal-profiles", () => ({
  listTerminalProfiles: () => ({ profiles: [], defaultProfileId: null }),
  getTerminalProfile: () => null,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("file-service native loading", () => {
  it.each([false, true])("lazily loads the native watcher and retains fallback (binding unavailable: %s)", async (bindingUnavailable) => {
    const binding = {};
    const subscribe = vi.fn(async () => ({ unsubscribe: fixtures.unsubscribe }));
    const watcher = { subscribe };
    const createWrapper = vi.fn(() => watcher);
    const suffix = process.platform === "linux" ? "-glibc" : "";
    const bindingName = `@parcel/watcher-${process.platform}-${process.arch}${suffix}`;
    fixtures.requireNativeModule.mockImplementation((name: string) => {
      if (name === bindingName) {
        if (bindingUnavailable) throw new Error("Native binding unavailable");
        return binding;
      }
      if (name === "@parcel/watcher/wrapper") return { createWrapper };
      if (name === "@parcel/watcher") return watcher;
      throw new Error(`Unexpected native module: ${name}`);
    });
    const { watchDirectory, unwatchAll } = await import("../../../../electron/main/services/file-service");

    expect(fixtures.createRequire).toHaveBeenCalledWith(expect.stringContaining("/file-service.ts"));
    expect(fixtures.requireNativeModule).not.toHaveBeenCalled();
    watchDirectory(process.cwd());
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixtures.requireNativeModule.mock.calls.map(([name]) => name)).toEqual(
      bindingUnavailable ? [bindingName, "@parcel/watcher"] : [bindingName, "@parcel/watcher/wrapper"],
    );
    if (!bindingUnavailable) expect(createWrapper).toHaveBeenCalledWith(binding);
    unwatchAll();
    expect(fixtures.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("TerminalService native loading", () => {
  it("defers node-pty loading until creation and keeps injected PTY modules independent", async () => {
    const kill = vi.fn();
    const ptyModule: PtyModule = {
      spawn: vi.fn(() => ({
        pid: 123,
        kill,
        onData: () => ({ dispose() {} }),
        onExit: () => ({ dispose() {} }),
      }) as ReturnType<PtyModule["spawn"]>),
    };
    fixtures.requireNativeModule.mockReturnValue(ptyModule);
    const { TerminalService } = await import("../../../../electron/main/services/terminal-service");
    const injected = new TerminalService({ ptyModule });
    const native = new TerminalService();
    const options = { ownerClientId: "owner", cwd: process.cwd(), cols: 80, rows: 24 };

    expect(fixtures.createRequire).toHaveBeenCalledWith(expect.stringContaining("/terminal-service.ts"));
    expect(fixtures.requireNativeModule).not.toHaveBeenCalled();
    injected.create(options);
    expect(fixtures.requireNativeModule).not.toHaveBeenCalled();
    native.create(options);
    native.create(options);
    expect(fixtures.requireNativeModule).toHaveBeenCalledExactlyOnceWith("node-pty");
    expect(ptyModule.spawn).toHaveBeenCalledTimes(3);

    injected.destroyAll();
    native.destroyAll();
    expect(kill).toHaveBeenCalledTimes(3);
  });
});
