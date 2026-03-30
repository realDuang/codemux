import { beforeEach, describe, expect, it, vi } from "vitest";

const saveSettingMock = vi.fn();
const getSettingMock = vi.fn();
const getNestedSettingMock = vi.fn();
const saveNestedSettingMock = vi.fn();
const getDefaultEngineMock = vi.fn();
const setDefaultEngineMock = vi.fn();

vi.mock("../../../../src/lib/settings", () => ({
  saveSetting: saveSettingMock,
  getSetting: getSettingMock,
  getNestedSetting: getNestedSettingMock,
  saveNestedSetting: saveNestedSettingMock,
}));

vi.mock("../../../../src/lib/electron-api", () => ({
  settingsAPI: {
    getDefaultEngine: getDefaultEngineMock,
    setDefaultEngine: setDefaultEngineMock,
  },
}));

const configModule = await import("../../../../src/stores/config");

describe("config store default engine sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configModule.setConfigStore("defaultNewSessionEngine", null);
    configModule.setConfigStore("engines", []);
  });

  it("persists the selected default engine through settingsAPI", async () => {
    await configModule.setDefaultNewSessionEngine("copilot");

    expect(setDefaultEngineMock).toHaveBeenCalledWith("copilot");
    expect(saveSettingMock).toHaveBeenCalledWith("defaultEngine", "copilot");
    expect(configModule.configStore.defaultNewSessionEngine).toBe("copilot");
  });

  it("restores the default engine from settingsAPI first", async () => {
    getDefaultEngineMock.mockResolvedValue("claude");

    await configModule.restoreDefaultEngine();

    expect(getDefaultEngineMock).toHaveBeenCalled();
    expect(saveSettingMock).toHaveBeenCalledWith("defaultEngine", "claude");
    expect(configModule.configStore.defaultNewSessionEngine).toBe("claude");
  });

  it("falls back to local settings when settingsAPI lookup fails", async () => {
    getDefaultEngineMock.mockRejectedValue(new Error("network failed"));
    getSettingMock.mockReturnValue("copilot");

    await configModule.restoreDefaultEngine();

    expect(getSettingMock).toHaveBeenCalledWith("defaultEngine");
    expect(configModule.configStore.defaultNewSessionEngine).toBe("copilot");
  });
});
