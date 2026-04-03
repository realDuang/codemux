import { describe, expect, it, vi } from "vitest";

import { GatewayClient } from "../../../../src/lib/gateway-client";
import { GatewayRequestType } from "../../../../src/types/unified";

describe("GatewayClient", () => {
  it("uses a short timeout for reasoning effort sync", async () => {
    const client = new GatewayClient();
    const requestSpy = vi.spyOn(client, "request").mockResolvedValue(undefined);

    await client.setReasoningEffort({ sessionId: "session-1", effort: "high" });

    expect(requestSpy).toHaveBeenCalledWith(
      GatewayRequestType.REASONING_EFFORT_SET,
      { sessionId: "session-1", effort: "high" },
      3000,
    );
  });
});
