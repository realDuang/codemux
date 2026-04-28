import { describe, expect, it } from "vitest";
import { buildPortPlan } from "../../../scripts/dev-isolated";

describe("dev-isolated script", () => {
  it("builds an offset port plan", () => {
    const plan = buildPortPlan(200, {});

    expect(plan).toEqual({
      portOffset: 200,
      ports: {
        web: 8433,
        webStandalone: 8434,
        gateway: 4400,
        opencode: 4296,
        authApi: 4297,
        webhook: 4298,
      },
    });
  });

  it("keeps explicit port overrides in the plan", () => {
    const plan = buildPortPlan(200, {
      CODEMUX_WEB_PORT: "9100",
      CODEMUX_OPENCODE_PORT: "9101",
    });

    expect(plan.ports.web).toBe(9100);
    expect(plan.ports.opencode).toBe(9101);
    expect(plan.ports.gateway).toBe(4400);
  });
});
