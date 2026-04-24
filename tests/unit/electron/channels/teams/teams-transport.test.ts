import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
  silly: vi.fn(),
}));

vi.mock("../../../../../electron/main/services/logger", () => ({
  channelLog: mockLogger,
}));

// Mock global fetch
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import { TeamsTransport } from "../../../../../electron/main/channels/teams/teams-transport";

function makeRateLimiter() {
  return { consume: vi.fn().mockResolvedValue(undefined) } as any;
}

function makeOkResponse(body: unknown) {
  return {
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("TeamsTransport", () => {
  let transport: TeamsTransport;
  let rateLimiter: ReturnType<typeof makeRateLimiter>;

  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter = makeRateLimiter();
    // The constructor calls fetch for token — we mock that in TokenManager via the
    // fetcher callback. But since TokenManager is internal to the constructor,
    // we just need to make sure fetch is mocked for the token endpoint + API calls.
    transport = new TeamsTransport("app-id", "app-password", rateLimiter);
    transport.setServiceUrl("conv-1", "https://smba.trafficmanager.net/teams/");
  });

  describe("sendMarkdown", () => {
    it("delegates to sendText and returns the same compound message ID", async () => {
      // Mock token fetch (first fetch call) and API call (second fetch call)
      fetchMock
        .mockResolvedValueOnce(
          makeOkResponse({ access_token: "tok-123", expires_in: 3600 }),
        )
        .mockResolvedValueOnce(
          makeOkResponse({ id: "activity-42" }),
        );

      const result = await transport.sendMarkdown("conv-1", "**hello** world");
      expect(result).toBe("conv-1|activity-42");

      // Verify the API call used the markdown text as-is, with textFormat: "markdown"
      const apiCall = fetchMock.mock.calls[1];
      expect(apiCall[0]).toContain("/v3/conversations/conv-1/activities");
      const body = JSON.parse(apiCall[1].body);
      expect(body).toEqual({
        type: "message",
        text: "**hello** world",
        textFormat: "markdown",
      });
    });

    it("returns the same result as sendText", async () => {
      const sendTextSpy = vi.spyOn(transport, "sendText").mockResolvedValue("conv-1|act-99");
      const result = await transport.sendMarkdown("conv-1", "# heading");
      expect(sendTextSpy).toHaveBeenCalledWith("conv-1", "# heading");
      expect(result).toBe("conv-1|act-99");
    });

    it("returns empty string when sendText fails", async () => {
      const sendTextSpy = vi.spyOn(transport, "sendText").mockResolvedValue("");
      const result = await transport.sendMarkdown("conv-1", "test");
      expect(sendTextSpy).toHaveBeenCalledWith("conv-1", "test");
      expect(result).toBe("");
    });

    it("passes through the exact markdown content without transformation", async () => {
      const sendTextSpy = vi.spyOn(transport, "sendText").mockResolvedValue("id");
      const md = "- item 1\n- item 2\n\n```code```";
      await transport.sendMarkdown("conv-1", md);
      expect(sendTextSpy).toHaveBeenCalledWith("conv-1", md);
    });
  });
});
