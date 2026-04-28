import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockScopedLogger } = vi.hoisted(() => ({
  mockScopedLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn(),
  },
}));

vi.mock("../../../../electron/main/services/logger", () => ({
  channelLog: mockScopedLogger,
  dingtalkLog: mockScopedLogger,
  teamsLog: mockScopedLogger,
  wecomLog: mockScopedLogger,
  telegramLog: mockScopedLogger,
  getDefaultEngineFromSettings: vi.fn(() => "opencode"),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? process.cwd()),
  },
}));

import { TeamsAdapter } from "../../../../electron/main/channels/teams/teams-adapter";
import { DEFAULT_TEAMS_CONFIG } from "../../../../electron/main/channels/teams/teams-types";
import { DingTalkAdapter } from "../../../../electron/main/channels/dingtalk/dingtalk-adapter";
import { DEFAULT_DINGTALK_CONFIG } from "../../../../electron/main/channels/dingtalk/dingtalk-types";
import { WeComAdapter } from "../../../../electron/main/channels/wecom/wecom-adapter";
import { DEFAULT_WECOM_CONFIG } from "../../../../electron/main/channels/wecom/wecom-types";

describe("channel adapter updateConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not restart Teams when the same credentials are re-saved", async () => {
    const adapter = new TeamsAdapter() as any;
    adapter.status = "running";
    adapter.config = {
      ...DEFAULT_TEAMS_CONFIG,
      microsoftAppId: "app-id",
      microsoftAppPassword: "secret",
      tenantId: "tenant-a",
    };
    adapter.stop = vi.fn().mockResolvedValue(undefined);
    adapter.start = vi.fn().mockResolvedValue(undefined);

    await adapter.updateConfig({
      options: {
        microsoftAppId: "app-id",
        microsoftAppPassword: "secret",
      },
    });

    expect(adapter.stop).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it("restarts Teams when the tenant changes", async () => {
    const adapter = new TeamsAdapter() as any;
    adapter.status = "running";
    adapter.config = {
      ...DEFAULT_TEAMS_CONFIG,
      microsoftAppId: "app-id",
      microsoftAppPassword: "secret",
      tenantId: "tenant-a",
    };
    adapter.stop = vi.fn().mockResolvedValue(undefined);
    adapter.start = vi.fn().mockResolvedValue(undefined);

    await adapter.updateConfig({
      options: {
        tenantId: "tenant-b",
      },
    });

    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(adapter.start).toHaveBeenCalledTimes(1);
  });

  it("restarts DingTalk when the stream-mode setting changes", async () => {
    const adapter = new DingTalkAdapter() as any;
    adapter.status = "running";
    adapter.config = {
      ...DEFAULT_DINGTALK_CONFIG,
      appKey: "app-key",
      appSecret: "secret",
      robotCode: "robot",
      useStreamMode: true,
    };
    adapter.stop = vi.fn().mockResolvedValue(undefined);
    adapter.start = vi.fn().mockResolvedValue(undefined);

    await adapter.updateConfig({
      options: {
        useStreamMode: false,
      },
    });

    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(adapter.start).toHaveBeenCalledTimes(1);
  });

  it("restarts WeCom when callback verification settings change", async () => {
    const adapter = new WeComAdapter() as any;
    adapter.status = "running";
    adapter.config = {
      ...DEFAULT_WECOM_CONFIG,
      corpId: "corp-id",
      corpSecret: "secret",
      agentId: 10001,
      callbackToken: "token-a",
      callbackEncodingAESKey: "aes-key-a",
    };
    adapter.stop = vi.fn().mockResolvedValue(undefined);
    adapter.start = vi.fn().mockResolvedValue(undefined);

    await adapter.updateConfig({
      options: {
        callbackToken: "token-b",
      },
    });

    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(adapter.start).toHaveBeenCalledTimes(1);
  });
});
